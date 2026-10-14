import type { ColumnType, Generated } from "kysely";

/** timestamptz NOT NULL DEFAULT now(): optional on insert. */
type Timestamp = ColumnType<Date, Date | undefined, Date>;
/** timestamptz NOT NULL DEFAULT now(), never updated. */
type CreatedAt = ColumnType<Date, Date | undefined, never>;
/** jsonb with a default; pass JSON text or a value serialised by the caller. */
type Json<T> = ColumnType<T, string | undefined, string>;

export type RiskClass = "trivial" | "logic" | "sensitive";

export interface InstallationsTable {
  id: number;
  account_id: number;
  account_login: string;
  account_type: "User" | "Organization" | "Enterprise";
  repository_selection: "all" | "selected";
  suspended_at: Date | null;
  deleted_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RepositoriesTable {
  id: number;
  installation_id: number;
  full_name: string;
  private: boolean;
  default_branch: string | null;
  removed_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TasksTable {
  id: Generated<string>;
  repository_id: number;
  external_id: string;
  issue_number: number | null;
  issue_url: string | null;
  goal: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChangesTable {
  id: Generated<string>;
  repository_id: number;
  pr_number: number;
  pr_node_id: string;
  task_id: string | null;
  head_sha: string;
  base_ref: string;
  author_login: string;
  state: "open" | "closed" | "merged";
  merge_commit_sha: string | null;
  opened_at: Date;
  closed_at: Date | null;
  merged_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProvenanceTable {
  id: Generated<string>;
  change_id: string;
  source: "trailer" | "mcp";
  commit_sha: string | null;
  agent: string | null;
  model: string | null;
  task_external_id: string | null;
  session_url: string | null;
  created_at: CreatedAt;
}

export interface IntentCardsTable {
  id: Generated<string>;
  change_id: string;
  head_sha: string;
  prompt_version: string;
  goal: string;
  behavior_changes: Json<string[]>;
  out_of_scope_edits: Json<string[]>;
  risk_class: RiskClass;
  risk_floor: RiskClass;
  model_risk_class: RiskClass | null;
  verifier_status: "pending" | "agree" | "disagree" | "error";
  verifier_notes: string | null;
  writer_model: string;
  verifier_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  comment_id: number | null;
  check_run_id: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PolicyVerdictsTable {
  id: Generated<string>;
  change_id: string;
  head_sha: string;
  policy_sha: string | null;
  mode: "report" | "enforce";
  status: "pending" | "pass" | "fail" | "blocked" | "error";
  check_conclusion: "success" | "failure" | "neutral" | "action_required" | null;
  risk_class: RiskClass | null;
  rules_matched: Json<unknown[]>;
  approvals_required: Json<Record<string, unknown>>;
  approvals_present: Json<Record<string, unknown>>;
  check_run_id: number | null;
  evaluated_at: Timestamp;
  created_at: CreatedAt;
}

export interface GuardEventsTable {
  id: Generated<string>;
  repository_id: number;
  branch: string;
  failing_sha: string;
  ci_run_url: string | null;
  culprit_change_id: string | null;
  revert_pr_number: number | null;
  status: "detected" | "culprit_found" | "revert_opened" | "reverted" | "dismissed" | "error";
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebhookDeliveriesTable {
  delivery_id: string;
  event: string;
  action: string | null;
  installation_id: number | null;
  repository_id: number | null;
  status: "enqueued" | "ignored";
  job_id: string | null;
  received_at: Timestamp;
}

export interface Database {
  installations: InstallationsTable;
  repositories: RepositoriesTable;
  tasks: TasksTable;
  changes: ChangesTable;
  provenance: ProvenanceTable;
  intent_cards: IntentCardsTable;
  policy_verdicts: PolicyVerdictsTable;
  guard_events: GuardEventsTable;
  webhook_deliveries: WebhookDeliveriesTable;
}

export const TABLE_NAMES = [
  "installations",
  "repositories",
  "tasks",
  "changes",
  "provenance",
  "intent_cards",
  "policy_verdicts",
  "guard_events",
  "webhook_deliveries",
] as const satisfies readonly (keyof Database)[];
