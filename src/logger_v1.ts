/**
 * Structured Logger for ACP (Agent Client Protocol) and MCP (Model Context Protocol)
 * Provides detailed timestamps, message direction markers, and security gate audit traces.
 * All output is sanitized and tee'd to acp-debug.log for post-run inspection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sanitizeText } from './sanitizer';

// Store log file in RUNNER_TEMP if in GitHub Actions, or fallback to current directory
const LOG_DIR = process.env.RUNNER_TEMP || process.cwd();
const LOG_FILE = path.join(LOG_DIR, 'acp-debug.log');

try {
  // Truncate the log file at process start so each run gets a clean file
  fs.writeFileSync(LOG_FILE, `=== Pipeline Assistant Debug Log ===\nStarted: ${new Date().toISOString()}\n\n`, 'utf8');
} catch {
  // Non-fatal fallback if filesystem is read-only
}

function writeToFile(line: string): void {
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Non-fatal — never crash the main flow due to logging
  }
}

function log(msg: string): void {
  const sanitized = sanitizeText(msg);
  console.log(sanitized);
  writeToFile(sanitized);
}

function warn(msg: string): void {
  const sanitized = sanitizeText(msg);
  console.warn(sanitized);
  writeToFile(sanitized);
}

function error(msg: string): void {
  const sanitized = sanitizeText(msg);
  console.error(sanitized);
  writeToFile(sanitized);
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

