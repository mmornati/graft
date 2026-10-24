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
import { claimOpenSlot, insertMcpChange, settleOpenClaim } from "../store.js";
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

/** Graft's own bot login (`<slug>[bot]`, lowercased), or null when the slug is not configured. */
function graftBotLogin(ctx: ToolContext): string | null {
  const slug = ctx.config.githubAppSlug;
  return slug ? `${slug}[bot]`.toLowerCase() : null;
}

interface FoundPull {
  number: number;
  headSha: string;
  /** Authored by Graft's own App (never any other bot), as far as Graft can tell. */
  byGraft: boolean;
}

/** The open PR from `head` into `base` of this repository, if any (D17: retries are safe). */
async function findOpenPull(
  octokit: GitHubClient,
  o: { owner: string; repo: string; head: string; base: string; botLogin: string | null },
): Promise<FoundPull | null> {
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
    if (!hit) return null;
    const login = hit.user?.login;
    const byGraft =
      o.botLogin !== null &&
      hit.user?.type === "Bot" &&
      typeof login === "string" &&
      login.toLowerCase() === o.botLogin;
    return { number: hit.number, headSha: hit.head.sha, byGraft };
  } catch (err) {
    throw githubError(err);
  }
}

/**
 * An open PR found by head is returned, not created. When Graft's own App authored it, it may be
 * one Graft opened whose `mcp_changes` row was lost (a crash after `pulls.create`): record it, so
 * D19 still excludes its commit authors. A person's or another bot's PR (Dependabot, Renovate) is
 * never marked: marking it would let a token holder switch its approvals off, show it as opened
 * through MCP and fill the hourly cap. Without `GITHUB_APP_SLUG` nothing is adopted.
 */
async function adopt(ctx: ToolContext, found: FoundPull): Promise<void> {
  if (!found.byGraft) return;
  await insertMcpChange(ctx.db, {
    repositoryId: ctx.principal.repositoryId,
    tokenId: ctx.principal.tokenId,
    prNumber: found.number,
    headSha: found.headSha,
  });
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
  const botLogin = graftBotLogin(ctx);
  const found = await findOpenPull(reader, { owner, repo, head, base, botLogin });
  if (found) {
    await adopt(ctx, found);
    return {
      prNumber: found.number,
      url: url(found.number),
      headSha: found.headSha,
      existing: true,
      warnings,
    };
  }
  // D9 (c): a slot claimed under the repository lock, so concurrent calls cannot pass the cap.
  const claimId = await claimOpenSlot(db, {
    repositoryId: principal.repositoryId,
    tokenId: principal.tokenId,
    perHour: ctx.config.mcpOpenChangePerHour,
  });
  if (claimId === null) throw new ToolError("rate_limited");
  const settle = (pr: { number: number; headSha: string } | null) =>
    settleOpenClaim(db, {
      claimId,
      repositoryId: principal.repositoryId,
      tokenId: principal.tokenId,
      pr,
    });

  // The write: the only `mcp` client of the codebase, and only `pulls.create`.
  let created: { number: number; headSha: string };
  try {
    let writer: GitHubClient;
    try {
      writer = await ctx.github.forInstallation(principal.installationId, { feature: "mcp" });
    } catch (err) {
      throw githubError(err);
    }
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
    // Nothing was opened: the slot is given back before anything else.
    await settle(null);
    if (err instanceof ToolError) throw err;
    if (err instanceof MutationRefusedError) {
      if (err.refusal === "mode_off") throw new ToolError("mcp_write_off", "mode_changed");
      throw new ToolError("internal");
    }
    if (githubStatus(err) === 422) {
      // "A pull request already exists" (a concurrent call, or a lost answer): adopt it.
      const adopted = await findOpenPull(reader, { owner, repo, head, base, botLogin });
      if (adopted) {
        await adopt(ctx, adopted);
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
  await settle(created);
  return {
    prNumber: created.number,
    url: url(created.number),
    headSha: created.headSha,
    existing: false,
    warnings,
  };
}
