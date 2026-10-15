import type { Selectable, Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { Database, PolicyVerdictsTable } from "../../db/schema.js";

type Executor = Db | Transaction<Database>;
export type PolicyVerdictRow = Selectable<PolicyVerdictsTable>;

export interface VerdictIdentity {
  changeId: string;
  headSha: string;
  /** NULL when there is no file (missing, directory). */
  policyFileSha: string | null;
}

export interface VerdictValues extends VerdictIdentity {
  baseRef: string;
  policyCommitSha: string;
  policyStatus: "ok" | "missing" | "invalid";
  policyHash: string | null;
  outcome: PolicyVerdictsTable["outcome"];
  riskClass: PolicyVerdictsTable["risk_class"];
  riskFinal: boolean;
  riskSource: PolicyVerdictsTable["risk_source"];
  authorKind: PolicyVerdictsTable["author_kind"];
  policyFileChanged: boolean;
  rulesMatched: unknown[];
  required: Record<string, unknown>;
  approvals: Record<string, unknown>;
  errors: unknown[];
  factsHash: string;
  factsReadAt: Date;
  checkRunId: number | null;
  publishedAt: Date | null;
  evaluatedAt: Date;
}

/** Insert or update the row of (change, head, policy file). The conclusion is always `neutral`. */
export async function upsertVerdict(tx: Transaction<Database>, v: VerdictValues): Promise<void> {
  const values = {
    base_ref: v.baseRef,
    policy_commit_sha: v.policyCommitSha,
    policy_status: v.policyStatus,
    policy_hash: v.policyHash,
    outcome: v.outcome,
    risk_class: v.riskClass,
    risk_final: v.riskFinal,
    risk_source: v.riskSource,
    author_kind: v.authorKind,
    policy_file_changed: v.policyFileChanged,
    rules_matched: JSON.stringify(v.rulesMatched),
    required: JSON.stringify(v.required),
    approvals: JSON.stringify(v.approvals),
    errors: JSON.stringify(v.errors),
    facts_hash: v.factsHash,
    facts_read_at: v.factsReadAt,
    check_run_id: v.checkRunId,
    published_at: v.publishedAt,
    evaluated_at: v.evaluatedAt,
    updated_at: v.evaluatedAt,
  };
  const existing = await findVerdict(tx, v);
  if (existing) {
    await tx.updateTable("policy_verdicts").set(values).where("id", "=", existing.id).execute();
    return;
  }
  await tx
    .insertInto("policy_verdicts")
    .values({
      change_id: v.changeId,
      head_sha: v.headSha,
      policy_file_sha: v.policyFileSha,
      ...values,
    })
    .execute();
}

export async function maxFactsReadAt(ex: Executor, changeId: string): Promise<Date | null> {
  const row = await ex
    .selectFrom("policy_verdicts")
    .select((eb) => eb.fn.max("facts_read_at").as("at"))
    .where("change_id", "=", changeId)
    .executeTakeFirst();
  return row?.at ?? null;
}

export async function findVerdict(
  ex: Executor,
  id: VerdictIdentity,
): Promise<PolicyVerdictRow | undefined> {
  let q = ex
    .selectFrom("policy_verdicts")
    .selectAll()
    .where("change_id", "=", id.changeId)
    .where("head_sha", "=", id.headSha);
  q =
    id.policyFileSha === null
      ? q.where("policy_file_sha", "is", null)
      : q.where("policy_file_sha", "=", id.policyFileSha);
  return q.executeTakeFirst();
}

/** Any row of that head with a check run: the check is per head, not per policy file. */
export async function checkRunIdForHead(
  ex: Executor,
  changeId: string,
  headSha: string,
): Promise<number | null> {
  const row = await ex
    .selectFrom("policy_verdicts")
    .select("check_run_id")
    .where("change_id", "=", changeId)
    .where("head_sha", "=", headSha)
    .where("check_run_id", "is not", null)
    .orderBy("facts_read_at", "desc")
    .executeTakeFirst();
  return row?.check_run_id ?? null;
}
