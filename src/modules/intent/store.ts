import { type Selectable, sql, type Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { Database, IntentCardsTable, IntentFailureReason } from "../../db/schema.js";
import { type CardResult, RETRYABLE } from "./generate.js";
import type { IntentView } from "./render.js";

type Executor = Db | Transaction<Database>;
export type IntentCardRow = Selectable<IntentCardsTable>;

const json = (v: unknown): string => JSON.stringify(v);

function resultToValues(result: CardResult) {
  const card = result.card;
  const i = result.inputs;
  return {
    status: result.status,
    failure_reason: result.failureReason as IntentFailureReason | null,
    goal: card?.goal ?? null,
    behavior_changes: json(card?.behaviorChanges ?? []),
    out_of_scope_edits: json(card?.outOfScopeEdits ?? []),
    risk_class: result.risk.final,
    risk_floor: result.risk.floor,
    floor_reasons: json(result.risk.floorReasons),
    model_risk_class: result.risk.writer,
    model_risk_reason: result.risk.writerReason,
    first_pass_risk_class: result.risk.firstPass,
    verifier_risk_class: result.risk.verifier,
    risk_raised_by: json(result.risk.raisedBy),
    verifier_status: result.verifier.status,
    verifier_failure: result.verifier.failure,
    verifier_claims: json(result.verifier.claims),
    verifier_missing: json(result.verifier.missing),
    verifier_unexplained: json(result.verifier.unexplained),
    instructions_in_data: result.instructionsInData,
    writer_model: result.models.writer,
    first_pass_model: result.models.firstPass,
    verifier_model: result.models.verifier,
    llm_calls: result.usage.calls,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    cache_read_tokens: result.usage.cacheReadTokens,
    cache_write_tokens: result.usage.cacheWriteTokens,
    files_total: i.filesTotal,
    files_listed: i.filesListed,
    files_full: i.filesFull,
    files_partial: i.filesPartial,
    files_omitted: i.filesOmitted,
    omitted_files: json(i.omitted),
    lines_added: i.linesAdded,
    lines_deleted: i.linesDeleted,
    inputs_truncated: i.truncated,
    linked_issue_number: i.linkedIssueNumber,
  };
}

/** The stored row as the `CardResult` shape plus `id` and `headSha`. */
export function rowToView(row: IntentCardRow): IntentView {
  const failureReason = row.failure_reason;
  return {
    id: row.id,
    headSha: row.head_sha,
    promptVersion: row.prompt_version,
    inputHash: row.input_hash,
    status: row.status,
    failureReason,
    retryable:
      row.status === "unavailable" && failureReason !== null && RETRYABLE.has(failureReason),
    card:
      row.status === "ok" && row.goal !== null
        ? {
            goal: row.goal,
            behaviorChanges: row.behavior_changes,
            outOfScopeEdits: row.out_of_scope_edits,
          }
        : null,
    risk: {
      final: row.risk_class,
      floor: row.risk_floor,
      floorReasons: row.floor_reasons as IntentView["risk"]["floorReasons"],
      writer: row.model_risk_class,
      writerReason: row.model_risk_reason,
      firstPass: row.first_pass_risk_class,
      verifier: row.verifier_risk_class,
      raisedBy: row.risk_raised_by as IntentView["risk"]["raisedBy"],
    },
    verifier: {
      status: row.verifier_status,
      claims: row.verifier_claims as IntentView["verifier"]["claims"],
      missing: row.verifier_missing,
      unexplained: row.verifier_unexplained,
      failure: row.verifier_failure as IntentView["verifier"]["failure"],
    },
    instructionsInData: row.instructions_in_data,
    models: {
      writer: row.writer_model,
      firstPass: row.first_pass_model,
      verifier: row.verifier_model,
    },
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      calls: row.llm_calls,
    },
    inputs: {
      filesTotal: row.files_total,
      filesListed: row.files_listed,
      filesFull: row.files_full,
      filesPartial: row.files_partial,
      filesOmitted: row.files_omitted,
      omitted: row.omitted_files as IntentView["inputs"]["omitted"],
      linesAdded: row.lines_added,
      linesDeleted: row.lines_deleted,
      truncated: row.inputs_truncated,
      linkedIssueNumber: row.linked_issue_number,
    },
  };
}

export async function findCard(
  ex: Executor,
  o: { changeId: string; headSha: string; promptVersion: string; inputHash: string },
): Promise<IntentCardRow | undefined> {
  return ex
    .selectFrom("intent_cards")
    .selectAll()
    .where("change_id", "=", o.changeId)
    .where("head_sha", "=", o.headSha)
    .where("prompt_version", "=", o.promptVersion)
    .where("input_hash", "=", o.inputHash)
    .executeTakeFirst();
}

/**
 * Insert the card, or replace an `unavailable` row of the same identity in place (same id, so a
 * published comment and check run stay attached). An existing `ok` row is never overwritten.
 */
export async function saveCard(
  ex: Executor,
  o: { changeId: string; headSha: string; result: CardResult; now: Date },
): Promise<IntentCardRow> {
  const values = resultToValues(o.result);
  // Spend is append-only and written for every run, whether or not the row below is inserted,
  // replaced or left alone (a concurrent `ok` row wins): the budget counts what was paid for.
  const u = o.result.usage;
  const tokens = u.inputTokens + u.outputTokens + u.cacheWriteTokens;
  if (tokens > 0) {
    // cost_usd is fixed at spend time from each call's `response.model`; NULL = unpriced.
    await sql`
      insert into intent_spend (repository_id, change_id, tokens, llm_calls, spent_at, cost_usd)
      select ch.repository_id, ch.id, ${tokens}, ${u.calls}, ${o.now}, ${o.result.costUsd ?? null}
      from changes ch where ch.id = ${o.changeId}`.execute(ex);
  }
  const row = await ex
    .insertInto("intent_cards")
    .values({
      change_id: o.changeId,
      head_sha: o.headSha,
      prompt_version: o.result.promptVersion,
      input_hash: o.result.inputHash,
      created_at: o.now,
      updated_at: o.now,
      ...values,
    })
    .onConflict((oc) =>
      oc
        .columns(["change_id", "head_sha", "prompt_version", "input_hash"])
        .doUpdateSet({ ...values, updated_at: o.now })
        .where("intent_cards.status", "=", "unavailable"),
    )
    .returningAll()
    .executeTakeFirst();
  if (row) return row;
  return (await findCard(ex, {
    changeId: o.changeId,
    headSha: o.headSha,
    promptVersion: o.result.promptVersion,
    inputHash: o.result.inputHash,
  })) as IntentCardRow;
}

export async function getCard(ex: Executor, id: string): Promise<IntentCardRow | undefined> {
  return ex.selectFrom("intent_cards").selectAll().where("id", "=", id).executeTakeFirst();
}

/** The card on screen now: the one of the latest display of the change. */
export async function latestPublishedCard(
  ex: Executor,
  changeId: string,
): Promise<IntentCardRow | undefined> {
  return (
    ex
      .selectFrom("intent_displays as d")
      .innerJoin("intent_cards as c", "c.id", "d.card_id")
      .selectAll("c")
      .where("d.change_id", "=", changeId)
      // A "pending" display is the outdated note: the card on screen is the last real one.
      .where("d.status", "<>", "pending")
      .orderBy("d.shown_at", "desc")
      .orderBy("d.seq", "desc")
      .executeTakeFirst()
  );
}

/** The check run already used for this head by a published card of the change. */
export async function publishedCheckRunForHead(
  ex: Executor,
  changeId: string,
  headSha: string,
): Promise<number | null> {
  const row = await ex
    .selectFrom("intent_cards")
    .select("check_run_id")
    .where("change_id", "=", changeId)
    .where("head_sha", "=", headSha)
    .where("published_at", "is not", null)
    .where("check_run_id", "is not", null)
    .orderBy("published_at", "desc")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row?.check_run_id ?? null;
}

/**
 * Record that `cardId` is now on screen. `now` must be taken inside the change lock, right
 * AFTER the comment write (since step 4): it is the moment the card became visible.
 * `shown_at` is our clock a few hundred ms after GitHub accepted the write; GitHub's `created_at`
 * on reactions can be skewed against it by up to clock skew, which is negligible for attribution. `published_at` keeps the first
 * display; every change of what is shown (another card, or the same card in another status) adds
 * a row to `intent_displays`, which is what reactions are attributed by.
 */
export async function markPublished(
  tx: Transaction<Database>,
  card: { id: string; changeId: string; status: "ok" | "unavailable" },
  o: { commentId: number; checkRunId: number; now: Date },
): Promise<void> {
  await tx
    .updateTable("intent_cards")
    .set({
      comment_id: o.commentId,
      check_run_id: o.checkRunId,
      published_at: sql<Date>`coalesce(published_at, ${o.now})`,
      updated_at: o.now,
    })
    .where("id", "=", card.id)
    .execute();
  const last = await tx
    .selectFrom("intent_displays")
    .select(["card_id", "status"])
    .where("change_id", "=", card.changeId)
    .orderBy("shown_at", "desc")
    .orderBy("seq", "desc")
    .executeTakeFirst();
  if (!last || last.card_id !== card.id || last.status !== card.status) {
    await tx
      .insertInto("intent_displays")
      .values({
        change_id: card.changeId,
        card_id: card.id,
        status: card.status,
        shown_at: o.now,
      })
      .execute();
  }
}

/**
 * The "outdated" note (D11) replaced the card on screen: record it as a display of the previous
 * card in status `pending`, so reactions made while it is shown are dropped. Call inside the
 * change lock, after the comment write.
 */
export async function recordPendingDisplay(
  tx: Transaction<Database>,
  o: { changeId: string; cardId: string; now: Date },
): Promise<void> {
  await tx
    .insertInto("intent_displays")
    .values({ change_id: o.changeId, card_id: o.cardId, status: "pending", shown_at: o.now })
    .execute();
}

/** Every display of the change, oldest first (a card can appear more than once: A, B, A). */
export async function publishedCards(
  ex: Executor,
  changeId: string,
): Promise<{ id: string; publishedAt: Date; available: boolean }[]> {
  const rows = await ex
    .selectFrom("intent_displays")
    .select(["card_id", "shown_at", "status"])
    .where("change_id", "=", changeId)
    .orderBy("shown_at", "asc")
    .orderBy("seq", "asc")
    .execute();
  return rows.map((r) => ({
    id: r.card_id,
    publishedAt: r.shown_at,
    available: r.status === "ok",
  }));
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** sum(input + output + cache_write) of today's (UTC) model runs of the repository (D21). */
export async function tokensUsedToday(
  ex: Executor,
  repositoryId: number,
  now: Date,
): Promise<number> {
  const res = await sql<{ n: string | null }>`
    select sum(tokens)::text as n from intent_spend
    where repository_id = ${repositoryId}
      and spent_at >= ${startOfUtcDay(now)}
      and spent_at < ${new Date(startOfUtcDay(now).getTime() + 86_400_000)}`.execute(ex);
  return Number(res.rows[0]?.n ?? 0);
}

export interface FeedbackRow {
  card_id: string;
  change_id: string;
  user_id: number;
  user_login: string;
  verdict: "up" | "down";
  source: "reaction" | "check_action";
  reacted_at: Date;
  is_pr_author: boolean;
}

export async function upsertFeedback(ex: Executor, row: FeedbackRow, now: Date): Promise<void> {
  await ex
    .insertInto("intent_feedback")
    .values({ ...row, created_at: now, updated_at: now })
    .onConflict((oc) =>
      oc.columns(["card_id", "user_id", "source"]).doUpdateSet({
        verdict: row.verdict,
        user_login: row.user_login,
        reacted_at: row.reacted_at,
        is_pr_author: row.is_pr_author,
        updated_at: now,
      }),
    )
    .execute();
}

/**
 * Make the `reaction` rows of the change equal `rows`: delete the ones not in it, upsert the
 * rest. `check_action` rows are never touched.
 */
export async function replaceReactionFeedback(
  tx: Transaction<Database>,
  changeId: string,
  rows: Omit<FeedbackRow, "change_id" | "source">[],
  now: Date,
): Promise<void> {
  const keep = new Set(rows.map((r) => `${r.card_id}:${r.user_id}`));
  const existing = await tx
    .selectFrom("intent_feedback")
    .select(["id", "card_id", "user_id"])
    .where("change_id", "=", changeId)
    .where("source", "=", "reaction")
    .execute();
  const stale = existing.filter((e) => !keep.has(`${e.card_id}:${e.user_id}`)).map((e) => e.id);
  if (stale.length > 0) await tx.deleteFrom("intent_feedback").where("id", "in", stale).execute();
  for (const r of rows) {
    await upsertFeedback(tx, { ...r, change_id: changeId, source: "reaction" }, now);
  }
}

export interface FeedbackSummary {
  votes: { up: number; down: number };
  cards: { rated: number; accurate: number; inaccurate: number };
  accuracy: number | null;
}

/**
 * Per (card, user) the effective vote is the one with the latest `reacted_at` across sources.
 * A card is accurate with at least one vote and no down vote, inaccurate with at least one down.
 * PR authors are excluded unless `includePrAuthors`.
 */
export async function feedbackSummary(
  ex: Executor,
  o: { since?: Date; repositoryId?: number; includePrAuthors?: boolean } = {},
): Promise<FeedbackSummary> {
  let q = ex
    .selectFrom("intent_feedback as f")
    .innerJoin("changes as ch", "ch.id", "f.change_id")
    .select(["f.card_id", "f.user_id", "f.verdict", "f.source", "f.reacted_at", "f.is_pr_author"]);
  if (o.repositoryId !== undefined) q = q.where("ch.repository_id", "=", o.repositoryId);
  const rows = await q.execute();

  const effective = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.card_id}:${r.user_id}`;
    const cur = effective.get(key);
    if (
      !cur ||
      r.reacted_at > cur.reacted_at ||
      (r.reacted_at.getTime() === cur.reacted_at.getTime() && r.source < cur.source)
    ) {
      effective.set(key, r);
    }
  }
  const votes = { up: 0, down: 0 };
  const perCard = new Map<string, { up: number; down: number }>();
  for (const r of effective.values()) {
    if (o.since && r.reacted_at < o.since) continue;
    if (r.is_pr_author && !o.includePrAuthors) continue;
    votes[r.verdict] += 1;
    const c = perCard.get(r.card_id) ?? { up: 0, down: 0 };
    c[r.verdict] += 1;
    perCard.set(r.card_id, c);
  }
  let accurate = 0;
  let inaccurate = 0;
  for (const c of perCard.values()) {
    if (c.down > 0) inaccurate += 1;
    else if (c.up > 0) accurate += 1;
  }
  const rated = perCard.size;
  return {
    votes,
    cards: { rated, accurate, inaccurate },
    accuracy: rated === 0 ? null : accurate / rated,
  };
}

export interface EffectiveVote {
  cardId: string;
  changeId: string;
  repositoryId: number;
  installationId: number;
  userId: number;
  userLogin: string;
  verdict: "up" | "down";
  source: "reaction" | "check_action";
  reactedAt: Date;
  isPrAuthor: boolean;
  cardStatus: "ok" | "unavailable";
}

/**
 * Per (card, user) the vote with the latest `reactedAt` across sources; a tie goes to
 * `check_action` (as `feedbackSummary`). Pure: the input is not mutated.
 */
export function pickEffectiveVotes(votes: readonly EffectiveVote[]): EffectiveVote[] {
  const best = new Map<string, EffectiveVote>();
  for (const v of votes) {
    const key = `${v.cardId}:${v.userId}`;
    const cur = best.get(key);
    if (
      !cur ||
      v.reactedAt > cur.reactedAt ||
      (v.reactedAt.getTime() === cur.reactedAt.getTime() && v.source < cur.source)
    ) {
      best.set(key, v);
    }
  }
  return [...best.values()];
}

/**
 * Effective vote per (card, user) = latest `reacted_at` across sources (ties: `check_action`
 * first, as `feedbackSummary`); then filtered to `reactedAt` in `[since, until)`. The window
 * applies to the effective vote, so a vote replaced by a newer one outside the window is gone.
 */
export async function effectiveVotes(
  ex: Executor,
  o: { installationIds: number[]; since: Date; until: Date },
): Promise<EffectiveVote[]> {
  if (o.installationIds.length === 0) return [];
  const res = await sql<{
    card_id: string;
    change_id: string;
    repository_id: number;
    installation_id: number;
    user_id: number;
    user_login: string;
    verdict: "up" | "down";
    source: "reaction" | "check_action";
    reacted_at: Date;
    is_pr_author: boolean;
    card_status: "ok" | "unavailable";
  }>`
    select f.card_id, f.change_id, ch.repository_id, r.installation_id, f.user_id, f.user_login,
      f.verdict, f.source, f.reacted_at, f.is_pr_author, c.status as card_status
    from intent_feedback f
    join intent_cards c on c.id = f.card_id
    join changes ch on ch.id = f.change_id
    join repositories r on r.id = ch.repository_id
    where r.installation_id in (${sql.join(o.installationIds)})`.execute(ex);
  const all: EffectiveVote[] = res.rows.map((r) => ({
    cardId: r.card_id,
    changeId: r.change_id,
    repositoryId: Number(r.repository_id),
    installationId: Number(r.installation_id),
    userId: Number(r.user_id),
    userLogin: r.user_login,
    verdict: r.verdict,
    source: r.source,
    reactedAt: r.reacted_at,
    isPrAuthor: r.is_pr_author,
    cardStatus: r.card_status,
  }));
  return pickEffectiveVotes(all)
    .filter((v) => v.reactedAt >= o.since && v.reactedAt < o.until)
    .sort(
      (a, b) =>
        a.reactedAt.getTime() - b.reactedAt.getTime() ||
        a.cardId.localeCompare(b.cardId) ||
        a.userId - b.userId,
    );
}
