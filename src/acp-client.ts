/**
 * ACP (Agent Client Protocol) Bridge Engine
 * Handles JSON-RPC 2.0 connection to the ACP Agent runner (GitHub Copilot ACP server).
 * Strictly enforces Read-Only execution, zero bash terminal execution, and zero file modification.
 * Features full streaming aggregation for session/update notifications and session/prompt.
 */

import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { ReadOnlyMcpServer } from './mcp-tools';
import { ProtocolLogger } from './logger';
import { sanitizeText } from './sanitizer';

export interface AcpSessionConfig {
  workspacePath: string;
  agentCommand: string;
  agentArgs?: string[];
  mcpServer: ReadOnlyMcpServer;
}

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class AcpClientBridge {
  private process: ChildProcess | null = null;
  private messageIdCounter = 1;
  private pendingRequests = new Map<number | string, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }>();
  private mcpServer: ReadOnlyMcpServer;
  private activeSessionTextBuffer: string = '';
  private decoder = new StringDecoder('utf8');

  constructor(private config: AcpSessionConfig) {
    this.mcpServer = config.mcpServer;
  }

  public async start(): Promise<void> {
    const cmd = this.config.agentCommand;
    const args = this.config.agentArgs || [];

    console.log(`[ACP Process] Launching: ${cmd} ${args.join(' ')}`);

    this.process = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, CI: 'true', READ_ONLY_MODE: 'true' }
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to attach stdio streams to ACP Agent process.');
    }

    let buffer = '';
    this.process.stdout.on('data', (chunk: Buffer) => {
      buffer += this.decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.handleIncomingMessage(trimmed);
        }
      }
    });

    this.process.on('error', (err) => {
      console.error(`[ACP Process Error] Failed to launch agent: ${err.message}`);
      this._rejectAllPending(`ACP agent process error: ${err.message}`);
    });

    this.process.on('close', (code, signal) => {
      if (this.pendingRequests.size > 0) {
        const reason = `ACP agent process exited unexpectedly (code=${code}, signal=${signal}). ` +
          `Ensure the agent command is installed and accessible on PATH in the runner.`;
        console.error(`[ACP Process Error] ${reason}`);
        this._rejectAllPending(reason);
      }
    });
  }

  private _rejectAllPending(reason: string): void {
    for (const [id, handler] of this.pendingRequests) {
      clearTimeout(handler.timer);
      this.pendingRequests.delete(id);
      handler.reject(new Error(reason));
    }
  }

  private handleIncomingMessage(rawJson: string): void {
    try {
      const msg: JsonRpcMessage = JSON.parse(rawJson);

      // Response to a request we sent
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        ProtocolLogger.acpInboundResponse(msg.id, msg.result, msg.error);
        const handler = this.pendingRequests.get(msg.id);
        if (handler) {
          clearTimeout(handler.timer);
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message));
          } else {
            handler.resolve(msg.result);
          }
        }
        return;
      }

      // Notification or Request from Agent to Client
      if (msg.method) {
        ProtocolLogger.acpInboundRequest(msg.method, msg.id, msg.params);

        // Handle streaming response updates from the agent
        if (msg.method === 'session/update' || msg.method === 'notifications/message') {
          const params = msg.params as any;
          const update = params?.update;

          let chunkText = '';
          // Copilot ACP: agent_message_chunk delivers text at update.content.text
          if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.text) {
            chunkText = update.content.text;
          // Legacy / alternative agents: text at params.update.agent_message_chunk.text
          } else if (update?.agent_message_chunk?.text) {
            chunkText = update.agent_message_chunk.text;
          // Flat text on params
          } else if (params?.text) {
            chunkText = params.text;
          // Flat content on params
          } else if (params?.content) {
            chunkText = typeof params.content === 'string'
              ? params.content
              : JSON.stringify(params.content);
          }

          if (chunkText) {
            this.activeSessionTextBuffer += chunkText;
          }
          return;
        }

        this.handleAgentRequest(msg);
      }
    } catch {
      // Ignore unparseable non-JSON-RPC lines
    }
  }

  public getStreamedText(): string {
    return sanitizeText(this.activeSessionTextBuffer);
  }

  public clearStreamedText(): void {
    this.activeSessionTextBuffer = '';
  }

  private async handleAgentRequest(req: JsonRpcMessage): Promise<void> {
    const method = req.method;
    const reqId = req.id;

    // Security Gate 1: Deny any bash / shell command execution requests
    if (
      method === 'client/requestPermission' ||
      method === 'client/runCommand' ||
      method === 'terminal/execute' ||
      method === 'session/request_permission'
    ) {
      const reason = 'Terminal execution is strictly disabled in CI/CD analysis mode.';
      ProtocolLogger.acpSecurityBlocked(method || 'unknown', reason);

      if (reqId !== undefined) {
        this.sendResponse({
          jsonrpc: '2.0',
          id: reqId,
          result: { granted: false, reason }
        });
      }
      return;
    }

    // Security Gate 2: Deny any file write / code modifications
    if (
      method === 'client/applyEdit' ||
      method === 'workspace/applyEdit' ||
      method === 'fs/write' ||
      method === 'session/apply_edit'
    ) {
      const reason = 'File modification is disabled in Read-Only analysis mode.';
      ProtocolLogger.acpSecurityBlocked(method || 'unknown', reason);

      if (reqId !== undefined) {
        this.sendResponse({
          jsonrpc: '2.0',
          id: reqId,
          result: { success: false, reason }
        });
      }
      return;
    }

    // Tools discovery — agent calls this to learn what MCP tools are available
    if (
      method === 'tools/list' ||
      method === 'mcp/listTools' ||
      method === 'session/list_tools' ||
      method === 'mcp/list_tools'
    ) {
      if (reqId !== undefined) {
        this.sendResponse({
          jsonrpc: '2.0',
          id: reqId,
          result: { tools: this.mcpServer.listTools() }
        });
      }
      return;
    }

    // MCP Read-Only Tool Execution Dispatcher
    if (
      method === 'mcp/callTool' ||
      method === 'tools/call' ||
      method === 'session/call_tool' ||
      method === 'mcp/call_tool' ||
      method === 'agent/callTool'
    ) {
      const toolName = (req.params as any)?.name || (req.params as any)?.toolName;
      const toolArgs = (req.params as any)?.arguments || (req.params as any)?.args || {};

      try {
        const resultString = await this.mcpServer.executeTool(toolName, toolArgs);
        if (reqId !== undefined) {
          this.sendResponse({
            jsonrpc: '2.0',
            id: reqId,
            result: { content: [{ type: 'text', text: sanitizeText(resultString) }] }
          });
        }
      } catch (err: unknown) {
        const error = err as Error;
        if (reqId !== undefined) {
          this.sendResponse({
            jsonrpc: '2.0',
            id: reqId,
            error: { code: -32603, message: error.message }
          });
        }
      }
      return;
    }
  }

  public sendRequest<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.messageIdCounter++;
    const message: JsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    ProtocolLogger.acpOutbound(method, id, params);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`ACP Request "${method}" timed out after 60s.`));
        }
      }, 60000);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.sendMessage(message);
    });
  }

  private sendMessage(msg: JsonRpcMessage): void {
    if (this.process && this.process.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  private sendResponse(res: JsonRpcMessage): void {
    this.sendMessage(res);
  }

  public stop(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
        // Fallback kill after 2s if process hasn't terminated
        const proc = this.process;
        setTimeout(() => {
          try {
            if (proc && !proc.killed) {
              proc.kill('SIGKILL');
            }
          } catch {
            // Process already exited
          }
        }, 2000);
      } catch {
        // Ignored
      }
      this.process = null;
    }
  }
}
