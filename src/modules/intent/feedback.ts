import { sql } from "kysely";
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import type { ChangeSignal } from "../../core/signals.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { classifyGitHubError, toJobError } from "../../github/errors.js";
import { defineJob } from "../../queue/job.js";
import { getChange } from "../changes/index.js";
import { getActiveInstallation } from "../installations/index.js";
import { INTENT_CHECK_NAME } from "./render.js";
import { getCard, publishedCards, replaceReactionFeedback, upsertFeedback } from "./store.js";

const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_REACTION_PAGES = 5;

// ---------------------------------------------------------------------------------------------
// attributeReactions (pure)
// ---------------------------------------------------------------------------------------------

export interface ReactionInput {
  userId: number;
  login: string;
  userType: string;
  content: string;
  createdAt: string;
}

export interface ReactionRow {
  card_id: string;
  user_id: number;
  user_login: string;
  verdict: "up" | "down";
  reacted_at: Date;
  is_pr_author: boolean;
}

/**
 * Which card each reaction belongs to: the display (`cards` lists displays, a card can appear
 * several times) with the greatest `publishedAt <= createdAt`; a display with `available: false`
 * (the "card unavailable" notice) takes the reaction out of the count.
 * Only +1 and -1 count; bots and null users are dropped; per (card, user) the latest reaction
 * wins. Pure: the inputs are not mutated.
 */
export function attributeReactions(
  reactions: readonly ReactionInput[],
  cards: readonly { id: string; publishedAt: Date; available?: boolean }[],
  prAuthorLogin: string,
): ReactionRow[] {
  const sortedCards = [...cards].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  const best = new Map<string, { r: ReactionInput; at: number; cardId: string }>();
  for (const r of reactions) {
    if (r.content !== "+1" && r.content !== "-1") continue;
    if (r.userType === "Bot") continue;
    const at = new Date(r.createdAt).getTime();
    if (Number.isNaN(at)) continue;
    let card: { id: string; available?: boolean } | undefined;
    for (const c of sortedCards) if (c.publishedAt.getTime() <= at) card = c;
    // A reaction to a "card unavailable" notice is not a vote on any card.
    if (!card || card.available === false) continue;
    const key = `${card.id}:${r.userId}`;
    const cur = best.get(key);
    if (!cur || at > cur.at) best.set(key, { r, at, cardId: card.id });
  }
  return [...best.values()]
    .map(({ r, at, cardId }) => ({
      card_id: cardId,
      user_id: r.userId,
      user_login: r.login,
      verdict: r.content === "+1" ? ("up" as const) : ("down" as const),
      reacted_at: new Date(at),
      is_pr_author: r.login.toLowerCase() === prAuthorLogin.toLowerCase(),
    }))
    .sort((a, b) => a.card_id.localeCompare(b.card_id) || a.user_id - b.user_id);
}

// ---------------------------------------------------------------------------------------------
// intent.feedback.record (check-run buttons)
// ---------------------------------------------------------------------------------------------

export const FEEDBACK_RECORD_JOB = "intent.feedback.record";

export const recordSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
  checkRunId: z.number().int().positive(),
  /** The card the clicked check run showed (payload); the vote may only narrow to it. */
  externalId: z.string().max(100).optional(),
  verdict: z.enum(["up", "down"]),
  userId: z.number().int().positive(),
  userLogin: z.string().min(1).max(200),
  deliveryId: z.string(),
});
export type RecordData = z.infer<typeof recordSchema>;

/** Votes were written (step 6): the pilot module syncs who may be counted as a reviewer. */
async function emitFeedbackRecorded(
  ctx: JobContext,
  s: Omit<ChangeSignal, "kind" | "atMs">,
): Promise<void> {
  await ctx.signals.emit({ ...s, kind: "feedback_recorded", atMs: ctx.clock.now().getTime() }, ctx);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function recordFeedback(
  data: RecordData,
  ctx: JobContext,
): Promise<"recorded" | "ignored"> {
  if (!(await getActiveInstallation(ctx.db, data.installationId))) return "ignored";
  const octokit: GitHubClient = await ctx.github
    .forInstallation(data.installationId)
    .catch((err: unknown) => {
      throw toJobError(err, "installation token");
    });
  let run: { app?: { id: number } | null; name: string; external_id?: string | null };
  try {
    const res = await octokit.rest.checks.get({
      owner: data.owner,
      repo: data.repo,
      check_run_id: data.checkRunId,
    });
    run = res.data;
  } catch (err) {
    if (classifyGitHubError(err) === "not_found") {
      ctx.log.info({ checkRunId: data.checkRunId }, "feedback check run not found");
      return "ignored";
    }
    throw toJobError(err, "checks.get");
  }
  const externalId = run.external_id ?? "";
  // The check run may have been PATCHed with a newer card since the click: the vote was for the
  // card that was shown, so a mismatch is dropped instead of credited to the newer card.
  if (data.externalId !== undefined && data.externalId !== externalId) {
    ctx.log.warn(
      { checkRunId: data.checkRunId, outcome: "feedback_rejected", reason: "card changed" },
      "feedback rejected",
    );
    return "ignored";
  }
  const card = UUID.test(externalId) ? await getCard(ctx.db, externalId) : undefined;
  const change = card ? await getChange(ctx.db, card.change_id) : undefined;
  const repoOk = change?.repository_id === data.repositoryId;
  if (
    run.app?.id !== ctx.config.githubAppId ||
    run.name !== INTENT_CHECK_NAME ||
    !card ||
    !change ||
    !repoOk
  ) {
    ctx.log.warn(
      { checkRunId: data.checkRunId, outcome: "feedback_rejected" },
      "feedback rejected",
    );
    return "ignored";
  }
  const now = ctx.clock.now();
  await upsertFeedback(
    ctx.db,
    {
      card_id: card.id,
      change_id: change.id,
      user_id: data.userId,
      user_login: data.userLogin,
      verdict: data.verdict,
      source: "check_action",
      reacted_at: now,
      is_pr_author: data.userLogin.toLowerCase() === change.author_login.toLowerCase(),
    },
    now,
  );
  await emitFeedbackRecorded(ctx, {
    installationId: data.installationId,
    repositoryId: data.repositoryId,
    owner: data.owner,
    repo: data.repo,
    prNumber: change.pr_number,
    changeId: change.id,
    headSha: card.head_sha,
  });
  return "recorded";
}

export const feedbackRecordJob = defineJob<RecordData>({
  name: FEEDBACK_RECORD_JOB,
  schema: recordSchema,
  options: { retryLimit: 5 },
  async handle(data, ctx) {
    const outcome = await recordFeedback(data, ctx);
    ctx.log.info({ outcome, checkRunId: data.checkRunId }, "intent feedback record done");
  },
});

// ---------------------------------------------------------------------------------------------
// intent.feedback.poll (reactions on the managed comment)
// ---------------------------------------------------------------------------------------------

export const FEEDBACK_POLL_JOB = "intent.feedback.poll";

export const pollSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().regex(NAME_PART),
  repo: z.string().regex(NAME_PART),
  changeId: z.string().regex(UUID),
});
export type PollData = z.infer<typeof pollSchema>;

export async function pollReactions(data: PollData, ctx: JobContext): Promise<number | null> {
  if (!(await getActiveInstallation(ctx.db, data.installationId))) return null;
  const change = await getChange(ctx.db, data.changeId);
  if (!change || change.repository_id !== data.repositoryId || change.graft_comment_id === null) {
    return null;
  }
  const cards = await publishedCards(ctx.db, change.id);
  if (cards.length === 0) return null;

  const octokit: GitHubClient = await ctx.github
    .forInstallation(data.installationId)
    .catch((err: unknown) => {
      throw toJobError(err, "installation token");
    });
  const reactions: ReactionInput[] = [];
  try {
    let pages = 0;
    const it = octokit.paginate.iterator(octokit.rest.reactions.listForIssueComment, {
      owner: data.owner,
      repo: data.repo,
      comment_id: change.graft_comment_id,
      per_page: 100,
    });
    for await (const page of it) {
      for (const r of page.data) {
        if (!r.user) continue;
        reactions.push({
          userId: r.user.id,
          login: r.user.login,
          userType: r.user.type,
          content: r.content,
          createdAt: r.created_at,
        });
      }
      if (++pages >= MAX_REACTION_PAGES) break;
    }
  } catch (err) {
    if (classifyGitHubError(err) === "not_found") return null;
    throw toJobError(err, "list reactions");
  }
  const rows = attributeReactions(reactions, cards, change.author_login);
  // No change lock: this job writes no GitHub output.
  await ctx.db
    .transaction()
    .execute((tx) => replaceReactionFeedback(tx, change.id, rows, ctx.clock.now()));
  if (rows.length > 0) {
    await emitFeedbackRecorded(ctx, {
      installationId: data.installationId,
      repositoryId: data.repositoryId,
      owner: data.owner,
      repo: data.repo,
      prNumber: change.pr_number,
      changeId: change.id,
      headSha: change.head_sha,
    });
  }
  return rows.length;
}

export const feedbackPollJob = defineJob<PollData>({
  name: FEEDBACK_POLL_JOB,
  schema: pollSchema,
  options: { retryLimit: 3 },
  async handle(data, ctx) {
    const n = await pollReactions(data, ctx);
    ctx.log.info({ changeId: data.changeId, rows: n }, "intent feedback poll done");
  },
});

// ---------------------------------------------------------------------------------------------
// intent.feedback.sweep (scheduled)
// ---------------------------------------------------------------------------------------------

export const FEEDBACK_SWEEP_JOB = "intent.feedback.sweep";
const DAY_MS = 86_400_000;

export async function sweepFeedback(ctx: JobContext): Promise<number> {
  const now = ctx.clock.now();
  const publishedSince = new Date(now.getTime() - 30 * DAY_MS);
  const closedSince = new Date(now.getTime() - 3 * DAY_MS);
  const res = await sql<{
    change_id: string;
    full_name: string;
    installation_id: number;
    repository_id: number;
  }>`
    select ch.id as change_id, r.full_name, r.installation_id, r.id as repository_id
    from changes ch
    join repositories r on r.id = ch.repository_id and r.removed_at is null
    join lateral (
      select max(d.shown_at) as last_published
      from intent_displays d where d.change_id = ch.id
    ) p on p.last_published is not null
    where p.last_published >= ${publishedSince}
      and (ch.state = 'open' or (ch.state in ('closed','merged') and ch.closed_at >= ${closedSince}))
    order by p.last_published desc
    limit 200`.execute(ctx.db);
  const bucket = Math.floor(now.getTime() / 900_000);
  let sent = 0;
  for (const row of res.rows) {
    const [owner = "", repo = ""] = row.full_name.split("/");
    const id = await ctx.queue.send(
      feedbackPollJob,
      {
        installationId: Number(row.installation_id),
        repositoryId: Number(row.repository_id),
        owner,
        repo,
        changeId: row.change_id,
      },
      { singletonKey: `fb-poll:${row.change_id}:${bucket}` },
    );
    if (id !== null) sent += 1;
  }
  return sent;
}

export const feedbackSweepJob = defineJob<Record<string, never>>({
  name: FEEDBACK_SWEEP_JOB,
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  options: { retryLimit: 1 },
  async handle(_data, ctx) {
    const n = await sweepFeedback(ctx);
    ctx.log.info({ polls: n }, "intent feedback sweep done");
  },
});
