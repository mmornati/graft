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
  /** Permission name to level, from `GET /app/installations/{id}` (Phase 1 step 1). */
  permissions: Json<Record<string, "read" | "write" | "admin">>;
  /** NULL: never read, which counts as "permission missing". */
  permissions_read_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
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
  /** Requested modes (Phase 1 step 1); the effective mode is computed, never stored. */
  policy_mode: Generated<"report" | "enforce">;
  guard_mode: Generated<"report" | "enforce">;
  mcp_write: Generated<"off" | "on">;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Audit of `graft mode set`; `applied_at` is NULL until the worker has acted on the change. */
export interface ModeChangesTable {
  id: Generated<string>;
  repository_id: number;
  key: "policy_mode" | "guard_mode" | "mcp_write";
  from_value: string;
  to_value: string;
  actor: string;
  reason: string;
  created_at: Timestamp;
  applied_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/** Server facts, not installation data (the ceiling the worker last published). */
export interface ServiceStateTable {
  key: string;
  value: string;
  updated_at: Date;
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
  /** The author's immutable user id (null until the pull is next upserted). */
  author_id: ColumnType<number | null, number | null | undefined, number | null>;
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
  /** Step 6: USD at spend time; NULL = unpriced (unknown model, or a row from before 0006). */
  cost_usd: ColumnType<string | null, string | number | null | undefined, string | number | null>;
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
/** `policy_verdicts.enforced_reason` (0009); the same values as `EnforcedReason` in src/policy. */
export type EnforcedReasonColumn =
  | "approved_by_policy"
  | "requirements_met"
  | "no_policy"
  | "policy_invalid"
  | "blocked"
  | "reviews_truncated"
  | "changes_requested"
  | "approvals_missing"
  | "card_pending"
  /** Phase 1 step 3 (0010). */
  | "break_glass";

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
  /** The effective `policy_mode` the verdict was published under (Phase 1 step 1). */
  policy_mode: Generated<"report" | "enforce">;
  outcome: "would_approve" | "would_require" | "would_block" | "no_policy" | "policy_invalid";
  /** What was published (D10 of Phase 1 step 2); `pending` = published `in_progress`. */
  check_conclusion: Generated<"neutral" | "success" | "failure" | "action_required" | "pending">;
  /** What enforce mode would publish, in every mode; NULL on rows from before step 2. */
  enforced_conclusion: ColumnType<
    "success" | "failure" | "pending" | null,
    "success" | "failure" | "pending" | null | undefined,
    "success" | "failure" | "pending" | null
  >;
  enforced_reason: ColumnType<
    EnforcedReasonColumn | null,
    EnforcedReasonColumn | null | undefined,
    EnforcedReasonColumn | null
  >;
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

/**
 * Phase 1 step 3 (spec §5): one row per break-glass request Graft acted on. Append-only: rows are
 * never updated, and deleted only by `pilot purge`. Logins are stored because an audit trail must
 * say who; the label name is configuration and is not stored.
 */
export interface AuditLogTable {
  id: Generated<string>;
  repository_id: number;
  change_id: string;
  pr_number: number;
  head_sha: string;
  kind: "applied" | "ignored" | "stale" | "removed";
  /** Set iff `kind` is `ignored` or `stale`. */
  reason: "role_too_low" | "bot" | "role_unverified" | "actor_unknown" | "head_moved" | null;
  actor_id: number | null;
  actor_login: string | null;
  actor_role: "admin" | "maintain" | "write" | "triage" | "read" | "none" | null;
  self: Generated<boolean>;
  policy_mode: "report" | "enforce";
  label_event_at: Date | null;
  created_at: Date;
}

export type GuardEventStatus =
  | "detected"
  | "confirming"
  | "culprit_found"
  | "ambiguous"
  | "no_culprit"
  | "flaky"
  | "revert_opened"
  | "reverted"
  | "dismissed"
  | "error";

/** Phase 1 step 4: one failing check of a guard event (at most 20 per event). */
export interface GuardFailingCheck {
  key: string;
  name: string;
  source: "check_run" | "status";
}

/** Phase 1 step 4: one candidate commit of a guard event (at most 50 per event). */
export interface GuardCandidate {
  sha: string;
  prNumber: number | null;
  kind: "pr" | "direct" | "multiple" | "unresolved" | "truncated";
}

export interface GuardEventsTable {
  id: Generated<string>;
  repository_id: number;
  branch: string;
  failing_sha: string;
  ci_run_url: string | null;
  culprit_change_id: string | null;
  revert_pr_number: number | null;
  status: GuardEventStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Phase 1 step 4 (0011). */
  last_green_sha: string | null;
  failing_checks: Json<GuardFailingCheck[]>;
  candidates: Json<GuardCandidate[]>;
  detected_at: Date | null;
  confirmed_at: Date | null;
  confirm_reason: "next_commit" | "window" | "off" | "flaky_rerun" | "flaky_next" | null;
  comment_id: number | null;
  guard_mode: "report" | "enforce" | null;
}

/** Phase 1 step 4: the first-parent history of each default branch (no messages, no files). */
export interface MainCommitsTable {
  repository_id: number;
  sha: string;
  parent_sha: string | null;
  seq: number;
  chain_break: Generated<boolean>;
  pr_source: "change" | "api" | "direct" | "multiple" | "unresolved";
  change_id: string | null;
  pr_number: number | null;
  committed_at: Date | null;
  tracked_at: Date;
}

/** Phase 1 step 4: the latest result class per (commit, check). Never output or logs. */
export interface CiResultsTable {
  repository_id: number;
  sha: string;
  key: string;
  name: string;
  source: "check_run" | "status";
  class: "green" | "red" | "ignored";
  filtered: Generated<boolean>;
  html_url: string | null;
  completed_at: Date | null;
  observed_at: Date;
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

/** Step 6. Reviewers (by user id) seen for a change while Graft watched; never deleted. */
export interface PrReviewersTable {
  change_id: string;
  user_id: number;
  reason: "requested" | "reviewed";
  first_seen_at: Date;
  /** Passed the reviewer sync's standing checks; the gate counts only these rows. */
  verified: Generated<boolean>;
}

/** Fail-closed permission checks (403/404) of the last reviewer sync, by user id. */
export interface ReviewerCheckDenialsTable {
  change_id: string;
  user_id: number;
  status: 403 | 404;
  checked_at: Date;
}

export interface ReviewTimeRunsTable {
  id: Generated<string>;
  repository_id: number;
  period: "baseline" | "shadow";
  from_date: ColumnType<string, string | Date, string | Date>;
  to_date: ColumnType<string, string | Date, string | Date>;
  base_ref: string;
  extractor_version: number;
  pr_count: number;
  excluded_count: number;
  aggregates: Json<unknown>;
  requests: number;
  extracted_at: Date;
}

/** Numbers and flags per PR: no title, body, path, login or SHA (D3). */
export interface ReviewTimePrsTable {
  run_id: string;
  pr_number: number;
  state: "merged" | "closed" | "open";
  author_kind: "agent" | "human";
  author_kind_reason: string;
  size_bucket: "S" | "M" | "L" | "XL";
  start_basis: "review_requested" | "ready_for_review" | "opened";
  minutes_to_first_approval: ColumnType<
    string | null,
    string | number | null,
    string | number | null
  >;
  minutes_to_merge: ColumnType<string | null, string | number | null, string | number | null>;
  review_rounds: number;
  merged_without_review: boolean;
  paused_minutes: ColumnType<string, string | number, string | number>;
  excluded_reason: "excluded_author" | "timeline_truncated" | "commits_truncated" | null;
}

export interface IncidentsTable {
  id: Generated<string>;
  repository_id: number;
  culprit_pr_number: number | null;
  fix_pr_number: number | null;
  source: "cli" | "label";
  severity: number | null;
  occurred_at: Date;
  recorded_at: Date;
}

export interface MetricsDailyTable {
  repository_id: number;
  day: ColumnType<string, string | Date, string | Date>;
  rollup_version: number;
  counts: Json<Record<string, number | string>>;
  computed_at: Date;
}

/** No foreign key: outlives the purge. Holds the installation id and counts only. */
export interface PilotPurgesTable {
  id: Generated<string>;
  installation_id: number;
  rows_deleted: Json<Record<string, number>>;
  purged_at: Date;
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
  pr_reviewers: PrReviewersTable;
  reviewer_check_denials: ReviewerCheckDenialsTable;
  review_time_runs: ReviewTimeRunsTable;
  review_time_prs: ReviewTimePrsTable;
  incidents: IncidentsTable;
  metrics_daily: MetricsDailyTable;
  pilot_purges: PilotPurgesTable;
  mode_changes: ModeChangesTable;
  service_state: ServiceStateTable;
  audit_log: AuditLogTable;
  main_commits: MainCommitsTable;
  ci_results: CiResultsTable;
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
  "pr_reviewers",
  "reviewer_check_denials",
  "review_time_runs",
  "review_time_prs",
  "incidents",
  "metrics_daily",
  "pilot_purges",
  "mode_changes",
  "service_state",
  "audit_log",
  "main_commits",
  "ci_results",
] as const satisfies readonly (keyof Database)[];
