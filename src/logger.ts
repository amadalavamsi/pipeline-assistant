/**
 * Structured Logger for ACP (Agent Client Protocol) and MCP (Model Context Protocol)
 * Provides detailed timestamps, message direction markers, and security gate audit traces.
 * All output is tee'd to acp-debug.log in the working directory for post-run inspection.
 */

import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.join(process.cwd(), 'acp-debug.log');

// Truncate the log file at process start so each run gets a clean file
fs.writeFileSync(LOG_FILE, `=== Pipeline Assistant Debug Log ===\nStarted: ${new Date().toISOString()}\n\n`, 'utf8');

function writeToFile(line: string): void {
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Non-fatal — never crash the main flow due to logging
  }
}

function log(msg: string): void {
  console.log(msg);
  writeToFile(msg);
}

function warn(msg: string): void {
  console.warn(msg);
  writeToFile(msg);
}

function error(msg: string): void {
  console.error(msg);
  writeToFile(msg);
}

export class ProtocolLogger {
  private static formatTime(): string {
    return new Date().toISOString();
  }

  public static getLogFilePath(): string {
    return LOG_FILE;
  }

  // --- ACP PROTOCOL LOGS ---

  public static acpOutbound(method: string, id?: number | string, params?: unknown): void {
    log(`\n[${this.formatTime()}] 🚀 [ACP OUTBOUND REQUEST] (Client -> Agent)`);
    log(`  ├─ Method: ${method}`);
    log(`  ├─ ID: ${id !== undefined ? id : 'notification'}`);
    log(`  └─ Params: ${JSON.stringify(params, null, 2)}`);
  }

  public static acpInboundResponse(id: number | string, result?: unknown, error?: unknown): void {
    log(`\n[${this.formatTime()}] 📥 [ACP INBOUND RESPONSE] (Agent -> Client)`);
    log(`  ├─ ID: ${id}`);
    if (error) {
      log(`  └─ ❌ Error: ${JSON.stringify(error, null, 2)}`);
    } else {
      log(`  └─ ✅ Result: ${JSON.stringify(result, null, 2)}`);
    }
  }

  public static acpInboundRequest(method: string, id?: number | string, params?: unknown): void {
    log(`\n[${this.formatTime()}] 📥 [ACP INBOUND REQUEST] (Agent -> Client)`);
    log(`  ├─ Method: ${method}`);
    log(`  ├─ ID: ${id !== undefined ? id : 'notification'}`);
    log(`  └─ Params: ${JSON.stringify(params, null, 2)}`);
  }

  public static acpSecurityBlocked(method: string, reason: string): void {
    warn(`\n[${this.formatTime()}] 🛡️ [ACP SECURITY GATE: BLOCKED]`);
    warn(`  ├─ Blocked Method: ${method}`);
    warn(`  └─ Enforcement Reason: ${reason}`);
  }

  // --- MCP READ-ONLY TOOL LOGS ---

  public static mcpToolInvoked(toolName: string, args: unknown): void {
    log(`\n[${this.formatTime()}] 🔧 [MCP TOOL INVOKED]`);
    log(`  ├─ Tool Name: ${toolName}`);
    log(`  └─ Arguments: ${JSON.stringify(args, null, 2)}`);
  }

  public static mcpToolResult(toolName: string, summary: string, payloadSize: number): void {
    log(`\n[${this.formatTime()}] 📦 [MCP TOOL RESULT]`);
    log(`  ├─ Tool Name: ${toolName}`);
    log(`  ├─ Summary: ${summary}`);
    log(`  └─ Payload Size: ${payloadSize} bytes`);
  }

  public static mcpToolError(toolName: string, errorMsg: string): void {
    error(`\n[${this.formatTime()}] ❌ [MCP TOOL ERROR]`);
    error(`  ├─ Tool Name: ${toolName}`);
    error(`  └─ Error: ${errorMsg}`);
  }
}
