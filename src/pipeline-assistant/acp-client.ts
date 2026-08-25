/**
 * ACP (Agent Client Protocol) Bridge Engine.
 *
 * The bridge is deliberately read-only for CI failure analysis. It also keeps
 * the agent process on a least-privilege environment instead of inheriting all
 * CI secrets from the parent process.
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
  private pendingRequests = new Map<number | string, {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timer: NodeJS.Timeout;
  }>();
  private mcpServer: ReadOnlyMcpServer;
  private activeSessionTextBuffer = '';
  private decoder = new StringDecoder('utf8');
  private stopping = false;

  constructor(private config: AcpSessionConfig) {
    this.mcpServer = config.mcpServer;
  }

  public async start(): Promise<void> {
    if (this.process) throw new Error('ACP agent process is already running.');

    const cmd = this.config.agentCommand;
    const args = this.config.agentArgs || [];
    console.log(`[ACP Process] Launching: ${sanitizeText(cmd)} ${sanitizeText(args.join(' '))}`);

    // Do not blindly pass every CI secret to the agent process. Copilot may
    // need GitHub auth, but unrelated cloud/database/package credentials are
    // not required for read-only analysis.
    const parentEnv = process.env;
    const env: NodeJS.ProcessEnv = {
      PATH: parentEnv.PATH,
      HOME: parentEnv.HOME,
      TMPDIR: parentEnv.TMPDIR,
      TEMP: parentEnv.TEMP,
      TMP: parentEnv.TMP,
      LANG: parentEnv.LANG,
      LC_ALL: parentEnv.LC_ALL,
      CI: 'true',
      READ_ONLY_MODE: 'true'
    };

    for (const key of [
      'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN',
      'GITHUB_API_URL', 'GITHUB_SERVER_URL', 'GITHUB_REPOSITORY'
    ]) {
      if (parentEnv[key]) env[key] = parentEnv[key];
    }

    this.stopping = false;
    this.process = spawn(cmd, args, {
      cwd: this.config.workspacePath,
      stdio: ['pipe', 'pipe', 'inherit'],
      env
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to attach stdio streams to ACP Agent process.');
    }

    let buffer = '';
    this.process.stdout.on('data', (chunk: Buffer) => {
      buffer += this.decoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.handleIncomingMessage(trimmed);
      }
    });

    this.process.on('error', (err) => {
      console.error(`[ACP Process Error] Failed to launch agent: ${err.message}`);
      this._rejectAllPending(`ACP agent process error: ${err.message}`);
    });

    this.process.on('close', (code, signal) => {
      if (buffer.trim()) this.handleIncomingMessage(buffer.trim());
      if (!this.stopping && this.pendingRequests.size > 0) {
        const reason = `ACP agent process exited unexpectedly (code=${code}, signal=${signal}). ` +
          'Ensure the agent command is installed and accessible on PATH in the runner.';
        console.error(`[ACP Process Error] ${reason}`);
        this._rejectAllPending(reason);
      }
      this.process = null;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      ProtocolLogger.acpProtocolWarning(`Ignoring non-JSON stdout line (${rawJson.length} chars).`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || (parsed as any).jsonrpc !== '2.0') {
      ProtocolLogger.acpProtocolWarning('Ignoring malformed JSON-RPC message without jsonrpc=2.0.');
      return;
    }

    const msg = parsed as JsonRpcMessage;

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      ProtocolLogger.acpInboundResponse(msg.id, msg.result, msg.error);
      const handler = this.pendingRequests.get(msg.id);
      if (handler) {
        clearTimeout(handler.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) handler.reject(new Error(msg.error.message));
        else handler.resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      ProtocolLogger.acpInboundRequest(msg.method, msg.id, msg.params);

      if (msg.method === 'session/update' || msg.method === 'notifications/message') {
        const params = msg.params as any;
        const update = params?.update;
        let chunkText = '';

        if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.text) {
          chunkText = update.content.text;
        } else if (update?.agent_message_chunk?.text) {
          chunkText = update.agent_message_chunk.text;
        } else if (params?.text) {
          chunkText = params.text;
        } else if (params?.content) {
          chunkText = typeof params.content === 'string' ? params.content : JSON.stringify(params.content);
        }

        if (chunkText) this.activeSessionTextBuffer += chunkText;
        return;
      }

      void this.handleAgentRequest(msg);
    }
  }

  public getStreamedText(): string {
    return sanitizeText(this.activeSessionTextBuffer);
  }

  public clearStreamedText(): void {
    this.activeSessionTextBuffer = '';
  }

  private async handleAgentRequest(req: JsonRpcMessage): Promise<void> {
    const method = req.method || '';
    const reqId = req.id;

    if (
      method === 'client/requestPermission' ||
      method === 'client/runCommand' ||
      method === 'terminal/execute' ||
      method === 'session/request_permission'
    ) {
      const reason = 'Terminal execution is strictly disabled in CI/CD analysis mode.';
      ProtocolLogger.acpSecurityBlocked(method, reason);
      if (reqId !== undefined) {
        this.sendResponse({ jsonrpc: '2.0', id: reqId, error: { code: -32001, message: reason } });
      }
      return;
    }

    if (
      method === 'client/applyEdit' ||
      method === 'workspace/applyEdit' ||
      method === 'fs/write' ||
      method === 'session/apply_edit'
    ) {
      const reason = 'File modification is disabled in Read-Only analysis mode.';
      ProtocolLogger.acpSecurityBlocked(method, reason);
      if (reqId !== undefined) {
        this.sendResponse({ jsonrpc: '2.0', id: reqId, error: { code: -32002, message: reason } });
      }
      return;
    }

    if (method === 'tools/list' || method === 'mcp/listTools' || method === 'session/list_tools' || method === 'mcp/list_tools') {
      if (reqId !== undefined) {
        this.sendResponse({ jsonrpc: '2.0', id: reqId, result: { tools: this.mcpServer.listTools() } });
      }
      return;
    }

    if (method === 'mcp/callTool' || method === 'tools/call' || method === 'session/call_tool' || method === 'mcp/call_tool' || method === 'agent/callTool') {
      const toolName = (req.params as any)?.name || (req.params as any)?.toolName;
      const toolArgs = (req.params as any)?.arguments || (req.params as any)?.args || {};
      try {
        const resultString = await this.mcpServer.executeTool(toolName, toolArgs);
        if (reqId !== undefined) {
          this.sendResponse({
            jsonrpc: '2.0', id: reqId,
            result: { content: [{ type: 'text', text: sanitizeText(resultString) }] }
          });
        }
      } catch (err: unknown) {
        const error = err as Error;
        if (reqId !== undefined) {
          this.sendResponse({ jsonrpc: '2.0', id: reqId, error: { code: -32603, message: error.message } });
        }
      }
      return;
    }

    // A request we do not implement must not hang the agent.
    if (reqId !== undefined) {
      this.sendResponse({ jsonrpc: '2.0', id: reqId, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  public sendRequest<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
      return Promise.reject(new Error(`ACP agent is not running; cannot send ${method}.`));
    }

    const id = this.messageIdCounter++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
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
    if (this.process?.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  private sendResponse(res: JsonRpcMessage): void {
    this.sendMessage(res);
  }

  public async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) return;

    this.stopping = true;
    this._rejectAllPending('ACP agent stopped by client.');

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      proc.once('close', finish);
      try { proc.kill('SIGTERM'); } catch { finish(); return; }
      setTimeout(() => {
        if (!settled) {
          try { proc.kill('SIGKILL'); } catch { /* already exited */ }
          finish();
        }
      }, 2000);
    });

    if (this.process === proc) this.process = null;
  }
}
