/**
 * e01 (Phase 1 step 7, D21, §12): `policy_mode: enforce` end to end, on an `enforce` sandbox only.
 * The runner never changes a mode: the preflight requires the human to have set the ceiling and
 * `--policy enforce`. Each step waits for `graft/policy` on the new head and records what it
 * expects, so INV-1E can judge the open PR against the scenario's last expectation.
 *
 * The step list is `E01_STEPS`: adding, removing or changing an expectation is one line there.
 */
import { POLICY_CHECK_NAME } from "../../modules/policy/index.js";
import { AGENT_MODEL, AGENT_NAME, commitMessageOf, ZONES } from "../fixtures.js";
import { graftChecks } from "../observe.js";
import { ref, type Step, type StepCtx } from "../plan.js";
import { commitSentinelParagraph } from "../sentinels.js";
import { TIMEOUTS } from "../waiters.js";
import {
  assertion,
  branchOf,
  changesOf,
  commitAct,
  diffLine,
  openPrAct,
  type PlanContext,
  prBody,
  prTitle,
  type ScenarioDef,
  settleStep,
} from "./common.js";

/** The scope key INV-1E reads: PR number → the last `graft/policy` conclusion e01 expects. */
export const E01_EXPECTED_KEY = "e01.policy.expected";
export const E01_BREAK_GLASS_LABEL = "graft:break-glass";

export type E01Expectation = "success" | "failure";

/** §12 (a) to (e): what happens, and the conclusion `graft/policy` must reach after it. */
export const E01_STEPS: readonly { id: string; what: string; expect: E01Expectation }[] = [
  { id: "a", what: "agent commit in graft-e2e/ and PR E (approvals missing)", expect: "failure" },
  { id: "b", what: "the outsider approves", expect: "success" },
  { id: "c", what: "the actor pushes a second commit (stale approval)", expect: "failure" },
  { id: "d", what: "the actor adds graft:break-glass", expect: "success" },
  { id: "e", what: "the actor pushes again (the bypass ends)", expect: "failure" },
];

const expectOf = (id: string): E01Expectation => {
  const s = E01_STEPS.find((x) => x.id === id);
  if (!s) throw new Error(`plan error: e01 step ${id}`);
  return s.expect;
};

/** Records the expectation for the PR, then waits for `graft/policy` on the commit's head. */
function policyIs(stepId: string, commitKey: string): Step[] {
  const expected = expectOf(stepId);
  return [
    {
      kind: "custom",
      id: `e01.${stepId}.expect`,
      describe: `expect graft/policy ${expected}`,
      run: async (sx: StepCtx) => {
        const pr = sx.scope.require<{ number: number }>("e01.pr");
        const map = sx.scope.get<Record<string, E01Expectation>>(E01_EXPECTED_KEY) ?? {};
        sx.scope.set(E01_EXPECTED_KEY, { ...map, [String(pr.number)]: expected });
      },
    },
    {
      kind: "wait",
      id: `e01.${stepId}.policy`,
      key: `e01.${stepId}.policy`,
      name: "policyConclusion",
      timeoutMs: TIMEOUTS.policyFinal,
      describe: `graft/policy on the head of ${commitKey} is ${expected}`,
      probe: async (sx: StepCtx) => {
        const c = sx.scope.require<{ sha: string }>(commitKey);
        const checks = await graftChecks(sx.run, c.sha);
        const p = checks.find((x) => x.name === POLICY_CHECK_NAME);
        sx.note(p ? `${p.status}/${p.conclusion ?? "none"}` : "no graft/policy");
        return p?.status === "completed" && p.conclusion === expected
          ? { conclusion: p.conclusion }
          : false;
      },
    },
  ];
}

export const e01: ScenarioDef = {
  id: "e01",
  title: "Policy enforce: failure, approval, stale approval, break-glass, push",
  needs: [],
  requiresOutsider: true,
  sandboxMode: "enforce",
  modelRuns: 3,
  plan(pc: PlanContext): Step[] {
    const branch = branchOf(pc.runId, "e01");
    const commit = (key: string, from: "main" | "branch", subject: string): Step =>
      commitAct(`e01.${key}`, `e01.${key}`, {
        client: "actor",
        branch,
        from,
        // An agent commit (trailers), with no task: e01 runs alone, without the run issue.
        message: commitMessageOf({
          subject,
          sentinel: commitSentinelParagraph(pc.sentinels),
          trailers: [
            ["Graft-Agent", AGENT_NAME],
            ["Graft-Model", AGENT_MODEL],
          ],
        }),
        changes: [changesOf(ZONES, [diffLine(ZONES, pc)])],
      });
    return [
      // (a)
      commit("c1", "main", "Tune a heart-rate zone note"),
      openPrAct("e01.pr", "e01.pr", {
        client: "actor",
        head: branch,
        title: prTitle(pc, "e01", "Tune a heart-rate zone note"),
        body: prBody(pc, "Enforce-mode e2e scenario e01."),
      }),
      // Everything Graft publishes for the first head (this also decides the LLM mode, D11).
      settleStep("e01.settle", "e01.pr", "e01.c1"),
      ...policyIs("a", "e01.c1"),
      // (b)
      {
        kind: "act",
        id: "e01.approve",
        act: { act: "review", client: "outsider", pr: ref("e01.pr"), event: "APPROVE" },
      },
      ...policyIs("b", "e01.c1"),
      // (c)
      commit("c2", "branch", "Tune the zone note again"),
      ...policyIs("c", "e01.c2"),
      // (d)
      {
        kind: "act",
        id: "e01.label",
        act: { act: "addLabel", client: "actor", pr: ref("e01.pr"), label: E01_BREAK_GLASS_LABEL },
      },
      ...policyIs("d", "e01.c2"),
      {
        kind: "custom",
        id: "e01.audit",
        describe: "graft audit list --repo <sandbox> --json (in process, read-only)",
        run: async (sx: StepCtx) => {
          const pr = sx.scope.require<{ number: number }>("e01.pr");
          const res = await sx.run.deps.ops([
            "audit",
            "list",
            "--repo",
            `${sx.run.owner}/${sx.run.repo}`,
            "--json",
          ]);
          let applied = 0;
          if (res.code === 0) {
            const parsed = JSON.parse(res.out) as {
              entries: { kind: string; prNumber: number }[];
            };
            applied = parsed.entries.filter(
              (e) => e.kind === "applied" && e.prNumber === pr.number,
            ).length;
          }
          // Counts only: the audit rows hold logins, which the scope never keeps.
          sx.scope.set("e01.audit", { code: res.code, applied });
        },
      },
      {
        kind: "assert",
        id: "e01.audit.assert",
        evaluate: (sx) => {
          const a = sx.scope.require<{ code: number; applied: number }>("e01.audit");
          return [
            assertion(
              "system",
              "e01.break-glass.audited",
              "audit list exits 0 with at least one applied row for PR E",
              a,
              a.code === 0 && a.applied >= 1,
            ),
          ];
        },
      },
      // (e)
      commit("c3", "branch", "Tune the zone note a third time"),
      ...policyIs("e", "e01.c3"),
      // The policy check can complete before provenance and intent are published for the new
      // head: INV-1E reads all three right after the scenario, so wait for the head to settle.
      settleStep("e01.settle.e", "e01.pr", "e01.c3"),
    ];
  },
};
