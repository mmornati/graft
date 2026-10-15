/** The standard waiter `prSettled(pr, headSha)` (T8). */
import { sql } from "kysely";
import { changeRow, GRAFT_CHECKS, graftChecks } from "./observe.js";
import type { RunCtx } from "./types.js";

export interface SettleState {
  headSeen: boolean;
  provenanceForHead: boolean;
  cardWithDisplay: boolean;
  verdictFinal: boolean;
  checksCompleted: number;
}

export function isSettled(s: SettleState): boolean {
  return (
    s.headSeen &&
    s.provenanceForHead &&
    s.cardWithDisplay &&
    s.verdictFinal &&
    s.checksCompleted >= GRAFT_CHECKS.length
  );
}

/**
 * `changes.head_sha = headSha`; provenance computed for it; the newest display is a card (or the
 * "unavailable" notice) of that head; the newest verdict of the change is for that head, final
 * (`risk_final`, or `risk_source = 'card_unavailable'`) and published; the three Graft check runs
 * on the head are `completed`. "Newest" matters when a head returns after a rewritten history.
 */
export async function settleState(
  ctx: RunCtx,
  prNumber: number,
  headSha: string,
): Promise<SettleState> {
  const ch = await changeRow(ctx, prNumber);
  const state: SettleState = {
    headSeen: ch?.head_sha === headSha,
    provenanceForHead: false,
    cardWithDisplay: false,
    verdictFinal: false,
    checksCompleted: 0,
  };
  if (!ch || !state.headSeen) return state;
  const prov = await ctx.db
    .selectFrom("change_provenance")
    .select("head_sha")
    .where("change_id", "=", ch.id)
    .executeTakeFirst();
  state.provenanceForHead = prov?.head_sha === headSha;
  const d = await sql<{ head_sha: string; status: string }>`
    select k.head_sha, d.status from intent_displays d join intent_cards k on k.id = d.card_id
    where d.change_id = ${ch.id} order by d.shown_at desc, d.seq desc limit 1`.execute(ctx.db);
  const latestDisplay = d.rows[0];
  state.cardWithDisplay =
    latestDisplay !== undefined &&
    latestDisplay.head_sha === headSha &&
    (latestDisplay.status === "ok" || latestDisplay.status === "unavailable");
  const v = await ctx.db
    .selectFrom("policy_verdicts")
    .select(["head_sha", "risk_final", "risk_source", "published_at"])
    .where("change_id", "=", ch.id)
    .orderBy("evaluated_at", "desc")
    .limit(1)
    .executeTakeFirst();
  state.verdictFinal =
    v !== undefined &&
    v.head_sha === headSha &&
    v.published_at !== null &&
    (v.risk_final || v.risk_source === "card_unavailable");
  if (state.provenanceForHead && state.cardWithDisplay && state.verdictFinal) {
    const checks = await graftChecks(ctx, headSha);
    state.checksCompleted = new Set(
      checks.filter((c) => c.status === "completed").map((c) => c.name),
    ).size;
  }
  return state;
}

export async function prSettled(
  ctx: RunCtx,
  prNumber: number,
  headSha: string,
): Promise<SettleState | false> {
  const s = await settleState(ctx, prNumber, headSha);
  return isSettled(s) ? s : false;
}
