/**
 * Structured Logger for ACP/MCP diagnostics.
 * Payload bodies are intentionally summarized to avoid dumping huge prompts,
 * repository contents, or sensitive tool arguments into runner logs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sanitizeText } from './sanitizer';

const LOG_DIR = process.env.RUNNER_TEMP || process.cwd();
const LOG_FILE = path.join(LOG_DIR, 'acp-debug.log');
const VERBOSE = process.env.ACP_DEBUG_VERBOSE === 'true';

try {
  fs.writeFileSync(LOG_FILE, `=== Pipeline Assistant Debug Log ===\nStarted: ${new Date().toISOString()}\nVerbose: ${VERBOSE}\n\n`, 'utf8');
} catch {
  // Non-fatal.
}

function writeToFile(line: string): void {
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch { /* non-fatal */ }
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

function summarizePayload(value: unknown): string {
  if (VERBOSE) return JSON.stringify(value, null, 2);
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `<string:${value.length} chars>`;
  if (Array.isArray(value)) return `<array:${value.length}>`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    return `<object keys=${keys.slice(0, 20).join(',')}${keys.length > 20 ? ',…' : ''}>`;
  }
  return String(value);
}

export class ProtocolLogger {
  private static formatTime(): string { return new Date().toISOString(); }
  public static getLogFilePath(): string { return LOG_FILE; }

  public static acpOutbound(method: string, id?: number | string, params?: unknown): void {
    log(`\n[${this.formatTime()}] 🚀 [ACP OUTBOUND REQUEST]`);
    log(`  ├─ Method: ${method}`);
    log(`  ├─ ID: ${id !== undefined ? id : 'notification'}`);
    log(`  └─ Params: ${summarizePayload(params)}`);
  }

  public static acpInboundResponse(id: number | string, result?: unknown, error?: unknown): void {
    log(`\n[${this.formatTime()}] 📥 [ACP INBOUND RESPONSE]`);
    log(`  ├─ ID: ${id}`);
    if (error) log(`  └─ ❌ Error: ${summarizePayload(error)}`);
    else log(`  └─ ✅ Result: ${summarizePayload(result)}`);
  }

  public static acpInboundRequest(method: string, id?: number | string, params?: unknown): void {
    log(`\n[${this.formatTime()}] 📥 [ACP INBOUND REQUEST]`);
    log(`  ├─ Method: ${method}`);
    log(`  ├─ ID: ${id !== undefined ? id : 'notification'}`);
    log(`  └─ Params: ${summarizePayload(params)}`);
  }

  public static acpProtocolWarning(message: string): void {
    warn(`[${this.formatTime()}] ⚠️ [ACP PROTOCOL] ${message}`);
  }

  public static acpSecurityBlocked(method: string, reason: string): void {
    warn(`\n[${this.formatTime()}] 🛡️ [ACP SECURITY GATE: BLOCKED]`);
    warn(`  ├─ Blocked Method: ${method}`);
    warn(`  └─ Enforcement Reason: ${reason}`);
  }

  public static mcpToolInvoked(toolName: string, args: unknown): void {
    log(`\n[${this.formatTime()}] 🔧 [MCP TOOL INVOKED]`);
    log(`  ├─ Tool Name: ${toolName}`);
    log(`  └─ Arguments: ${summarizePayload(args)}`);
  }

  public static mcpToolResult(toolName: string, summary: string, payloadSize: number): void {
    log(`\n[${this.formatTime()}] 📦 [MCP TOOL RESULT]`);
    log(`  ├─ Tool Name: ${toolName}`);
    log(`  ├─ Summary: ${summary}`);
    log(`  └─ Payload Size: ${payloadSize} bytes`);
  }

  public static mcpToolError(toolName: string, errorMsg: string): void {
    warn(`\n[${this.formatTime()}] ❌ [MCP TOOL ERROR]`);
    warn(`  ├─ Tool Name: ${toolName}`);
    warn(`  └─ Error: ${errorMsg}`);
  }
}
