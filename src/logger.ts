/**
 * Structured Logger for ACP (Agent Client Protocol) and MCP (Model Context Protocol)
 * Provides detailed timestamps, message direction markers, and security gate audit traces.
 */

export class ProtocolLogger {
  private static formatTime(): string {
    return new Date().toISOString();
  }

  // --- ACP PROTOCOL LOGS ---

  public static acpOutbound(method: string, id?: number | string, params?: unknown): void {
    console.log(`\n[${this.formatTime()}] 🚀 [ACP OUTBOUND REQUEST] (Client -> Agent)`);
    console.log(`  ├─ Method: ${method}`);
    console.log(`  ├─ ID: ${id !== undefined ? id : 'notification'}`);
    console.log(`  └─ Params: ${JSON.stringify(params, null, 2)}`);
  }

  public static acpInboundResponse(id: number | string, result?: unknown, error?: unknown): void {
    console.log(`\n[${this.formatTime()}] 📥 [ACP INBOUND RESPONSE] (Agent -> Client)`);
    console.log(`  ├─ ID: ${id}`);
    if (error) {
      console.log(`  └─ ❌ Error: ${JSON.stringify(error, null, 2)}`);
    } else {
      console.log(`  └─ ✅ Result: ${JSON.stringify(result, null, 2)}`);
    }
  }

  public static acpInboundRequest(method: string, id?: number | string, params?: unknown): void {
    console.log(`\n[${this.formatTime()}] 📥 [ACP INBOUND REQUEST] (Agent -> Client)`);
    console.log(`  ├─ Method: ${method}`);
    console.log(`  ├─ ID: ${id !== undefined ? id : 'notification'}`);
    console.log(`  └─ Params: ${JSON.stringify(params, null, 2)}`);
  }

  public static acpSecurityBlocked(method: string, reason: string): void {
    console.warn(`\n[${this.formatTime()}] 🛡️ [ACP SECURITY GATE: BLOCKED]`);
    console.warn(`  ├─ Blocked Method: ${method}`);
    console.warn(`  └─ Enforcement Reason: ${reason}`);
  }

  // --- MCP READ-ONLY TOOL LOGS ---

  public static mcpToolInvoked(toolName: string, args: unknown): void {
    console.log(`\n[${this.formatTime()}] 🔧 [MCP TOOL INVOKED]`);
    console.log(`  ├─ Tool Name: ${toolName}`);
    console.log(`  └─ Arguments: ${JSON.stringify(args, null, 2)}`);
  }

  public static mcpToolResult(toolName: string, summary: string, payloadSize: number): void {
    console.log(`\n[${this.formatTime()}] 📦 [MCP TOOL RESULT]`);
    console.log(`  ├─ Tool Name: ${toolName}`);
    console.log(`  ├─ Summary: ${summary}`);
    console.log(`  └─ Payload Size: ${payloadSize} bytes`);
  }

  public static mcpToolError(toolName: string, error: string): void {
    console.error(`\n[${this.formatTime()}] ❌ [MCP TOOL ERROR]`);
    console.error(`  ├─ Tool Name: ${toolName}`);
    console.error(`  └─ Error: ${error}`);
  }
}
