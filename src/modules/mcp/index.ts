/**
 * The MCP module (Phase 1 step 6). Its HTTP routes, mounted by `buildServer` when `GRAFT_MCP=on`,
 * and the helpers of `pnpm graft mcp-token`. No webhook handlers and no jobs.
 */
export {
  DEFAULT_EXPIRY_DAYS,
  issueToken,
  MAX_EXPIRY_DAYS,
  MCP_OFF_NOTE,
  renderTokenList,
  repositoryTokens,
  revokeToken,
  tokenListJson,
  tokenShowLine,
  validRevokeReason,
  validTokenName,
} from "./cli.js";
export { MCP_BODY_LIMIT, MCP_PATH, mcpRoutes } from "./http.js";
export { SERVER_INFO, TOOL_NAMES } from "./server.js";
export { isMcpChange } from "./store.js";
