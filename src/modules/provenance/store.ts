import type { Selectable, Transaction } from "kysely";
import type { Database, FieldSource, ProvenanceFieldName } from "../../db/schema.js";
import type { Change } from "../changes/index.js";
import type { ProvenanceResult } from "./compute.js";

type Tx = Transaction<Database>;

export async function persistProvenance(
  tx: Tx,
  o: {
    change: Change;
    repositoryId: number;
    repositoryFullName: string;
    headSha: string;
    result: ProvenanceResult;
    now: Date;
    checkRunId?: number;
  },
): Promise<void> {
  const { change, result: r, now } = o;

  await tx
    .deleteFrom("provenance")
    .where("change_id", "=", change.id)
    .where("source", "in", ["trailer", "pr_body"])
    .execute();
  for (const c of r.perCommit) {
    await tx
      .insertInto("provenance")
      .values({
        change_id: change.id,
        source: "trailer",
        commit_sha: c.sha,
        agent: c.fields.agent ?? null,
        model: c.fields.model ?? null,
        task_external_id: c.fields.task ?? null,
        session_url: c.fields.session ?? null,
        created_at: now,
      })
      .execute();
  }
  if (r.prBodyFields) {
    await tx
      .insertInto("provenance")
      .values({
        change_id: change.id,
        source: "pr_body",
        commit_sha: null,
        agent: r.prBodyFields.agent ?? null,
        model: r.prBodyFields.model ?? null,
        task_external_id: r.prBodyFields.task ?? null,
        session_url: r.prBodyFields.session ?? null,
        created_at: now,
      })
      .execute();
  }

  // Task: trailers are the only source in Phase 0, so no task means no link.
  let taskId: string | null = null;
  const task = r.fields.task?.value;
  if (task !== undefined) {
    const m = /^#(\d{1,9})$/.exec(task);
    const issueNumber = m?.[1] ? Number(m[1]) : null;
    const row = await tx
      .insertInto("tasks")
      .values({
        repository_id: o.repositoryId,
        external_id: task,
        issue_number: issueNumber,
        issue_url:
          issueNumber === null
            ? null
            : `https://github.com/${o.repositoryFullName}/issues/${issueNumber}`,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["repository_id", "external_id"]).doUpdateSet((eb) => ({
          issue_number: eb.ref("excluded.issue_number"),
          issue_url: eb.ref("excluded.issue_url"),
          updated_at: now,
        })),
      )
      .returning("id")
      .executeTakeFirstOrThrow();
    taskId = row.id;
  }
  await tx
    .updateTable("changes")
    .set({ task_id: taskId, updated_at: now })
    .where("id", "=", change.id)
    .execute();

  const fieldSources: Partial<Record<ProvenanceFieldName, FieldSource>> = {};
  for (const [f, v] of Object.entries(r.fields)) {
    fieldSources[f as ProvenanceFieldName] = {
      source: v.source,
      ...(v.commitSha ? { commitSha: v.commitSha } : {}),
    };
  }
  const values = {
    head_sha: o.headSha,
    author_kind: r.authorKind,
    author_kind_reason: r.authorKindReason,
    agent: r.fields.agent?.value ?? null,
    model: r.fields.model?.value ?? null,
    task_external_id: task ?? null,
    session_url: r.fields.session?.value ?? null,
    field_sources: JSON.stringify(fieldSources),
    conflicts: JSON.stringify(r.conflicts),
    warnings: JSON.stringify(r.warnings),
    commits_total: r.counts.total,
    commits_scanned: r.counts.scanned,
    commits_with_trailers: r.counts.withTrailers,
    agent_coauthor_commits: r.counts.agentCoauthor,
    commits_truncated: r.truncated,
    computed_at: now,
    updated_at: now,
  };
  await tx
    .insertInto("change_provenance")
    .values({
      change_id: change.id,
      check_run_id: o.checkRunId ?? null,
      created_at: now,
      ...values,
    })
    .onConflict((oc) =>
      oc.column("change_id").doUpdateSet({
        ...values,
        ...(o.checkRunId !== undefined ? { check_run_id: o.checkRunId } : {}),
      }),
    )
    .execute();
}

export type ChangeProvenanceRow = Selectable<Database["change_provenance"]>;

export async function getChangeProvenance(
  tx: Tx,
  changeId: string,
): Promise<ChangeProvenanceRow | undefined> {
  return tx
    .selectFrom("change_provenance")
    .selectAll()
    .where("change_id", "=", changeId)
    .executeTakeFirst();
}

export async function setCheckRunId(tx: Tx, changeId: string, checkRunId: number, now: Date) {
  await tx
    .updateTable("change_provenance")
    .set({ check_run_id: checkRunId, updated_at: now })
    .where("change_id", "=", changeId)
    .execute();
}
