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
  /** GitHub `updated_at` of the applied snapshot (ordering guard). */
  pr_updated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  author_is_bot: Generated<boolean>;
  /** The Graft-managed PR comment. */
  graft_comment_id: ColumnType<number | null, number | null | undefined, number | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProvenanceTable {
  id: Generated<string>;
  change_id: string;
  source: "trailer" | "pr_body" | "mcp";
  commit_sha: string | null;
  agent: string | null;
  model: string | null;
  task_external_id: string | null;
  session_url: string | null;
  created_at: CreatedAt;
}

export type ProvenanceFieldName = "agent" | "model" | "task" | "session";
/** Same set under the name the provenance module uses. */
export type GraftField = ProvenanceFieldName;
export type WarningCode =
  | "invalid_value"
  | "value_too_long"
  | "empty_value"
  | "duplicate_key"
  | "unknown_graft_key"
  | "invalid_session_url"
  | "message_truncated"
  | "block_too_long";

export interface FieldSource {
  source: "commit" | "pr_body";
  commitSha?: string;
}

export interface StoredWarning {
  code: WarningCode;
  field?: ProvenanceFieldName;
  commitSha?: string;
  source: "commit" | "pr_body";
}

export interface ChangeProvenanceTable {
  change_id: string;
  head_sha: string;
  author_kind: "agent" | "human";
  author_kind_reason: "trailer" | "bot_account" | "configured_login" | "agent_coauthor" | "none";
  agent: string | null;
  model: string | null;
  task_external_id: string | null;
  session_url: string | null;
  field_sources: Json<Partial<Record<ProvenanceFieldName, FieldSource>>>;
  conflicts: Json<Partial<Record<ProvenanceFieldName, string[]>>>;
  warnings: Json<StoredWarning[]>;
  commits_total: number;
  commits_scanned: number;
  commits_with_trailers: number;
  agent_coauthor_commits: number;
  commits_truncated: Generated<boolean>;
  check_run_id: number | null;
  computed_at: Date;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type IntentFailureReason =
  | "not_configured"
  | "budget_exceeded"
  | "too_large"
  | "llm_timeout"
  | "llm_rate_limited"
  | "llm_unavailable"
  | "llm_auth"
  | "llm_bad_request"
  | "llm_refusal"
  | "invalid_output"
  | "deadline_exceeded";

/** timestamptz / bigint / integer column that has a database default. */
type Optional<T> = ColumnType<T, T | undefined, T>;

/** Model-written prose and paths only: no diff, patch, PR body or issue text (README §5). */
export interface IntentCardsTable {
  id: Generated<string>;
  change_id: string;
  head_sha: string;
  prompt_version: string;
  input_hash: string;
  status: "ok" | "unavailable";
  failure_reason: IntentFailureReason | null;
  goal: string | null;
  behavior_changes: Json<string[]>;
  out_of_scope_edits: Json<{ path: string; reason: string }[]>;
  /** Final class. */
  risk_class: RiskClass;
  risk_floor: RiskClass;
  floor_reasons: Json<unknown[]>;
  model_risk_class: RiskClass | null;
  model_risk_reason: string | null;
  first_pass_risk_class: RiskClass | null;
  verifier_risk_class: RiskClass | null;
  risk_raised_by: Json<string[]>;
  verifier_status: "agree" | "disagree" | "error" | "skipped";
  verifier_failure: string | null;
  verifier_claims: Json<unknown[]>;
  verifier_missing: Json<string[]>;
  verifier_unexplained: Json<string[]>;
  instructions_in_data: Optional<boolean>;
  writer_model: string | null;
  first_pass_model: string | null;
  verifier_model: string | null;
  llm_calls: Optional<number>;
  input_tokens: Optional<number>;
  output_tokens: Optional<number>;
  cache_read_tokens: Optional<number>;
  cache_write_tokens: Optional<number>;
  files_total: number;
  files_listed: number;
  files_full: number;
  files_partial: number;
  files_omitted: number;
  omitted_files: Json<{ path: string; reason: string }[]>;
  lines_added: number;
  lines_deleted: number;
  inputs_truncated: boolean;
  linked_issue_number: number | null;
  comment_id: ColumnType<number | null, number | null | undefined, number | null>;
  check_run_id: ColumnType<number | null, number | null | undefined, number | null>;
  published_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface IntentFeedbackTable {
  id: Generated<string>;
  card_id: string;
  change_id: string;
  user_id: number;
  user_login: string;
  verdict: "up" | "down";
  source: "reaction" | "check_action";
  reacted_at: Date;
  is_pr_author: Optional<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface IntentSpendTable {
  id: Generated<string>;
  repository_id: number;
  change_id: string | null;
  tokens: number;
  llm_calls: Optional<number>;
  spent_at: Date;
}

export interface IntentDisplaysTable {
  id: Generated<string>;
  /** Insertion order: breaks ties between displays with the same `shown_at`. */
  seq: Generated<number>;
  change_id: string;
  card_id: string;
  /** `pending` is the "outdated" note shown after a push (attributed like `unavailable`). */
  status: "ok" | "unavailable" | "pending";
  shown_at: Date;
}

/**
 * Step 5 (spec §11). Rule indices, reason codes, PR paths (at most 5 per reason), counts, SHAs,
 * logins and the policy hash. Never globs, rule names, team slugs or YAML text.
 */
export interface PolicyVerdictsTable {
  id: Generated<string>;
  change_id: string;
  head_sha: string;
  base_ref: string;
  policy_commit_sha: string;
  /** NULL: no file (missing, directory). */
  policy_file_sha: string | null;
  policy_status: "ok" | "missing" | "invalid";
  /** Set iff `policy_status` is `ok`. */
  policy_hash: string | null;
  mode: Generated<"report" | "enforce">;
  outcome: "would_approve" | "would_require" | "would_block" | "no_policy" | "policy_invalid";
  check_conclusion: Generated<"neutral" | "success" | "failure" | "action_required">;
  risk_class: RiskClass | null;
  risk_final: Generated<boolean>;
  risk_source: "card" | "card_unavailable" | "card_pending" | null;
  author_kind: "agent" | "human" | "unknown" | null;
  policy_file_changed: Generated<boolean>;
  rules_matched: Json<unknown[]>;
  required: Json<Record<string, unknown>>;
  approvals: Json<Record<string, unknown>>;
  errors: Json<unknown[]>;
  facts_hash: string;
  facts_read_at: Date;
  check_run_id: number | null;
  published_at: Date | null;
  evaluated_at: Date;
  created_at: CreatedAt;
  updated_at: Timestamp;
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
  change_provenance: ChangeProvenanceTable;
  intent_cards: IntentCardsTable;
  intent_feedback: IntentFeedbackTable;
  intent_spend: IntentSpendTable;
  intent_displays: IntentDisplaysTable;
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
  "change_provenance",
  "intent_cards",
  "intent_feedback",
  "intent_spend",
  "intent_displays",
  "policy_verdicts",
  "guard_events",
  "webhook_deliveries",
] as const satisfies readonly (keyof Database)[];
