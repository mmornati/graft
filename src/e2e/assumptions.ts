/**
 * Assumption checks (§8, T11). Each check is a pure evaluator over evidence collected by probes
 * and scenarios: `{ id, status, evidence }`. Evidence is a small JSON object (at most 2 KB after
 * redaction) of status codes, ids, booleans, field names and enum values; never PR text.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { classifyGitHubError } from "../github/errors.js";
import { normalizeEvent } from "../pilot/baseline.js";
import { deliveryPayload, listDeliveries } from "./hooks.js";
import { changeRow, type PrObs } from "./observe.js";
import type { AssumptionResult } from "./report-schema.js";
import type { SecretRegistry } from "./secrets.js";
import type { RunCtx } from "./types.js";

export interface AssumptionDef {
  id: string;
  title: string;
  /** HUMAN-TODO anchor, or null. */
  anchor: string | null;
  /** Scenarios whose status decides `skipped`. */
  requires: string[];
}

export const ASSUMPTIONS: readonly AssumptionDef[] = [
  {
    id: "A01",
    title: "Comments created by the App carry performed_via_github_app.id",
    anchor: "s2-performed-via",
    requires: ["s01"],
  },
  {
    id: "A02",
    title: "The bot-login fallback would match",
    anchor: "s2-performed-via",
    requires: ["s01"],
  },
  {
    id: "A03",
    title: "Reactions are readable with the App's permissions",
    anchor: "s3-outputs",
    requires: ["s08"],
  },
  {
    id: "A04",
    title: "A thumbs-up is recorded by the scheduled poll within 15 minutes",
    anchor: "s3-outputs",
    requires: ["s08"],
  },
  { id: "A05", title: "The buttons show on graft/intent", anchor: "s3-outputs", requires: ["s08"] },
  {
    id: "A06",
    title: "A button click is delivered and recorded",
    anchor: "s3-outputs",
    requires: ["s08"],
  },
  { id: "A07", title: "What an outsider's click does", anchor: null, requires: ["s08"] },
  {
    id: "A08",
    title: "metadata: read suffices for the permission endpoint",
    anchor: "s6-backfill",
    requires: [],
  },
  {
    id: "A09",
    title: "The installation has the manifest's permissions and events",
    anchor: "s5-events",
    requires: [],
  },
  { id: "A10", title: "pull_request_review events arrive", anchor: "s5-events", requires: ["s07"] },
  { id: "A11", title: "push events arrive", anchor: "s5-events", requires: [] },
  {
    id: "A12",
    title: "A push to main editing graft.yaml re-evaluates open PRs",
    anchor: "s5-check-github",
    requires: ["s09"],
  },
  {
    id: "A13",
    title: "Timeline event shapes match the fakes",
    anchor: "s6-baseline-github",
    requires: ["s07"],
  },
  {
    id: "A14",
    title: "git/ref/heads%2F<branch> is accepted",
    anchor: "s5-check-github",
    requires: ["s01"],
  },
  { id: "A15", title: "Alert blocks render", anchor: "s5-check-github", requires: ["s05"] },
  {
    id: "A16",
    title: "No mention renders from Graft's comment",
    anchor: "s5-check-github",
    requires: ["s02", "s04"],
  },
  {
    id: "A17",
    title: "Deliveries are listable with the JWT and a redelivery is a duplicate",
    anchor: "s6-redelivery",
    requires: ["s10"],
  },
  { id: "A18", title: "github.webhook retention is 1 hour", anchor: "s6-retention", requires: [] },
  { id: "A19", title: "Model access and pricing", anchor: "s3-model-access", requires: ["s01"] },
  { id: "A20", title: "Installation webhooks create the rows", anchor: "s1-install", requires: [] },
  {
    id: "A21",
    title: "Rate-limit headers are present",
    anchor: "s6-baseline-github",
    requires: [],
  },
];

/** Extra scenarios that must pass before an anchor may be ticked. */
export const ANCHOR_EXTRA_REQUIRES: Record<string, string[]> = { "s6-baseline-github": ["b1"] };

/**
 * What a passing run proves for each HUMAN-TODO item. `tick`: the item IS the check, so the box
 * is ticked. `note`: the item is a deployment or pilot action (install on the org, update an
 * existing App, backfill after a deploy, check retention after the first deploy, compare a pilot
 * repository by hand); a sandbox run only adds an "observed in sandbox" note and leaves the box.
 */
export const ANCHOR_KIND: Record<string, "tick" | "note"> = {
  "s1-install": "note",
  "s2-performed-via": "tick",
  "s3-model-access": "tick",
  "s3-outputs": "tick",
  "s5-events": "note",
  "s5-check-github": "tick",
  "s6-backfill": "note",
  "s6-retention": "note",
  "s6-baseline-github": "note",
  "s6-redelivery": "tick",
};

export const ANCHORS: readonly string[] = [
  ...new Set(ASSUMPTIONS.map((a) => a.anchor).filter((a): a is string => a !== null)),
];

export type Evidence = Record<string, Record<string, unknown>>;

export interface EvalInput {
  evidence: Evidence;
  /** Status of each scenario that was part of the run. */
  scenarios: Record<string, "pass" | "fail" | "skipped" | undefined>;
  interactive: boolean;
  waitCron: boolean;
  llmMode: "live" | "none" | undefined;
  appId: number;
  slug: string | undefined;
  models: { fast: string; strong: string };
  manifest: { permissions: Record<string, string>; events: string[] };
}

type Verdict = Pick<AssumptionResult, "status" | "evidence">;
const pass = (evidence: unknown): Verdict => ({ status: "pass", evidence });
const fail = (evidence: unknown): Verdict => ({ status: "fail", evidence });
const unverified = (evidence: unknown): Verdict => ({ status: "unverified", evidence });
const bool = (v: unknown): boolean => v === true;

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
}

const EVALUATORS: Record<string, (i: EvalInput, e: Record<string, unknown>) => Verdict> = {
  A01(i, e) {
    // Strict: a number compared to a number (a string "123" is a defect, not a match).
    const ok = e.probe === i.appId && e.actor === i.appId;
    return ok ? pass(e) : fail(e);
  },
  A02(i, e) {
    if (i.slug === undefined)
      return unverified({ ...e, note: "set GITHUB_APP_SLUG to check the login" });
    return e.type === "Bot" && e.login === `${i.slug}[bot]` ? pass(e) : fail(e);
  },
  A03(_i, e) {
    return e.status === 200 && bool(e.actorListed) ? pass(e) : fail(e);
  },
  A04(i, e) {
    if (!i.waitCron) return unverified({ note: "cron path not exercised" });
    return bool(e.rowPresent) ? pass(e) : fail(e);
  },
  A05(i, e) {
    if (!i.interactive) return unverified({ note: "needs --interactive" });
    return e.answer === "y" ? pass(e) : fail(e);
  },
  A06(i, e) {
    if (!i.interactive) return unverified({ note: "needs --interactive" });
    if (e.answer !== "y") return unverified({ ...e, note: "buttons were not visible" });
    return bool(e.delivered) && bool(e.recorded) ? pass(e) : fail(e);
  },
  A07(i, e) {
    if (!i.interactive) return unverified({ note: "needs --interactive" });
    return e.outcome !== undefined && e.outcome !== null ? pass(e) : unverified(e);
  },
  A08(_i, e) {
    const s08 = e.s08 as { verified: boolean; denials: number } | null | undefined;
    const base = e.status === 200 && e.permission === "admin";
    const withS08 = s08 === null || s08 === undefined || (s08.verified && s08.denials === 0);
    return base && withS08 ? pass(e) : fail(e);
  },
  A09(i, e) {
    const perms = (e.permissions ?? {}) as Record<string, string>;
    const events = (e.events ?? []) as string[];
    const want = Object.keys(i.manifest.permissions);
    const ok =
      e.status === 200 &&
      sameSet(Object.keys(perms), want) &&
      want.every((k) => perms[k] === i.manifest.permissions[k]) &&
      i.manifest.events.every((x) => events.includes(x)) &&
      e.repositorySelection === "selected";
    return ok ? pass(e) : fail(e);
  },
  A10(_i, e) {
    return (e.count as number) > 0 ? pass(e) : fail(e);
  },
  A11(_i, e) {
    const want = (e.want ?? []) as string[];
    const seen = (e.refs ?? []) as string[];
    return want.length > 0 && want.every((r) => seen.includes(r)) ? pass(e) : fail(e);
  },
  A12(i, e) {
    return i.scenarios.s09 === "pass" && bool(e.listsGraftYaml) ? pass(e) : fail(e);
  },
  A13(_i, e) {
    if (e.status !== 200) return fail(e);
    const kinds = (e.kinds ?? {}) as Record<string, { seen: boolean; normalized: boolean }>;
    const need = ["review_requested", "reviewed", "ready_for_review"];
    const seen = need.filter((k) => kinds[k]?.seen);
    if (seen.some((k) => !kinds[k]?.normalized)) return fail(e);
    return seen.length === need.length ? pass(e) : unverified(e);
  },
  A14(_i, e) {
    return e.status === 200 && e.policyStatus === "ok" ? pass(e) : fail(e);
  },
  A15(_i, e) {
    return bool(e.s05) && (e.s03 === null || e.s03 === undefined || bool(e.s03))
      ? pass(e)
      : fail(e);
  },
  A16(_i, e) {
    return bool(e.s02Clean) && bool(e.s04Clean) && bool(e.control) ? pass(e) : fail(e);
  },
  A17(i, e) {
    if (e.listStatus !== 200) return fail(e);
    if (!bool(e.sameGuid)) {
      return i.scenarios.s10 === "pass"
        ? fail({ ...e, note: "redelivery uses a new guid; Graft converged" })
        : fail(e);
    }
    return i.scenarios.s10 === "pass" ? pass(e) : fail(e);
  },
  A18(_i, e) {
    if (e.deletionSeconds !== 3600) return fail(e);
    if (!bool(e.afterRetention)) return unverified({ ...e, note: "run verify --after-retention" });
    return e.remaining === 0 ? pass(e) : fail(e);
  },
  A19(i, e) {
    if (i.llmMode === "none") return { status: "skipped", evidence: { note: "mode none" } };
    const models = [e.writerModel, e.firstPassModel, e.verifierModel].filter(
      (m): m is string => typeof m === "string",
    );
    const known = models.every((m) => m.startsWith(i.models.fast) || m.startsWith(i.models.strong));
    return models.length > 0 && known && e.costNull === false ? pass(e) : fail(e);
  },
  A20(_i, e) {
    return bool(e.installation) && bool(e.repository) ? pass(e) : fail(e);
  },
  A21(_i, e) {
    return bool(e.limit) && bool(e.remaining) && bool(e.reset) ? pass(e) : fail(e);
  },
};

/** Applies the skipped/unverified rules of §8 around each evaluator. */
export function evaluateAssumptions(input: EvalInput): AssumptionResult[] {
  return ASSUMPTIONS.map((def) => {
    const base = { id: def.id, title: def.title, anchor: def.anchor };
    const notReached = def.requires.filter((s) => {
      const st = input.scenarios[s];
      return st === undefined || st === "skipped";
    });
    if (notReached.length > 0) {
      return { ...base, status: "skipped" as const, evidence: { skippedBecause: notReached } };
    }
    if (def.id === "A11") {
      const e = input.evidence.A11 ?? {};
      if (((e.want ?? []) as string[]).length === 0) {
        return {
          ...base,
          status: "skipped" as const,
          evidence: { skippedBecause: ["s06", "s09"] },
        };
      }
    }
    const evidence = input.evidence[def.id];
    if (evidence === undefined) {
      const needsInteractive = ["A05", "A06", "A07"].includes(def.id);
      return {
        ...base,
        status: needsInteractive || def.id === "A04" ? ("unverified" as const) : ("fail" as const),
        evidence: needsInteractive
          ? { note: "needs --interactive" }
          : { note: "no evidence collected" },
      };
    }
    const evaluate = EVALUATORS[def.id];
    if (!evaluate) return { ...base, status: "fail" as const, evidence: { note: "no evaluator" } };
    const v = evaluate(input, evidence);
    return { ...base, ...v };
  });
}

/** Caps evidence at 2 KB after redaction (T11). */
export function capEvidence(evidence: unknown, secrets: SecretRegistry): unknown {
  const text = secrets.redact(JSON.stringify(evidence ?? null));
  if (text.length <= 2048) return JSON.parse(text);
  return { truncated: true, bytes: text.length };
}

// ---------------------------------------------------------------------------------------------
// Which anchors can be ticked
// ---------------------------------------------------------------------------------------------

export interface HumanTodoStatus {
  anchor: string;
  kind: "tick" | "note";
  assumptions: string[];
  resolvable: boolean;
}

/** An anchor is resolvable only when EVERY assumption mapped to it passed (and its extras ran). */
export function humanTodoStatus(
  results: readonly AssumptionResult[],
  scenarios: Record<string, "pass" | "fail" | "skipped" | undefined>,
): HumanTodoStatus[] {
  return ANCHORS.map((anchor) => {
    const mapped = ASSUMPTIONS.filter((a) => a.anchor === anchor).map((a) => a.id);
    const allPass = mapped.every((id) => results.find((r) => r.id === id)?.status === "pass");
    const extras = (ANCHOR_EXTRA_REQUIRES[anchor] ?? []).every((s) => scenarios[s] === "pass");
    return {
      anchor,
      kind: ANCHOR_KIND[anchor] ?? "note",
      assumptions: mapped,
      resolvable: allPass && extras,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Probes (GET and DB reads only)
// ---------------------------------------------------------------------------------------------

const statusOf = (err: unknown): number | string =>
  typeof (err as { status?: unknown })?.status === "number"
    ? (err as { status: number }).status
    : "error";

async function safe<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; status: number | string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (classifyGitHubError(err) === "rate_limited") throw err;
    return { ok: false, status: statusOf(err) };
  }
}

export async function collectPushEvidence(ctx: RunCtx): Promise<{
  refs: string[];
  listsGraftYaml: boolean;
}> {
  const list = (await listDeliveries(ctx.clients.app, 2)).filter((d) => d.event === "push");
  const refs: string[] = [];
  let listsGraftYaml = false;
  for (const d of list.slice(0, 30)) {
    const payload = (await deliveryPayload(ctx.clients.app, d.id)) as {
      ref?: string;
      repository?: { full_name?: string };
      commits?: { modified?: string[] }[];
    };
    if (payload?.repository?.full_name?.toLowerCase() !== ctx.sandbox.repo.toLowerCase()) continue;
    if (typeof payload.ref === "string") refs.push(payload.ref);
    if (payload.ref === `refs/heads/${ctx.sandbox.defaultBranch}`) {
      if ((payload.commits ?? []).some((c) => (c.modified ?? []).includes("graft.yaml"))) {
        listsGraftYaml = true;
      }
    }
  }
  return { refs: [...new Set(refs)], listsGraftYaml };
}

export type TimelineKinds = Record<string, { seen: boolean; normalized: boolean }>;

export const emptyTimelineKinds = (): TimelineKinds => ({
  review_requested: { seen: false, normalized: false },
  reviewed: { seen: false, normalized: false },
  ready_for_review: { seen: false, normalized: false },
});

/** A13: which kinds of timeline events were seen, and whether Graft's `normalizeEvent` reads each. */
export function addTimelineKinds(
  into: TimelineKinds,
  events: readonly Record<string, unknown>[],
): void {
  for (const raw of events) {
    const kind = String(raw.event);
    const slot = into[kind];
    if (!slot) continue;
    slot.seen = true;
    const n = normalizeEvent(raw);
    if (n !== null && n.kind === kind) slot.normalized = true;
  }
}

export interface CollectInput {
  scenarios: Record<string, "pass" | "fail" | "skipped" | undefined>;
  scope: Record<string, unknown>;
  prior: Evidence;
  afterRetention: boolean;
  runStartedAt: Date;
}

/** Collects what can be re-read: GitHub GETs and database reads. Probe failures are evidence. */
export async function collectEvidence(ctx: RunCtx, input: CollectInput): Promise<Evidence> {
  const ev: Evidence = { ...input.prior };
  const scope = input.scope;
  const pr = (key: string) => scope[key] as { number: number } | undefined;
  const probe = await ctx.clients.probe(ctx.installationId);
  const ran = (s: string) => input.scenarios[s] === "pass" || input.scenarios[s] === "fail";

  // A01, A02
  const pr1 = pr("s01.pr");
  if (pr1 && ran("s01")) {
    const ch = await changeRow(ctx, pr1.number);
    if (ch?.graft_comment_id) {
      const get = (c: typeof probe) =>
        safe(() =>
          c.rest.issues.getComment({
            owner: ctx.owner,
            repo: ctx.repo,
            comment_id: ch.graft_comment_id as number,
          }),
        );
      const [p, a] = [await get(probe), await get(ctx.actorOctokit)];
      ev.A01 = {
        probe: p.ok
          ? ((p.value.data as { performed_via_github_app?: { id: number } | null })
              .performed_via_github_app?.id ?? null)
          : p.status,
        actor: a.ok
          ? ((a.value.data as { performed_via_github_app?: { id: number } | null })
              .performed_via_github_app?.id ?? null)
          : a.status,
      };
      ev.A02 = p.ok
        ? { login: p.value.data.user?.login ?? null, type: p.value.data.user?.type ?? null }
        : { status: p.status };
    }
    const ref = await safe(() =>
      probe.rest.git.getRef({ owner: ctx.owner, repo: ctx.repo, ref: "heads/main" }),
    );
    const v = await ctx.db
      .selectFrom("policy_verdicts")
      .select("policy_status")
      .where("change_id", "=", ch?.id ?? "")
      .orderBy("evaluated_at", "asc")
      .limit(1)
      .executeTakeFirst();
    ev.A14 = {
      status: ref.ok ? ref.value.status : ref.status,
      policyStatus: v?.policy_status ?? null,
    };
    const card = (scope["s01.obs"] as { pr?: PrObs } | undefined)?.pr?.card;
    ev.A19 = {
      writerModel: card?.writerModel ?? null,
      firstPassModel: card?.firstPassModel ?? null,
      verifierModel: card?.verifierModel ?? null,
      costNull: ((scope["s01.obs"] as { pr?: PrObs } | undefined)?.pr?.spend.unpriced ?? 1) > 0,
    };
  }

  // A03, A08 (s08 part), A04, A05, A06, A07
  const pr8 = pr("s08.pr");
  const target = pr8 ?? pr1;
  if (target) {
    const ch = await changeRow(ctx, target.number);
    if (ch?.graft_comment_id) {
      const r = await safe(() =>
        probe.rest.reactions.listForIssueComment({
          owner: ctx.owner,
          repo: ctx.repo,
          comment_id: ch.graft_comment_id as number,
          per_page: 100,
        }),
      );
      if (r.ok) {
        ev.A03 = {
          status: r.value.status,
          count: r.value.data.length,
          actorListed: r.value.data.some((x) => x.user?.id === ctx.actor.id),
        };
      } else ev.A03 = { status: r.status, count: 0, actorListed: false };
    }
  }
  if (pr8 && ran("s08")) {
    const ch = await changeRow(ctx, pr8.number);
    const reviewer = ch
      ? await ctx.db
          .selectFrom("pr_reviewers")
          .select("verified")
          .where("change_id", "=", ch.id)
          .where("user_id", "=", ctx.actor.id)
          .execute()
      : [];
    const denials = ch
      ? await ctx.db
          .selectFrom("reviewer_check_denials")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("change_id", "=", ch.id)
          .where("user_id", "=", ctx.actor.id)
          .executeTakeFirst()
      : undefined;
    ev.A08 = {
      ...(ev.A08 ?? {}),
      s08: { verified: reviewer.some((r) => r.verified), denials: Number(denials?.n ?? 0) },
    };
    ev.A04 = {
      cronExercised: ctx.opts.waitCron,
      rowPresent:
        ch !== undefined &&
        (await ctx.db
          .selectFrom("intent_feedback")
          .select("id")
          .where("change_id", "=", ch.id)
          .where("user_id", "=", ctx.actor.id)
          .where("source", "=", "reaction")
          .executeTakeFirst()) !== undefined,
    };
    if (ctx.opts.interactive) {
      const answer = scope["s08.answer.buttons"];
      const clicks = ch
        ? await ctx.db
            .selectFrom("intent_feedback")
            .select("user_id")
            .where("change_id", "=", ch.id)
            .where("source", "=", "check_action")
            .execute()
        : [];
      const delivered = await ctx.db
        .selectFrom("webhook_deliveries")
        .select("delivery_id")
        .where("installation_id", "=", ctx.installationId)
        .where("event", "=", "check_run")
        .where("action", "=", "requested_action")
        .limit(1)
        .executeTakeFirst();
      ev.A05 = { answer: answer ?? null };
      ev.A06 = {
        answer: answer ?? null,
        delivered: delivered !== undefined,
        recorded: clicks.some((c) => c.user_id === ctx.actor.id),
      };
      const pr1id = pr1 ? await changeRow(ctx, pr1.number) : undefined;
      const outsiderClick = pr1id
        ? await ctx.db
            .selectFrom("intent_feedback")
            .select("source")
            .where("change_id", "=", pr1id.id)
            .where("user_id", "=", ctx.outsider?.id ?? 0)
            .executeTakeFirst()
        : undefined;
      ev.A07 = {
        outcome: scope["s08.answer.outsider"] ?? null,
        recorded: outsiderClick?.source ?? null,
        droppedByGate: ran("s08") && input.scenarios.s08 === "pass",
      };
    }
  }
  const perm = await safe(() =>
    probe.rest.repos.getCollaboratorPermissionLevel({
      owner: ctx.owner,
      repo: ctx.repo,
      username: ctx.actor.login,
    }),
  );
  ev.A08 = {
    ...(ev.A08 ?? {}),
    status: perm.ok ? perm.value.status : perm.status,
    permission: perm.ok ? perm.value.data.permission : null,
  };

  // A09
  const inst = await safe(() =>
    ctx.clients.app.rest.apps.getInstallation({ installation_id: ctx.installationId }),
  );
  ev.A09 = inst.ok
    ? {
        status: inst.value.status,
        permissions: inst.value.data.permissions,
        events: inst.value.data.events,
        repositorySelection: inst.value.data.repository_selection,
      }
    : { status: inst.status };

  // A10, A11
  const reviews = await ctx.db
    .selectFrom("webhook_deliveries")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("installation_id", "=", ctx.installationId)
    .where("event", "=", "pull_request_review")
    .where("action", "=", "submitted")
    .executeTakeFirst();
  ev.A10 = { count: Number(reviews?.n ?? 0) };
  const want: string[] = [];
  if (ran("s06")) want.push(`refs/heads/graft-e2e/${ctx.runId}/s01`);
  if (ran("s09")) want.push(`refs/heads/${ctx.sandbox.defaultBranch}`);
  if (want.length > 0) {
    const pushes = await collectPushEvidence(ctx);
    ev.A11 = { want, refs: pushes.refs.filter((r) => want.includes(r)) };
    if (ran("s09")) ev.A12 = { listsGraftYaml: pushes.listsGraftYaml };
  } else ev.A11 = { want: [] };

  // A13
  const timelineKinds = emptyTimelineKinds();
  let timelineStatus: number | string = 200;
  for (const key of ["s07.pr", "s08.pr"]) {
    const p = pr(key);
    if (!p) continue;
    const t = await safe(() =>
      probe.paginate(probe.rest.issues.listEventsForTimeline, {
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: p.number,
        per_page: 100,
      }),
    );
    if (!t.ok) {
      timelineStatus = t.status;
      continue;
    }
    addTimelineKinds(timelineKinds, t.value as unknown as Record<string, unknown>[]);
  }
  ev.A13 = { status: timelineStatus, kinds: timelineKinds };

  // A15, A16
  const obsPr = (k: string) => scope[k] as { pr?: PrObs } | PrObs | undefined;
  const s05 = obsPr("s05.obs") as { pr?: PrObs } | undefined;
  const s03 = obsPr("s03.obs") as PrObs | undefined;
  const s02 = obsPr("s02.obs") as { pr?: PrObs } | undefined;
  const s04 = obsPr("s04.obs") as { pr?: PrObs; controlHasUserMention?: boolean } | undefined;
  if (s05?.pr) {
    ev.A15 = {
      s05: s05.pr.comment.html.markdownAlert,
      s03: s03?.card?.verifierStatus === "disagree" ? s03.comment.html.markdownAlert : null,
    };
  }
  if (s02?.pr && s04?.pr) {
    const clean = (p: PrObs) =>
      p.comment.html.present && !p.comment.html.userMention && !p.comment.html.teamMention;
    ev.A16 = {
      s02Clean: clean(s02.pr),
      s04Clean: clean(s04.pr),
      control: s04.controlHasUserMention === true,
    };
  }

  // A17
  if (ran("s10")) {
    const attempt = scope["s10.attemptItem"] as { sameGuid?: boolean } | undefined;
    const list = await safe(() => listDeliveries(ctx.clients.app, 1));
    ev.A17 = {
      listStatus: list.ok ? 200 : list.status,
      sameGuid: attempt?.sameGuid === true,
      logDuplicate: scope["s10.logDuplicate"] ?? null,
    };
  }

  // A18
  const schema = ctx.config.pgbossSchema;
  const q = await sql<{ deletion_seconds: number | null }>`
    select deletion_seconds from ${sql.table(`${schema}.queue`)} where name = 'github.webhook'`
    .execute(ctx.db)
    .catch(() => ({ rows: [] as { deletion_seconds: number | null }[] }));
  const remaining = await sql<{ n: string }>`
    select count(*)::text as n from ${sql.table(`${schema}.job`)}
    where name = 'github.webhook' and data->>'installationId' = ${String(ctx.installationId)}
      and created_on >= ${input.runStartedAt}`
    .execute(ctx.db)
    .catch(() => ({ rows: [{ n: "-1" }] }));
  ev.A18 = {
    deletionSeconds: q.rows[0]?.deletion_seconds ?? null,
    afterRetention: input.afterRetention,
    remaining: Number(remaining.rows[0]?.n ?? 0),
  };

  // A20
  const installationRow = await ctx.db
    .selectFrom("installations")
    .select("id")
    .where("id", "=", ctx.installationId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const repoRow = await ctx.db
    .selectFrom("repositories")
    .select("id")
    .where("id", "=", ctx.repositoryId)
    .where("removed_at", "is", null)
    .executeTakeFirst();
  ev.A20 = { installation: installationRow !== undefined, repository: repoRow !== undefined };

  // A21
  const rl = await safe(() =>
    probe.request("GET /repos/{owner}/{repo}", { owner: ctx.owner, repo: ctx.repo }),
  );
  const h = rl.ok ? (rl.value.headers as Record<string, unknown>) : {};
  ev.A21 = {
    limit: h["x-ratelimit-limit"] !== undefined,
    remaining: h["x-ratelimit-remaining"] !== undefined,
    reset: h["x-ratelimit-reset"] !== undefined,
  };
  return ev;
}

export async function readManifest(rootDir: string): Promise<EvalInput["manifest"]> {
  const m = JSON.parse(
    await readFile(path.join(rootDir, "github", "app-manifest.json"), "utf8"),
  ) as {
    default_permissions: Record<string, string>;
    default_events: string[];
  };
  return { permissions: m.default_permissions, events: m.default_events };
}
