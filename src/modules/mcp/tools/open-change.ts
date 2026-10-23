/**
 * `open_change` (§7, D16–D18): open a PR from a branch the agent already pushed. The one MCP write
 * to GitHub, and the only place in the codebase that builds an `mcp` client.
 *
 * D16: the effective `mcp_write` is read first; when it is not `on` the tool returns before any
 * GitHub request of any kind, so report mode never creates an `mcp` client. The mutation guard's
 * gate reads the mode again at the write: a rollback in between is refused (`mode_changed`).
 */
import type { GitHubClient } from "../../../github/client-factory.js";
import { MutationRefusedError } from "../../../github/mutation-guard.js";
import {
  buildPrBody,
  type OpenChangeInput,
  type OpenChangeOutput,
  type ProvenanceKey,
  validBranchName,
} from "../../../mcp/schemas.js";
import { getEffectiveModes } from "../../modes/index.js";
import { type GraftField, normalizeField } from "../../provenance/index.js";
import { insertMcpChange, opensInLastHour } from "../store.js";
import {
  checkRepository,
  githubError,
  githubStatus,
  splitFullName,
  type ToolContext,
  ToolError,
} from "./common.js";
import { defaultBranch } from "./get-policy.js";
import { modeView } from "./get-status.js";

const FIELD_OF: Record<ProvenanceKey, GraftField> = {
  agent: "agent",
  model: "model",
  task: "task",
  sessionUrl: "session",
};

/** Whether a branch exists (`git.getRef heads/<name>`); a 404 is false, other errors throw. */
async function branchExists(
  octokit: GitHubClient,
  owner: string,
  repo: string,
  name: string,
): Promise<boolean> {
  try {
    await octokit.rest.git.getRef({ owner, repo, ref: `heads/${name}` });
    return true;
  } catch (err) {
    if (githubStatus(err) === 404) return false;
    throw githubError(err);
  }
}

/** The open PR from `head` into `base` of this repository, if any (D17: retries are safe). */
async function findOpenPull(
  octokit: GitHubClient,
  o: { owner: string; repo: string; head: string; base: string },
): Promise<{ number: number; headSha: string } | null> {
  try {
    const { data } = await octokit.rest.pulls.list({
      owner: o.owner,
      repo: o.repo,
      head: `${o.owner}:${o.head}`,
      base: o.base,
      state: "open",
      per_page: 10,
    });
    const hit = data.find((p) => p.head.ref === o.head && p.base.ref === o.base);
    return hit ? { number: hit.number, headSha: hit.head.sha } : null;
  } catch (err) {
    throw githubError(err);
  }
}

export async function openChange(
  ctx: ToolContext,
  input: OpenChangeInput,
): Promise<OpenChangeOutput> {
  checkRepository(ctx, input.repository);
  const { db, principal } = ctx;
  const { owner, repo } = splitFullName(principal.fullName);
  const url = (n: number) => `https://github.com/${principal.fullName}/pull/${n}`;

  // D16: the mode first. Nothing below runs, not even a GET, unless mcp_write is effectively on.
  const modes = await getEffectiveModes(db, principal.repositoryId, ctx.config);
  if (modes.mcpWrite.effective !== "on") {
    throw new ToolError("mcp_write_off", modeView(modes.mcpWrite).reason);
  }

  // D17: checks, all through the default client (GETs only).
  let reader: GitHubClient;
  try {
    reader = await ctx.github.forInstallation(principal.installationId);
  } catch (err) {
    throw githubError(err);
  }
  const defaultRef = await defaultBranch(reader, owner, repo);
  const head = input.head;
  if (!validBranchName(head) || head === defaultRef) throw new ToolError("invalid_head");
  if (!(await branchExists(reader, owner, repo, head))) throw new ToolError("head_not_found");
  const base = input.base ?? defaultRef;
  if (!validBranchName(base) || !(await branchExists(reader, owner, repo, base))) {
    throw new ToolError("base_not_found");
  }
  const { body, warnings } = buildPrBody(input.body, input.provenance, (key, raw) =>
    normalizeField(FIELD_OF[key], raw),
  );
  const found = await findOpenPull(reader, { owner, repo, head, base });
  if (found) {
    return {
      prNumber: found.number,
      url: url(found.number),
      headSha: found.headSha,
      existing: true,
      warnings,
    };
  }
  if ((await opensInLastHour(db, principal.repositoryId)) >= ctx.config.mcpOpenChangePerHour) {
    throw new ToolError("rate_limited");
  }

  // The write: the only `mcp` client of the codebase, and only `pulls.create`.
  let writer: GitHubClient;
  try {
    writer = await ctx.github.forInstallation(principal.installationId, { feature: "mcp" });
  } catch (err) {
    throw githubError(err);
  }
  let created: { number: number; headSha: string };
  try {
    const { data } = await writer.rest.pulls.create({
      owner,
      repo,
      title: input.title.trim(),
      body,
      head,
      base,
      draft: input.draft ?? false,
      maintainer_can_modify: false,
    });
    created = { number: data.number, headSha: data.head.sha };
  } catch (err) {
    if (err instanceof MutationRefusedError) {
      if (err.refusal === "mode_off") throw new ToolError("mcp_write_off", "mode_changed");
      throw new ToolError("internal");
    }
    if (githubStatus(err) === 422) {
      // "A pull request already exists" (a concurrent call, or a lost answer): adopt it.
      const adopted = await findOpenPull(reader, { owner, repo, head, base });
      if (adopted) {
        return {
          prNumber: adopted.number,
          url: url(adopted.number),
          headSha: adopted.headSha,
          existing: true,
          warnings,
        };
      }
    }
    throw githubError(err);
  }
  await insertMcpChange(db, {
    repositoryId: principal.repositoryId,
    tokenId: principal.tokenId,
    prNumber: created.number,
    headSha: created.headSha,
  });
  return {
    prNumber: created.number,
    url: url(created.number),
    headSha: created.headSha,
    existing: false,
    warnings,
  };
}
