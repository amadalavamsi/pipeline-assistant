/**
 * config.ts
 *
 * Single typed import point for all external configuration.
 * Every other module imports constants from HERE — never directly from JSON files.
 *
 * Config files live in: config/
 *   acp-capabilities.json  — ACP security & permission flags
 *   mcp-tools.json         — MCP tool registry (name / description / parameter schema)
 *   agent.json             — default job name, fallback text
 */

import acpCapabilitiesRaw from '../config/acp-capabilities.json';
import mcpToolsRaw from '../config/mcp-tools.json';
import agentConfigRaw from '../config/agent.json';
import { McpToolDefinition } from './mcp-tools';

// ---------------------------------------------------------------------------
// ACP Capabilities
// ---------------------------------------------------------------------------

export interface AcpCapabilities {
  readOnly: boolean;
  terminalExecution: boolean;
  fileModification: boolean;
  webSearch: boolean;
}

/**
 * Security & permission flags sent during the ACP `initialize` handshake.
 * To add/remove a permission, edit config/acp-capabilities.json only.
 * (_comment field is intentionally excluded from the exported type)
 */
export const ACP_CAPABILITIES: AcpCapabilities = {
  readOnly: acpCapabilitiesRaw.readOnly,
  terminalExecution: acpCapabilitiesRaw.terminalExecution,
  fileModification: acpCapabilitiesRaw.fileModification,
  webSearch: acpCapabilitiesRaw.webSearch
};


// ---------------------------------------------------------------------------
// MCP Tool Registry
// ---------------------------------------------------------------------------

/**
 * Declarative MCP tool definitions loaded from config/mcp-tools.json.
 * The tool implementation (GitHub API calls) lives in mcp-tools.ts.
 * To add a new tool: add an entry here AND a matching case in executeTool().
 */
export const MCP_TOOL_REGISTRY: McpToolDefinition[] = mcpToolsRaw as McpToolDefinition[];

// ---------------------------------------------------------------------------
// Agent Defaults
// ---------------------------------------------------------------------------

/** Default job name used when one cannot be determined from the workflow run. */
export const JOB_NAME = agentConfigRaw.jobName;

/** Fallback report text used when the ACP agent encounters an error or times out. */
export const FALLBACK = agentConfigRaw.fallback;

/** Bot comment marker used to find and update existing PR comments. */
export const BOT_COMMENT_SIGNATURE = '<!-- pipeline-assistant-report -->';
