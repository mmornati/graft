/**
 * The per-request `McpServer` (D2): a fresh instance for every HTTP request, with the four tools
 * and nothing else (no resources, prompts or notifications). The principal comes from the `AuthInfo`
 * the HTTP layer verified (D7); a request without one gets no tool that can run.
 *
 * D10: arguments and results are never logged. Each call logs one line, `mcp call`, with the tool,
 * the token id, the repository id, the outcome code and the duration.
 */
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  getPolicyInput,
  getPolicyOutput,
  getStatusInput,
  getStatusOutput,
  openChangeInput,
  openChangeOutput,
  reportProvenanceInput,
  reportProvenanceOutput,
} from "../../mcp/schemas.js";
import { redactTokens } from "../../mcp/tokens.js";
import { sanitizeError } from "../../queue/errors.js";
import type { McpPrincipal } from "./auth.js";
import {
  errorResult,
  okResult,
  type ToolContext,
  type ToolDeps,
  ToolError,
} from "./tools/common.js";
import { getPolicy } from "./tools/get-policy.js";
import { getStatus } from "./tools/get-status.js";
import { openChange } from "./tools/open-change.js";
import { reportProvenance } from "./tools/report-provenance.js";

export const SERVER_INFO = { name: "graft", version: "1.0.0" } as const;
export const TOOL_NAMES = ["get_status", "get_policy", "report_provenance", "open_change"] as const;

/** An error stripped to metadata, with any token-shaped text redacted (D10). */
export function safeMcpError(err: unknown): Error {
  const safe = sanitizeError(err);
  safe.message = redactTokens(safe.message);
  if (safe.stack !== undefined) safe.stack = redactTokens(safe.stack);
  return safe;
}

interface ToolSpec<I extends z.ZodType, O extends z.ZodType> {
  name: (typeof TOOL_NAMES)[number];
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (ctx: ToolContext, input: z.infer<I>) => Promise<z.infer<O>>;
}

function register<I extends z.ZodType, O extends z.ZodType>(
  server: McpServer,
  ctx: ToolContext,
  spec: ToolSpec<I, O>,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: spec.annotations,
    },
    (async (args: z.infer<I>): Promise<CallToolResult> => {
      const started = Date.now();
      let outcome = "ok";
      try {
        return okResult((await spec.run(ctx, args)) as Record<string, unknown>);
      } catch (err) {
        if (err instanceof ToolError) {
          outcome = err.code;
          return errorResult(err.code, err.detail);
        }
        outcome = "internal";
        ctx.log.error({ tool: spec.name, err: safeMcpError(err) }, "mcp tool failed");
        return errorResult("internal");
      } finally {
        ctx.log.info(
          {
            tool: spec.name,
            tokenId: ctx.principal.tokenId,
            repositoryId: ctx.principal.repositoryId,
            outcome,
            ms: Date.now() - started,
          },
          "mcp call",
        );
      }
    }) as never,
  );
}

export function createMcpServer(deps: ToolDeps, principal: McpPrincipal): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  const ctx: ToolContext = { ...deps, principal };
  register(server, ctx, {
    name: "get_status",
    title: "Graft status of a pull request",
    description:
      "What Graft knows about a pull request of this repository: the intent card, provenance, the policy verdict and what enforce mode would conclude, guard events, and the modes. Reads Graft's database only.",
    input: getStatusInput,
    output: getStatusOutput,
    annotations: { readOnlyHint: true },
    run: getStatus,
  });
  register(server, ctx, {
    name: "get_policy",
    title: "Graft policy of a branch",
    description:
      "The parsed graft.yaml of a branch (the default branch unless `base` is given), its hash and commit, and the repository's modes. Never the file text.",
    input: getPolicyInput,
    output: getPolicyOutput,
    annotations: { readOnlyHint: true },
    run: getPolicy,
  });
  register(server, ctx, {
    name: "report_provenance",
    title: "Report provenance for a PR head",
    description:
      "Report the agent, model, task and session behind the current head of a pull request. Stored as untrusted, once per head: a report that disagrees with the commit trailers makes the policy treat the author as unknown; it can never loosen a verdict.",
    input: reportProvenanceInput,
    output: reportProvenanceOutput,
    annotations: { readOnlyHint: true },
    run: reportProvenance,
  });
  register(server, ctx, {
    name: "open_change",
    title: "Open a pull request from a pushed branch",
    description:
      "Open a pull request in this repository from a branch you already pushed, with provenance trailers appended to the body. Only when the operator turned mcp_write on; an open PR for the same branch is returned instead of a new one.",
    input: openChangeInput,
    output: openChangeOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: openChange,
  });
  return server;
}
