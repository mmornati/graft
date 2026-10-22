/**
 * The guard comment (Phase 1 step 4, §8, D10, D11, D16): one new comment on the culprit PR per
 * `culprit_found` event, and the only GitHub write of this step. It goes through the default
 * installation client (`POST …/issues/{n}/comments` is a `phase0` route), never a feature client.
 *
 * The first line is a hidden marker with the event id. Before writing, the PR's comments are
 * listed (at most 10 pages) and an App-authored comment that starts with the marker is adopted
 * instead (the managed comment's rule 3), so a retried job never writes twice. The write and the
 * event update share one `withChangeLock` transaction on the culprit change.
 */
import type { JobContext } from "../../core/context.js";
import { withChangeLock } from "../../db/locks.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import { codeSpan } from "../../github/markdown.js";
import { PermanentJobError } from "../../queue/errors.js";
import { getChange } from "../changes/index.js";
import { getEffectiveModes } from "../modes/index.js";
import { childOf, getEvent, getEventForUpdate, resultsAt, updateEvent } from "./store.js";

export const MAX_GUARD_COMMENT_CHARS = 4_000;
const MAX_NAMES = 5;
const NAME_CHARS = 80;
const MAX_LIST_PAGES = 10;

export const guardMarker = (eventId: string): string => `<!-- graft:guard-event ${eventId} -->`;

export const REPORT_LINE = "Graft mode: report. Graft opens nothing; this is what it would do.";
export const ENFORCE_LINE =
  "Graft mode: enforce. Revert PRs are not available in this version; nothing was opened.";

export interface GuardCommentInput {
  eventId: string;
  branch: string;
  failingSha: string;
  lastGreenSha: string;
  /** The last green commit is the failing commit's first parent. */
  lastGreenIsParent: boolean;
  /** Failing checks in event order; `htmlUrl` already passed `safeHtmlUrl`. */
  checks: readonly { name: string; htmlUrl: string | null }[];
  /** null: confirmation is off, and the line is omitted. */
  confirmation:
    | { reason: "next_commit"; nextSha: string }
    | { reason: "window"; windowSeconds: number }
    | null;
  mode: "report" | "enforce";
}

const short = (sha: string): string => `\`${sha.slice(0, 7)}\``;

/** "2 hours", "1 hour", "90 minutes", "45 seconds". */
export function duration(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/** The GitHub web root that check and status links must start with. */
export function githubWebBase(apiUrl: string): string {
  const u = new URL(apiUrl);
  if (u.hostname === "api.github.com") return "https://github.com/";
  // GitHub Enterprise Server: https://host/api/v3 serves https://host/.
  return `${u.origin}/`;
}

/**
 * A link Graft may store and render: under the GitHub web root, plain characters only (no space,
 * parenthesis, angle bracket or `@`), at most 500 characters. Anything else is dropped (NULL).
 */
export function safeHtmlUrl(url: string | null | undefined, webBase: string): string | null {
  if (typeof url !== "string" || url.length > 500) return null;
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#[\]!$&'*+,;=%-]+$/.test(url) || /[@()]/.test(url)) return null;
  // A raw prefix check is not enough: `…/owner/repo/../../other` starts with the prefix but
  // resolves elsewhere. Refuse encoded dots, slashes and backslashes, and anything the URL parser
  // would rewrite (dot segments, case, default ports), then compare the PARSED origin and path.
  if (/%2e|%2f|%5c/i.test(url)) return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(webBase);
  } catch {
    return null;
  }
  if (parsed.href !== url) return null;
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) return null;
  return url;
}

export function renderGuardComment(i: GuardCommentInput): string {
  const first = i.checks[0]?.name ?? "unknown";
  const names = i.checks.slice(0, MAX_NAMES).map((c) => codeSpan(c.name, NAME_CHARS));
  const more = i.checks.length - MAX_NAMES;
  const link = i.checks.find((c) => c.htmlUrl !== null)?.htmlUrl ?? null;
  const failing = `- Failing: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}${
    link === null ? "" : ` ([details](${link}))`
  }`;
  const before = i.lastGreenIsParent
    ? `It was green at ${short(i.lastGreenSha)}, the commit before.`
    : `It was last green at ${short(i.lastGreenSha)}.`;
  const lines = [
    guardMarker(i.eventId),
    "### Graft guard",
    "",
    `CI check ${codeSpan(first, NAME_CHARS)} went red on ${codeSpan(i.branch, 100)} at ${short(i.failingSha)} after this pull request was merged. ${before}`,
    "",
    failing,
  ];
  if (i.confirmation !== null) {
    lines.push(
      i.confirmation.reason === "next_commit"
        ? `- Confirmed by: the next commit ${short(i.confirmation.nextSha)} is also red`
        : `- Confirmed by: still red after ${duration(i.confirmation.windowSeconds)}`,
    );
  }
  lines.push(
    "",
    "Graft would open a pull request reverting this merge. Fix forward or revert to clear it.",
    "",
    i.mode === "enforce" ? ENFORCE_LINE : REPORT_LINE,
  );
  const body = lines.join("\n");
  if (body.length > MAX_GUARD_COMMENT_CHARS) {
    throw new PermanentJobError("guard comment would exceed 4,000 characters", "invalid_output");
  }
  return body;
}

interface CommentLike {
  id: number;
  body?: string | null | undefined;
  user?: { login: string; type?: string } | null | undefined;
  performed_via_github_app?: { id: number } | null | undefined;
}

/** The managed comment's rule 3, for the guard marker: the marker is the first line, and ours. */
export function isOurGuardComment(
  c: CommentLike,
  eventId: string,
  o: { appId: number; appBotLogin?: string | undefined },
): boolean {
  const body = (c.body ?? "").replace(/\r\n?/g, "\n");
  if (body.split("\n", 1)[0] !== guardMarker(eventId)) return false;
  if (c.performed_via_github_app?.id === o.appId) return true;
  return (
    o.appBotLogin !== undefined &&
    c.user?.type === "Bot" &&
    c.user.login.toLowerCase() === o.appBotLogin.toLowerCase()
  );
}

export type PublishOutcome = "skipped" | "created" | "adopted" | "already";

/**
 * D10/D11: renders and writes the comment for one `culprit_found` event. Everything slow (modes,
 * results, rendering, the installation token) happens before the change lock; inside it the event
 * is re-read, the PR's comments are searched for the marker, and the comment id is stored.
 */
export async function publishGuardComment(
  eventId: string,
  ctx: JobContext,
  o: { octokit?: GitHubClient } = {},
): Promise<PublishOutcome> {
  const event = await getEvent(ctx.db, eventId);
  if (
    event?.status !== "culprit_found" ||
    event.comment_id !== null ||
    event.culprit_change_id === null
  ) {
    return "skipped";
  }
  const changeId = event.culprit_change_id;
  const change = await getChange(ctx.db, changeId);
  if (!change || change.repository_id !== event.repository_id) return "skipped";
  const repo = await ctx.db
    .selectFrom("repositories")
    .select(["installation_id", "full_name"])
    .where("id", "=", event.repository_id)
    .where("removed_at", "is", null)
    .executeTakeFirst();
  if (!repo) return "skipped";
  const [owner = "", name = ""] = repo.full_name.split("/");

  // D16: the mode is read when the comment is written, and stored on the event.
  const modes = await getEffectiveModes(ctx.db, event.repository_id, ctx.config);
  const mode = modes.guard.effective;
  const keys = event.failing_checks.map((c) => c.key);
  const results = new Map(
    (await resultsAt(ctx.db, event.repository_id, [event.failing_sha], keys)).map(
      (r) => [r.key, r] as const,
    ),
  );
  const failingCommit = await ctx.db
    .selectFrom("main_commits")
    .select("parent_sha")
    .where("repository_id", "=", event.repository_id)
    .where("sha", "=", event.failing_sha)
    .executeTakeFirst();
  const next = await childOf(ctx.db, event.repository_id, event.failing_sha);
  let confirmation: GuardCommentInput["confirmation"] = null;
  if (event.confirm_reason === "next_commit" && next) {
    confirmation = { reason: "next_commit", nextSha: next.sha };
  } else if (event.confirm_reason === "window") {
    confirmation = { reason: "window", windowSeconds: ctx.config.guardConfirmSeconds };
  }
  const body = renderGuardComment({
    eventId: event.id,
    branch: event.branch,
    failingSha: event.failing_sha,
    lastGreenSha: event.last_green_sha ?? event.failing_sha,
    lastGreenIsParent:
      event.last_green_sha !== null && failingCommit?.parent_sha === event.last_green_sha,
    checks: event.failing_checks.map((c) => ({
      name: c.name,
      htmlUrl: results.get(c.key)?.html_url ?? null,
    })),
    confirmation,
    mode,
  });

  let octokit: GitHubClient;
  try {
    // The default client: no feature, so no Phase 1 route is reachable from here.
    octokit = o.octokit ?? (await ctx.github.forInstallation(repo.installation_id));
  } catch (err) {
    throw toJobError(err, "installation token");
  }
  const ownership = {
    appId: ctx.config.githubAppId,
    appBotLogin: ctx.config.githubAppSlug ? `${ctx.config.githubAppSlug}[bot]` : undefined,
  };
  return withChangeLock(ctx.db, changeId, async (tx) => {
    const locked = await getEventForUpdate(tx, eventId);
    if (locked?.status !== "culprit_found") return "skipped";
    if (locked.comment_id !== null) return "already";
    let found: number | null = null;
    try {
      let pages = 0;
      const it = octokit.paginate.iterator(octokit.rest.issues.listComments, {
        owner,
        repo: name,
        issue_number: change.pr_number,
        per_page: 100,
      });
      search: for await (const page of it) {
        for (const c of page.data) {
          if (isOurGuardComment(c, eventId, ownership)) {
            found = c.id;
            break search;
          }
        }
        if (++pages >= MAX_LIST_PAGES) break;
      }
    } catch (err) {
      throw toJobError(err, "issues.listComments");
    }
    let commentId = found;
    if (commentId === null) {
      try {
        commentId = (
          await octokit.rest.issues.createComment({
            owner,
            repo: name,
            issue_number: change.pr_number,
            body,
          })
        ).data.id;
      } catch (err) {
        throw toJobError(err, "issues.createComment");
      }
    }
    await updateEvent(tx, eventId, { commentId, guardMode: mode }, ctx.clock.now());
    ctx.log.info(
      { eventId, prNumber: change.pr_number, adopted: found !== null },
      "guard comment published",
    );
    return found === null ? "created" : "adopted";
  });
}
