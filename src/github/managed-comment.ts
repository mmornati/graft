/**
 * The single Graft-managed PR comment. This file IS the contract that steps 2, 3 and 5 share.
 *
 * 1. Shape. The body is the marker line, a blank line, `## Graft`, a blank line, then each
 *    section as `<!-- graft:section:<name>:start -->\n<markdown>\n<!-- graft:section:<name>:end -->`,
 *    separated by blank lines, then a blank line and a `<sub>` footer. Known sections appear in
 *    SECTION_ORDER. Unknown sections (`[a-z][a-z0-9-]*`) found in an existing body are kept
 *    verbatim after the known ones, in their original order.
 * 2. Ownership. Each module writes only its own section. `upsertManagedSection` replaces or
 *    inserts that one section and keeps every other section byte-for-byte.
 * 3. Finding the comment. (a) `knownCommentId`, if the comment still exists, starts with the
 *    marker and is ours. (b) Otherwise the first of the issue's comments (100 per page, at most
 *    10 pages) that starts with the marker and is ours. (c) Otherwise a new comment is created.
 *    "Ours" means `performed_via_github_app.id === appId` or, as a fallback for installations
 *    where that field is absent from the REST response, the author is the App's bot login
 *    (`<slug>[bot]`, type Bot). A human pasting the marker is therefore never adopted.
 * 4. Update. If the re-rendered body equals the current body nothing is sent ("unchanged").
 * 5. Safety. A section containing `<!-- graft:` or longer than MAX_SECTION_CHARS is rejected
 *    before any request; the rendered body must be at most 65,536 characters.
 * 6. Locking. Callers must hold `withChangeLock` for the change, and store the returned comment
 *    ID in `changes.graft_comment_id` inside that same lock transaction. The lock is a
 *    transaction that holds a pooled connection while comment and check requests are in flight:
 *    do no slow work (LLM calls, diff fetches) inside `withChangeLock`; compute first, then lock,
 *    re-check freshness (head and `pr_updated_at`) and publish.
 *    Deterministic failures (marker, size) throw `PermanentJobError` with reason `invalid_output`.
 */

import { PermanentJobError } from "../queue/errors.js";
import type { GitHubClient } from "./client-factory.js";
import { classifyGitHubError } from "./errors.js";

export const MANAGED_COMMENT_MARKER = "<!-- graft:managed-comment v1 -->";
export const SECTION_ORDER = ["intent", "provenance", "policy"] as const;
export type SectionName = (typeof SECTION_ORDER)[number];
export const MAX_SECTION_CHARS = 20_000;
export const MAX_COMMENT_CHARS = 65_536;
const FOOTER = "<sub>Maintained by Graft; edits to this comment are overwritten.</sub>";
const SECTION_NAME = /^[a-z][a-z0-9-]*$/;
const MAX_LIST_PAGES = 10;

const start = (name: string) => `<!-- graft:section:${name}:start -->`;
const end = (name: string) => `<!-- graft:section:${name}:end -->`;

export function renderManagedComment(sections: ReadonlyMap<string, string>): string {
  const known: string[] = SECTION_ORDER.filter((n) => sections.has(n));
  const unknown = [...sections.keys()].filter(
    (n) => !(SECTION_ORDER as readonly string[]).includes(n),
  );
  const parts: string[] = [];
  for (const name of [...known, ...unknown]) {
    if (!SECTION_NAME.test(name)) throw new Error(`invalid section name: ${name}`);
    parts.push(`${start(name)}\n${sections.get(name)}\n${end(name)}`);
  }
  return [
    MANAGED_COMMENT_MARKER,
    "",
    "## Graft",
    "",
    ...parts.flatMap((p) => [p, ""]),
    FOOTER,
  ].join("\n");
}

/** null when the marker is not the first line. */
export function parseManagedComment(body: string): Map<string, string> | null {
  const text = body.replace(/\r\n?/g, "\n");
  if (text.split("\n", 1)[0] !== MANAGED_COMMENT_MARKER) return null;
  const sections = new Map<string, string>();
  const re =
    /<!-- graft:section:([a-z][a-z0-9-]*):start -->\n([\s\S]*?)\n<!-- graft:section:\1:end -->/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] !== undefined && m[2] !== undefined && !sections.has(m[1])) sections.set(m[1], m[2]);
  }
  return sections;
}

interface CommentLike {
  id: number;
  body?: string | null | undefined;
  user?: { login: string; type?: string } | null | undefined;
  performed_via_github_app?: { id: number } | null | undefined;
}

export interface UpsertManagedSectionOptions {
  owner: string;
  repo: string;
  issueNumber: number;
  appId: number;
  /** `<slug>[bot]`: fallback ownership check when performed_via_github_app is absent. */
  appBotLogin?: string | undefined;
  knownCommentId: number | null;
  section: SectionName;
  markdown: string;
}

export function isOurComment(
  c: CommentLike,
  o: { appId: number; appBotLogin?: string | undefined },
): boolean {
  const body = (c.body ?? "").replace(/\r\n?/g, "\n");
  if (body.split("\n", 1)[0] !== MANAGED_COMMENT_MARKER) return false;
  if (c.performed_via_github_app?.id === o.appId) return true;
  return (
    o.appBotLogin !== undefined &&
    c.user?.type === "Bot" &&
    c.user.login.toLowerCase() === o.appBotLogin.toLowerCase()
  );
}

export async function upsertManagedSection(
  octokit: GitHubClient,
  o: UpsertManagedSectionOptions,
): Promise<{ commentId: number; action: "created" | "updated" | "unchanged" }> {
  // Deterministic failures: retrying cannot help, so they are permanent.
  if (o.markdown.includes("<!-- graft:"))
    throw new PermanentJobError("section markdown contains a graft marker", "invalid_output");
  if (o.markdown.length > MAX_SECTION_CHARS)
    throw new PermanentJobError("section markdown is too long", "invalid_output");
  const { owner, repo } = o;
  const ownership = { appId: o.appId, appBotLogin: o.appBotLogin };

  let existing: CommentLike | undefined;
  if (o.knownCommentId !== null) {
    try {
      const { data } = await octokit.rest.issues.getComment({
        owner,
        repo,
        comment_id: o.knownCommentId,
      });
      if (isOurComment(data, ownership)) existing = data;
    } catch (err) {
      if (classifyGitHubError(err) !== "not_found") throw err;
    }
  }
  if (!existing) {
    let pages = 0;
    const it = octokit.paginate.iterator(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: o.issueNumber,
      per_page: 100,
    });
    search: for await (const page of it) {
      for (const c of page.data) {
        if (isOurComment(c, ownership)) {
          existing = c;
          break search;
        }
      }
      if (++pages >= MAX_LIST_PAGES) break;
    }
  }

  const sections = existing ? (parseManagedComment(existing.body ?? "") ?? new Map()) : new Map();
  sections.set(o.section, o.markdown);
  const body = renderManagedComment(sections);
  if (body.length > MAX_COMMENT_CHARS)
    throw new PermanentJobError("managed comment would exceed 65,536 chars", "invalid_output");

  if (!existing) {
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: o.issueNumber,
      body,
    });
    return { commentId: data.id, action: "created" };
  }
  if (body === existing.body) return { commentId: existing.id, action: "unchanged" };
  await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  return { commentId: existing.id, action: "updated" };
}
