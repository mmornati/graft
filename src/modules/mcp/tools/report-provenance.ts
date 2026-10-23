/**
 * `report_provenance` (§7, D13–D15): an agent says who wrote a PR head. Stored as untrusted, once
 * per head, validated like a trailer; it can make the author fact `unknown`, never anything looser.
 * No GitHub request in the call: the provenance job (enqueued after the lock) republishes.
 */
import { withChangeLock } from "../../../db/locks.js";
import type { ReportProvenanceInput, ReportProvenanceOutput } from "../../../mcp/schemas.js";
import { getChange, getChangeByNumber } from "../../changes/index.js";
import {
  type GraftField,
  getChangeProvenance,
  getMcpReport,
  mcpAgreement,
  normalizeField,
  provenanceRefreshJob,
} from "../../provenance/index.js";
import { checkRepository, splitFullName, type ToolContext, ToolError } from "./common.js";

const FIELDS: readonly [keyof ReportProvenanceInput, GraftField][] = [
  ["agent", "agent"],
  ["model", "model"],
  ["task", "task"],
  ["sessionUrl", "session"],
];

export async function reportProvenance(
  ctx: ToolContext,
  input: ReportProvenanceInput,
): Promise<ReportProvenanceOutput> {
  checkRepository(ctx, input.repository);
  const { db, principal } = ctx;

  // Every field through the trailer validators; the first invalid one is named, nothing stored.
  const values: Partial<Record<GraftField, string>> = {};
  for (const [key, field] of FIELDS) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") throw new ToolError("invalid_argument", key);
    const value = normalizeField(field, raw);
    if (value === null) throw new ToolError("invalid_argument", key);
    values[field] = value;
  }
  const agent = values.agent as string;

  const change = await getChangeByNumber(db, principal.repositoryId, input.pr);
  if (!change) throw new ToolError("not_found");

  const result = await withChangeLock(db, change.id, async (tx) => {
    const current = await getChange(tx, change.id);
    if (!current) throw new ToolError("not_found");
    // D15: closed first, so a report on a merged PR says so whatever its head.
    if (current.state !== "open") throw new ToolError("pr_closed");
    if (current.head_sha !== input.headSha) throw new ToolError("stale_head");

    const same = (a: string | null, b: string | undefined) => a === (b ?? null);
    const existing = await getMcpReport(tx, change.id, input.headSha);
    if (existing) {
      // D14: one report per head; an identical repeat returns the stored result.
      if (
        !same(existing.agent, values.agent) ||
        !same(existing.model, values.model) ||
        !same(existing.task_external_id, values.task) ||
        !same(existing.session_url, values.session)
      ) {
        throw new ToolError("already_reported");
      }
    }
    let rowId = existing?.id;
    if (!existing) {
      const row = await tx
        .insertInto("provenance")
        .values({
          change_id: change.id,
          source: "mcp",
          commit_sha: input.headSha,
          agent,
          model: values.model ?? null,
          task_external_id: values.task ?? null,
          session_url: values.session ?? null,
          created_at: ctx.clock.now(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      rowId = row.id;
    }
    const trailers = await getChangeProvenance(tx, change.id);
    const agreement =
      trailers === undefined || trailers.head_sha !== input.headSha
        ? ("pending" as const)
        : mcpAgreement(
            { headSha: trailers.head_sha, authorKind: trailers.author_kind, agent: trailers.agent },
            { headSha: input.headSha, agent },
          );
    return { rowId: rowId as string, existing: existing !== undefined, agreement };
  });

  if (!result.existing) {
    // D15: outside the lock. The job recomputes `change_provenance` with the merge, republishes
    // its neutral check and comment section, and signals the policy job.
    const { owner, repo } = splitFullName(principal.fullName);
    await ctx.queue.send(
      provenanceRefreshJob,
      {
        installationId: principal.installationId,
        repositoryId: principal.repositoryId,
        owner,
        repo,
        prNumber: change.pr_number,
        headSha: input.headSha,
        trigger: "mcp_report",
        deliveryId: `mcp:${result.rowId}`,
      },
      { singletonKey: `prov-mcp:${result.rowId}` },
    );
  }
  return {
    stored: true,
    existing: result.existing,
    agreement: result.agreement === "none" ? "pending" : result.agreement,
  };
}
