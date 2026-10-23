/**
 * `get_status` (§7): what Graft knows about one PR of the token's repository, from the database
 * only. Everything it returns is already in the PR's managed comment and check runs (§4).
 */

import type { GetStatusInput, GetStatusOutput } from "../../../mcp/schemas.js";
import type { ModeState } from "../../../modes/index.js";
import { getChangeByNumber } from "../../changes/index.js";
import { latestPublishedCard } from "../../intent/index.js";
import { getEffectiveModes } from "../../modes/index.js";
import { getChangeProvenance, getMcpReport } from "../../provenance/index.js";
import { isMcpChange } from "../store.js";
import { checkRepository, isoOrNull, type ToolContext, ToolError } from "./common.js";

const MAX_GUARD_EVENTS = 10;

/** A mode as the tools show it: the effective value and why (`permission_missing pull_requests:write`). */
export function modeView(s: ModeState<string>): { effective: string; reason: string } {
  return {
    effective: s.effective,
    reason: s.missing === undefined ? s.reason : `${s.reason} ${s.missing}`,
  };
}

export async function getStatus(ctx: ToolContext, input: GetStatusInput): Promise<GetStatusOutput> {
  checkRepository(ctx, input.repository);
  const { db, principal } = ctx;
  const change = await getChangeByNumber(db, principal.repositoryId, input.pr);
  if (!change) throw new ToolError("not_found");
  const head = change.head_sha;

  const card = await latestPublishedCard(db, change.id);
  const prov = await getChangeProvenance(db, change.id);
  const report = prov ? await getMcpReport(db, change.id, prov.head_sha) : undefined;
  const verdict = await db
    .selectFrom("policy_verdicts")
    .selectAll()
    .where("change_id", "=", change.id)
    .orderBy("facts_read_at", "desc")
    .orderBy("evaluated_at", "desc")
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
  const events = await db
    .selectFrom("guard_events")
    .selectAll()
    .where("repository_id", "=", principal.repositoryId)
    .where("culprit_change_id", "=", change.id)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(MAX_GUARD_EVENTS)
    .execute();
  const modes = await getEffectiveModes(db, principal.repositoryId, ctx.config);

  const approvals = (verdict?.approvals ?? {}) as { current?: unknown; stale?: unknown };
  const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : 0);

  return {
    pr: {
      number: change.pr_number,
      state: change.state,
      headSha: head,
      baseRef: change.base_ref,
      openedThroughMcp: await isMcpChange(db, principal.repositoryId, change.pr_number),
    },
    card: card
      ? {
          headSha: card.head_sha,
          current: card.head_sha === head,
          status: card.status,
          riskClass: card.risk_class,
          goal: card.goal,
          behaviorChanges: card.behavior_changes,
          outOfScopeEdits: card.out_of_scope_edits,
        }
      : null,
    provenance: prov
      ? {
          headSha: prov.head_sha,
          current: prov.head_sha === head,
          authorKind: prov.author_kind,
          agent: prov.agent,
          model: prov.model,
          task: prov.task_external_id,
          sessionUrl: prov.session_url,
          conflicts: Object.keys(prov.conflicts ?? {}).sort(),
          mcp: {
            report: prov.mcp_report,
            agent: report?.agent ?? null,
            model: report?.model ?? null,
            task: report?.task_external_id ?? null,
            sessionUrl: report?.session_url ?? null,
          },
        }
      : null,
    policy: verdict
      ? {
          headSha: verdict.head_sha,
          current: verdict.head_sha === head,
          outcome: verdict.outcome,
          policyMode: verdict.policy_mode,
          published: verdict.check_conclusion,
          wouldBe: verdict.enforced_conclusion,
          wouldBeReason: verdict.enforced_reason,
          riskClass: verdict.risk_class,
          approvals: { current: count(approvals.current), stale: count(approvals.stale) },
          breakGlass:
            verdict.enforced_reason !== "break_glass"
              ? "none"
              : verdict.policy_mode === "enforce"
                ? "applied"
                : "would_bypass",
          evaluatedAt: verdict.evaluated_at.toISOString(),
        }
      : null,
    guard: events.map((e) => ({
      id: e.id,
      status: e.status,
      detectedAt: isoOrNull(e.detected_at),
      failingChecks: (e.failing_checks ?? []).map((c) => c.name),
      revertPrNumber: e.revert_pr_number,
      revertOutcome: e.revert_outcome,
    })),
    modes: {
      policy: modeView(modes.policy),
      guard: modeView(modes.guard),
      mcpWrite: modeView(modes.mcpWrite),
    },
  };
}
