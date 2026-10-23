/**
 * What every tool shares (D8, D20, D21): the context, the result shapes and the error class. A tool
 * throws `ToolError` with a fixed code; the server turns it into an `isError` result. Nothing here
 * builds a message from GitHub's answer or from the agent's arguments.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Config } from "../../../config/index.js";
import type { Clock } from "../../../core/clock.js";
import type { Logger } from "../../../core/logger.js";
import type { Db } from "../../../db/client.js";
import type { GitHubClientFactory } from "../../../github/client-factory.js";
import type { ToolErrorCode } from "../../../mcp/schemas.js";
import type { JobQueue } from "../../../queue/queue.js";
import type { McpPrincipal } from "../auth.js";

export interface ToolDeps {
  db: Db;
  config: Config;
  github: GitHubClientFactory;
  queue: JobQueue;
  clock: Clock;
  log: Logger;
}

export interface ToolContext extends ToolDeps {
  principal: McpPrincipal;
}

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    /** Fixed text chosen by Graft, never built from GitHub messages or tool arguments. */
    readonly detail?: string,
  ) {
    super(code);
    this.name = "ToolError";
  }
}

export function okResult<T extends Record<string, unknown>>(out: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
}

export function errorResult(code: ToolErrorCode, detail?: string): CallToolResult {
  const out = { error: code, ...(detail === undefined ? {} : { detail }) };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(out) }],
    structuredContent: out,
  };
}

/** D8: the `repository` argument must name the token's repository, whatever else exists. */
export function checkRepository(ctx: ToolContext, repository: string): void {
  if (repository.toLowerCase() !== ctx.principal.fullName.toLowerCase()) {
    throw new ToolError("forbidden_repository");
  }
}

export function splitFullName(fullName: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
}

/** The HTTP status of an Octokit error, if it has one. */
export function githubStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/** Any GitHub failure as `github_<status>` (`github_0` when there is no HTTP status). */
export function githubError(err: unknown): ToolError {
  return new ToolError(`github_${githubStatus(err) ?? 0}`);
}

export const isoOrNull = (d: Date | null | undefined): string | null =>
  d === null || d === undefined ? null : d.toISOString();
