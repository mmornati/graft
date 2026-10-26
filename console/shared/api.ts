// The BFF's JSON contract, shared by the server and the web app. Every field comes from a column Graft
// already stores: ids, numbers, SHAs, paths, logins and the models' own prose. Never a PR title, body
// or diff, because Graft never stores them.

export type RiskClass = "trivial" | "logic" | "sensitive";
export type VerifierStatus = "agree" | "disagree" | "error" | "skipped";
export type PolicyOutcome =
  | "would_approve"
  | "would_require"
  | "would_block"
  | "no_policy"
  | "policy_invalid";
export type Mode = "report" | "enforce";

export interface Me {
  login: string;
  auth: "github" | "none";
}

export interface DaySummary {
  /** Local date in the requested time zone, `YYYY-MM-DD`. */
  date: string;
  prsOpened: number;
  prsMerged: number;
  cards: number;
  cardsUnavailable: number;
  cardsBudget: number;
  verifierAgree: number;
  verifierDisagree: number;
  deliveries: number;
  deliveriesIgnored: number;
  tokens: number;
  costUsd: number;
  guardEvents: number;
  guardNeedsHuman: number;
  repositories: number;
}

export interface DaysResponse {
  timeZone: string;
  today: string;
  installedAt: string | null;
  days: DaySummary[];
}

export interface CardVersion {
  id: string;
  at: string;
  headSha: string;
  status: "ok" | "unavailable";
  failureReason: string | null;
  riskClass: RiskClass;
  riskFloor: RiskClass;
  verifierStatus: VerifierStatus;
}

export interface ChangeEntry {
  kind: "change";
  at: string;
  changeId: string;
  repo: string;
  prNumber: number;
  state: "open" | "closed" | "merged";
  mergedAt: string | null;
  goal: string | null;
  card: {
    status: "ok" | "unavailable";
    failureReason: string | null;
    riskClass: RiskClass;
    riskFloor: RiskClass;
    verifierStatus: VerifierStatus;
    verifierMissing: number;
    verifierUnexplained: number;
    filesTotal: number;
    linesAdded: number;
    linesDeleted: number;
  } | null;
  /** Card versions written on this day, oldest first. */
  versions: CardVersion[];
  policyOutcome: PolicyOutcome | null;
  guardStatus: string | null;
  authorKind: "agent" | "human" | null;
}

export interface GuardEntry {
  kind: "guard";
  at: string;
  eventId: string;
  repo: string;
  branch: string;
  status: string;
  failingSha: string;
  culpritPr: number | null;
  failingChecks: string[];
  revertOutcome: string | null;
  revertReason: string | null;
  revertPr: number | null;
  ciRunUrl: string | null;
}

export interface AuditEntry {
  kind: "break_glass";
  at: string;
  repo: string;
  prNumber: number;
  auditKind: "applied" | "ignored" | "stale" | "removed";
  reason: string | null;
  actor: string | null;
}

export interface ModeEntry {
  kind: "mode";
  at: string;
  repo: string;
  key: string;
  from: string;
  to: string;
  actor: string;
  applied: boolean;
}

export type Entry = ChangeEntry | GuardEntry | AuditEntry | ModeEntry;

export interface DayResponse {
  timeZone: string;
  summary: DaySummary;
  entries: Entry[];
}

export interface Attention {
  id: string;
  kind: "guard" | "policy" | "budget" | "llm" | "gate" | "installation" | "mode" | "jobs";
  severity: "act" | "watch";
  at: string | null;
  title: string;
  detail: string;
  command: string | null;
  link: string | null;
  repo: string | null;
}

export interface BudgetRepo {
  repo: string;
  todayTokens: number;
  budget: number;
  days: { date: string; tokens: number; skipped: number }[];
}

export interface GateStats {
  votes: number;
  authorVotes: number;
  eligibleUp: number;
  eligibleDown: number;
  /** Wilson 95% interval of eligible up / (up + down); null without an eligible vote. */
  interval: { low: number; high: number } | null;
  target: number;
}

export interface OverviewResponse {
  installations: {
    id: number;
    login: string;
    type: string;
    selection: string;
    suspended: boolean;
    permissionsReadAt: string | null;
  }[];
  repositories: {
    id: number;
    fullName: string;
    policyMode: Mode;
    guardMode: Mode;
    mcpWrite: "off" | "on";
    removed: boolean;
  }[];
  ceiling: { value: string; updatedAt: string } | null;
  attention: Attention[];
  totals: {
    cards: number;
    cardsUnavailable: number;
    cardsBudget: number;
    verifierAgree: number;
    verifierJudged: number;
    raised: number;
    costUsd: number;
    spendRuns: number;
  };
  budget: BudgetRepo[];
  gate: GateStats;
}

export interface RegisterRow {
  changeId: string;
  repo: string;
  prNumber: number;
  state: "open" | "closed" | "merged";
  openedAt: string;
  mergedAt: string | null;
  authorKind: "agent" | "human" | null;
  authorReason: string | null;
  agent: string | null;
  model: string | null;
  cards: number;
  riskClass: RiskClass | null;
  riskFloor: RiskClass | null;
  verifierStatus: VerifierStatus | null;
  cardStatus: "ok" | "unavailable" | null;
  policyOutcome: PolicyOutcome | null;
  guardStatus: string | null;
}

export interface RegisterResponse {
  rows: RegisterRow[];
  nextCursor: string | null;
}

export interface CardDetail extends CardVersion {
  goal: string | null;
  behaviorChanges: string[];
  outOfScope: { path: string; reason: string }[];
  floorReasons: { rule: string; floor: string; count: number; paths: string[] }[];
  modelRiskClass: RiskClass | null;
  modelRiskReason: string | null;
  verifierRiskClass: RiskClass | null;
  riskRaisedBy: string[];
  verifierFailure: string | null;
  verifierMissing: string[];
  verifierUnexplained: string[];
  instructionsInData: boolean;
  writerModel: string | null;
  verifierModel: string | null;
  tokens: number;
  llmCalls: number;
  filesTotal: number;
  linesAdded: number;
  linesDeleted: number;
  inputsTruncated: boolean;
  publishedAt: string | null;
}

export interface ChangeRecord {
  changeId: string;
  repo: string;
  prNumber: number;
  state: "open" | "closed" | "merged";
  baseRef: string;
  headSha: string;
  authorLogin: string;
  openedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  task: { externalId: string; issueNumber: number | null; issueUrl: string | null } | null;
  provenance: {
    authorKind: "agent" | "human";
    reason: string;
    agent: string | null;
    model: string | null;
    task: string | null;
    sessionUrl: string | null;
    commitsTotal: number;
    commitsWithTrailers: number;
    agentCoauthorCommits: number;
    warnings: number;
    mcpReport: string;
  } | null;
  cards: CardDetail[];
  verdict: {
    outcome: PolicyOutcome;
    policyStatus: "ok" | "missing" | "invalid";
    policyMode: Mode;
    checkConclusion: string;
    enforcedConclusion: string | null;
    enforcedReason: string | null;
    riskClass: RiskClass | null;
    rulesMatched: number;
    errors: number;
    evaluatedAt: string;
    evaluations: number;
  } | null;
  guardEvents: {
    id: string;
    status: string;
    branch: string;
    at: string;
    revertPr: number | null;
  }[];
  breakGlass: { kind: string; reason: string | null; actor: string | null; at: string }[];
  feedback: { up: number; down: number; byAuthor: number };
}

export interface SystemResponse {
  hours: number;
  schemaVersion: string | null;
  jobs:
    | {
        name: string;
        completed: number;
        failed: number;
        active: number;
        waiting: number;
        oldestWaitingSeconds: number | null;
      }[]
    | null;
  jobsUnavailable: string | null;
  webhooks: { event: string; status: "enqueued" | "ignored"; count: number }[];
  modeChanges: {
    at: string;
    repo: string;
    key: string;
    from: string;
    to: string;
    actor: string;
    appliedAt: string | null;
  }[];
  audit: {
    at: string;
    repo: string;
    prNumber: number;
    kind: string;
    reason: string | null;
    actor: string | null;
  }[];
  mcpTokens: {
    id: string;
    repo: string;
    name: string;
    prefix: string;
    createdBy: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }[];
  purges: { at: string; installationId: number; rows: number }[];
  console: { version: string; readOnly: boolean; dailyTokenBudget: number };
}

export interface ApiError {
  error: string;
  message: string;
}
