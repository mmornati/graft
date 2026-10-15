import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { humanTodoStatus } from "../../src/e2e/assumptions.js";
import { Capture, scrubJson } from "../../src/e2e/capture.js";
import {
  renderMarkdown,
  tickHumanTodo,
  updateHumanTodoFile,
  writeReport,
} from "../../src/e2e/report.js";
import { type Report, reportSchema } from "../../src/e2e/report-schema.js";
import { SecretRegistry } from "../../src/e2e/secrets.js";

const report: Report = {
  schemaVersion: 1,
  runId: "e2e-20261015-abcdef",
  startedAt: "2026-10-15T10:00:00.000Z",
  finishedAt: "2026-10-15T10:42:00.000Z",
  mode: { target: "github", llm: "live", interactive: true, dryRun: false, lenientModel: false },
  sandbox: {
    repo: "mmornati/graft-sandbox",
    visibility: "private",
    outsiderMode: "collaborator",
    installationId: 777,
    repositoryId: 888,
  },
  graft: {
    appId: 123,
    gitCommit: "9e0bfe4",
    dirty: false,
    promptVersion: "intent-v1",
    pricingVerifiedAt: "2026-10-06",
  },
  cost: { maxUsd: 5, estimateUsd: 1.6, spentUsd: 0.42, tokens: 21000 },
  scenarios: [
    {
      id: "s01",
      title: "Agent typo fix",
      status: "pass",
      prs: [
        {
          key: "s01.pr",
          number: 2,
          url: "https://github.com/mmornati/graft-sandbox/pull/2",
          headSha: "a".repeat(40),
        },
      ],
      startedAt: "2026-10-15T10:00:00.000Z",
      durationMs: 61000,
      costUsd: 0.05,
      tokens: 3000,
      assertions: [
        { id: "s01.card.risk", kind: "model", expected: "trivial", observed: "trivial", ok: true },
      ],
      invariants: [
        {
          id: "INV-1",
          status: "pass",
          detail: "1 open PRs: all Graft checks completed and neutral",
        },
      ],
    },
    {
      id: "s03",
      title: "Misleading body",
      status: "fail",
      prs: [],
      startedAt: "2026-10-15T10:05:00.000Z",
      durationMs: 5000,
      costUsd: 0,
      tokens: 0,
      assertions: [
        {
          id: "s03.risk",
          kind: "model",
          expected: "logic or sensitive",
          observed: "trivial",
          ok: false,
        },
        { id: "s03.verifier", kind: "soft", expected: "disagree", observed: "agree", ok: false },
      ],
      invariants: [{ id: "INV-3", status: "fail", detail: "fail 1; pgboss.job.data" }],
      error: { name: "WaitTimeout", message: "step s03.settle: timed out waiting for s03.settle" },
    },
    {
      id: "s08",
      title: "Votes",
      status: "skipped",
      skipReason: "needs_outsider",
      prs: [],
      startedAt: "2026-10-15T10:10:00.000Z",
      durationMs: 0,
      costUsd: 0,
      tokens: 0,
      assertions: [],
      invariants: [],
    },
  ],
  assumptions: [
    {
      id: "A01",
      title: "Comments carry the app id",
      anchor: "s2-performed-via",
      status: "pass",
      evidence: { probe: 123 },
    },
    {
      id: "A04",
      title: "Poll",
      anchor: "s3-outputs",
      status: "unverified",
      evidence: { note: "cron path not exercised" },
    },
  ],
  sentinels: {
    planted: 28,
    hits: [
      {
        scenario: "s01",
        kind: "T",
        table: "pgboss.job",
        key: "data",
        class: "accounted",
        deadline: "2026-10-15T11:00:00.000Z",
      },
    ],
  },
  humanTodo: [{ anchor: "s2-performed-via", kind: "tick", assumptions: ["A01"], resolvable: true }],
  exitCode: 1,
};

describe("report", () => {
  it("U-LIVE-REP-1 report.json validates against its schema; report.md matches a snapshot; files are 0600 and directories 0700", async () => {
    expect(() => reportSchema.parse(report)).not.toThrow();
    expect(() => reportSchema.parse({ ...report, schemaVersion: 2 })).toThrow();
    expect(renderMarkdown(report)).toMatchInlineSnapshot(`
      "# Graft live e2e run e2e-20261015-abcdef

      - Mode: github, LLM live, interactive
      - Sandbox: mmornati/graft-sandbox (private, outsider mode: collaborator), installation 777
      - Graft: commit 9e0bfe4, prompt intent-v1, prices verified 2026-10-06
      - Duration: 2520 s. Cost: $0.4200 of $5.00 (bound $1.60), 21000 tokens
      - Exit code: 1

      ## Summary

      | Scenario | Status | PRs | Duration | Cost | Failed assertions |
      | --- | --- | --- | --- | --- | --- |
      | s01 Agent typo fix | pass | [#2](https://github.com/mmornati/graft-sandbox/pull/2) | 61 s | $0.0500 | - |
      | s03 Misleading body | fail | - | 5 s | $0.0000 | s03.risk, INV-3 |
      | s08 Votes | skipped (needs_outsider) | - | 0 s | $0.0000 | - |

      ## s01: Agent typo fix

      | Assertion | Kind | Expected | Observed | Result |
      | --- | --- | --- | --- | --- |
      | s01.card.risk | model | trivial | trivial | ok |

      | Invariant | Status | Detail |
      | --- | --- | --- |
      | INV-1 | pass | 1 open PRs: all Graft checks completed and neutral |

      ## s03: Misleading body

      Error: WaitTimeout: step s03.settle: timed out waiting for s03.settle

      | Assertion | Kind | Expected | Observed | Result |
      | --- | --- | --- | --- | --- |
      | s03.risk | model | logic or sensitive | trivial | FAIL |
      | s03.verifier | soft | disagree | agree | WARN |

      | Invariant | Status | Detail |
      | --- | --- | --- |
      | INV-3 | fail | fail 1; pgboss.job.data |

      ## s08: Votes

      Skipped: needs_outsider.

      ## Assumptions

      | Id | Anchor | Status | Evidence |
      | --- | --- | --- | --- |
      | A01 | s2-performed-via | pass | {"probe":123} |
      | A04 | s3-outputs | unverified | {"note":"cron path not exercised"} |

      ## Sentinels

      Planted 28. Hits: echo 0, accounted 1, fail 0.

      - accounted: s01 T in pgboss.job.data (until 2026-10-15T11:00:00.000Z)

      ## HUMAN-TODO

      Items this run proves (their boxes get ticked): s2-performed-via.
      Items that are deployment or pilot actions (only an "observed in sandbox" note, box left alone): none.

      \`\`\`sh
      pnpm graft e2e report --run-id e2e-20261015-abcdef --update-human-todo
      \`\`\`

      ## Skipped

      - s08: needs_outsider

      ## Next steps

      - card_timeout: is the worker running? is the LLM slow? is the budget used up?
      - sentinel_leak: privacy bug; stop, keep the report, purge with pilot purge if needed
      - model_mismatch: look at the card on GitHub; prompt work goes through pnpm eval
      "
    `);

    const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-rep-"));
    try {
      const runDir = path.join(dir, report.runId);
      const written = await writeReport(runDir, report, new SecretRegistry());
      expect(reportSchema.parse(JSON.parse(await readFile(written.jsonPath, "utf8")))).toEqual(
        report,
      );
      expect((await stat(runDir)).mode & 0o777).toBe(0o700);
      expect((await stat(written.jsonPath)).mode & 0o777).toBe(0o600);
      expect((await stat(written.mdPath)).mode & 0o777).toBe(0o600);
      // The markdown is terminal-safe.
      const hostile = {
        ...report,
        scenarios: [{ ...report.scenarios[0], title: "bad \u001b[31m title" }],
      };
      expect(renderMarkdown(hostile as Report)).toContain("bad \u001b[31m title"); // raw here ...
      const safe = await writeReport(path.join(dir, "x"), hostile as Report, new SecretRegistry());
      expect(safe.md).not.toContain("\u001b"); // ... controlled on the way out
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const TODO = [
  "# Human to-do",
  "",
  "## Step 2",
  "",
  "- [ ] **Confirm that comments carry the id.** Who: repo owner. <!-- e2e:s2-performed-via -->",
  "- [ ] **Check the outputs on GitHub.** On a sandbox PR, check that:",
  "  - the section appears;",
  "  - a thumbs-up is recorded.",
  "",
  "  Who: repo owner. <!-- e2e:s3-outputs -->",
  "- [ ] **Something else.** Who: owner.",
  "",
].join("\n");

describe("HUMAN-TODO", () => {
  it("U-LIVE-REP-2 --update-human-todo ticks an anchor only when all its assumptions passed, appends the verification, is idempotent and leaves every other byte alone", async () => {
    // M11: an anchor with one failing assumption must not be ticked.
    const none = tickHumanTodo(
      TODO,
      [].map((anchor) => ({ anchor, kind: "tick" as const })),
      { runId: "e2e-20261015-abcdef", date: "2026-10-15" },
    );
    expect(none.text).toBe(TODO);

    const once = tickHumanTodo(
      TODO,
      ["s2-performed-via"].map((anchor) => ({ anchor, kind: "tick" as const })),
      {
        runId: "e2e-20261015-abcdef",
        date: "2026-10-15",
      },
    );
    expect(once.ticked).toEqual(["s2-performed-via"]);
    expect(once.text).toBe(
      TODO.replace("- [ ] **Confirm that comments", "- [x] **Confirm that comments").replace(
        "<!-- e2e:s2-performed-via -->",
        "<!-- e2e:s2-performed-via --> Verified by live e2e run e2e-20261015-abcdef (2026-10-15).",
      ),
    );
    const twice = tickHumanTodo(
      once.text,
      ["s2-performed-via"].map((anchor) => ({ anchor, kind: "tick" as const })),
      {
        runId: "e2e-20261015-zzzzzz",
        date: "2026-10-16",
      },
    );
    expect(twice.text).toBe(once.text);
    expect(twice.ticked).toEqual([]);

    // A multi-line item is ticked at its first line; the rest is untouched.
    const multi = tickHumanTodo(
      TODO,
      ["s3-outputs"].map((anchor) => ({ anchor, kind: "tick" as const })),
      { runId: "r", date: "d" },
    );
    expect(multi.text.split("\n").filter((l, i) => l !== TODO.split("\n")[i])).toEqual([
      "- [x] **Check the outputs on GitHub.** On a sandbox PR, check that:",
      "  Who: repo owner. <!-- e2e:s3-outputs --> Verified by live e2e run r (d).",
    ]);
    // M11: one failing assumption keeps the anchor unresolvable, so it is never ticked.
    const mixed = humanTodoStatus(
      [
        { id: "A01", title: "t", anchor: "s2-performed-via", status: "pass", evidence: {} },
        { id: "A02", title: "t", anchor: "s2-performed-via", status: "fail", evidence: {} },
      ],
      {},
    );
    expect(mixed.find((x) => x.anchor === "s2-performed-via")?.resolvable).toBe(false);
    // An unknown anchor changes nothing.
    expect(
      tickHumanTodo(
        TODO,
        ["nope"].map((anchor) => ({ anchor, kind: "tick" as const })),
        { runId: "r", date: "d" },
      ).text,
    ).toBe(TODO);

    const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-todo-"));
    try {
      const file = path.join(dir, "HUMAN-TODO.md");
      await writeFile(file, TODO);
      expect(
        await updateHumanTodoFile(file, [{ anchor: "s2-performed-via", kind: "tick" }], {
          runId: "r",
          date: "d",
        }),
      ).toEqual({ ticked: ["s2-performed-via"], noted: [] });
      expect(
        await updateHumanTodoFile(file, [{ anchor: "s2-performed-via", kind: "tick" }], {
          runId: "r",
          date: "d",
        }),
      ).toEqual({ ticked: [], noted: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("U-LIVE-REP-2 deployment and pilot items are only annotated, never ticked; the proving items are ticked (the committed file)", async () => {
    const { ANCHOR_KIND, ANCHORS, evaluateAssumptions } = await import(
      "../../src/e2e/assumptions.js"
    );
    expect(Object.keys(ANCHOR_KIND).sort()).toEqual([...ANCHORS].sort());
    const notTicked = [
      "s1-install",
      "s5-events",
      "s6-backfill",
      "s6-retention",
      "s6-baseline-github",
    ];
    const ticked = [
      "s2-performed-via",
      "s3-model-access",
      "s3-outputs",
      "s5-check-github",
      "s6-redelivery",
    ];
    for (const a of notTicked) expect(ANCHOR_KIND[a], a).toBe("note");
    for (const a of ticked) expect(ANCHOR_KIND[a], a).toBe("tick");
    void evaluateAssumptions;
    const text = await readFile(
      new URL("../../docs/phase-0/HUMAN-TODO.md", import.meta.url),
      "utf8",
    );
    const updates = ANCHORS.map((anchor) => ({
      anchor,
      kind: ANCHOR_KIND[anchor] as "tick" | "note",
      assumptions: ["A01"],
    }));
    const res = tickHumanTodo(text, updates, { runId: "e2e-20261015-abcdef", date: "2026-10-15" });
    expect(res.ticked.sort()).toEqual([...ticked].sort());
    expect(res.noted.sort()).toEqual([...notTicked].sort());
    const lines = res.text.split("\n");
    for (const a of notTicked) {
      const at = lines.findIndex((l) => l.includes(`<!-- e2e:${a} -->`));
      expect(lines[at]).toContain(
        "Observed in sandbox on 2026-10-15 (live e2e run e2e-20261015-abcdef; A01)",
      );
      let start = at;
      while (!/^- \[[ x]\] /.test(lines[start] as string)) start--;
      expect(lines[start], a).toMatch(/^- \[ \] /);
    }
    for (const a of ticked) {
      const at = lines.findIndex((l) => l.includes(`<!-- e2e:${a} -->`));
      let start = at;
      while (!/^- \[[ x]\] /.test(lines[start] as string)) start--;
      expect(lines[start], a).toMatch(/^- \[x\] /);
    }
    // Idempotent, and nothing else changes.
    expect(tickHumanTodo(res.text, updates, { runId: "z", date: "z" }).text).toBe(res.text);
    const before = text.split("\n");
    const changed = lines.filter((l, i) => l !== before[i]);
    expect(changed.length).toBeLessThanOrEqual(ANCHORS.length * 2);
  });

  it("the committed HUMAN-TODO carries every anchor exactly once, on the end of its item", async () => {
    const { ANCHORS } = await import("../../src/e2e/assumptions.js");
    const text = await readFile(
      new URL("../../docs/phase-0/HUMAN-TODO.md", import.meta.url),
      "utf8",
    );
    for (const a of ANCHORS) {
      const hits = text.split("\n").filter((l) => l.includes(`<!-- e2e:${a} -->`));
      expect(hits, a).toHaveLength(1);
      expect(hits[0]?.trimEnd()?.endsWith(`<!-- e2e:${a} -->`), a).toBe(true);
    }
  });
});

describe("capture", () => {
  it("U-LIVE-CAP-1 files follow the format: names, fields, header allow-list, no signature headers, redacted emails and tokens, a complete index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-cap-"));
    try {
      const secrets = new SecretRegistry();
      secrets.add("ghp_SECRETvalue0123456789abcdefghij");
      const cap = new Capture(path.join(dir, "capture"), secrets, {
        runId: "e2e-20261015-abcdef",
        graftCommit: "9e0bfe4",
        sandbox: "mmornati/graft-sandbox",
        appId: 123,
        createdAt: "2026-10-15T10:00:00.000Z",
      });
      await cap.api(
        {
          client: "actor",
          method: "GET",
          route: "/repos/{owner}/{repo}/pulls/{pull_number}",
          path: "/repos/mmornati/graft-sandbox/pulls/2",
          query: { per_page: "100" },
          status: 200,
          responseHeaders: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
          responseBody: {
            user: { email: "me@example.org", avatar_url: "https://avatars/1", gravatar_id: "abc" },
            note: "keep ZQSNTabcdefghijklm2-T",
          },
        },
        "s01",
        "2026-10-15T10:00:01.000Z",
      );
      await cap.api(
        {
          client: "app",
          method: "POST",
          route: "/app/installations/{installation_id}/access_tokens",
          path: "/app/installations/1/access_tokens",
          query: {},
          status: 201,
          requestBody: {},
          responseHeaders: {},
          responseBody: {
            token: "ghs_installationtoken0123456789abcdef",
            expires_at: "2026-10-15T11:00:00Z",
          },
        },
        "s01",
        "2026-10-15T10:00:02.000Z",
      );
      const fakeApp = {
        rest: {
          apps: {
            listWebhookDeliveries: async () => ({
              data: [
                {
                  id: 11,
                  guid: "g-1",
                  delivered_at: "2026-10-15T10:00:03Z",
                  redelivery: false,
                  status_code: 202,
                  event: "pull_request",
                  action: "opened",
                  installation_id: 777,
                },
              ],
              headers: {},
            }),
            getWebhookDelivery: async () => ({
              data: {
                request: {
                  headers: {
                    "X-GitHub-Event": "pull_request",
                    "X-GitHub-Delivery": "g-1",
                    "X-Hub-Signature-256": "sha256=abc",
                    "X-Hub-Signature": "sha1=abc",
                    "User-Agent": "GitHub-Hookshot",
                    "X-GitHub-Hook-Installation-Target-ID": "123",
                    "X-GitHub-Hook-Installation-Target-Type": "integration",
                  },
                  payload: { sender: { email: "x@y.z", avatar_url: "https://a" } },
                },
                repository_id: 888,
              },
            }),
          },
        },
      };
      const n = await cap.webhooks(fakeApp as never, {
        since: new Date("2026-10-15T10:00:00Z"),
        scenario: "s01",
        installationId: 777,
      });
      expect(n).toBe(1);
      // A second capture of the same delivery adds nothing.
      expect(
        await cap.webhooks(fakeApp as never, {
          since: new Date("2026-10-15T10:00:00Z"),
          scenario: "s01",
          installationId: 777,
        }),
      ).toBe(0);

      const root = path.join(dir, "capture");
      expect((await readdir(root)).sort()).toEqual([
        "api",
        "index.jsonl",
        "manifest.json",
        "webhooks",
      ]);
      const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        captureVersion: 1,
        runId: "e2e-20261015-abcdef",
        graftCommit: "9e0bfe4",
        sandbox: "mmornati/graft-sandbox",
        appId: 123,
      });
      expect(manifest.redactions).toEqual(
        expect.arrayContaining(["registry", "github_token", "jwt", "pem", "email", "avatar"]),
      );
      const apiFiles = (await readdir(path.join(root, "api"))).sort();
      expect(apiFiles).toEqual([
        "000001-GET-repos-owner-repo-pulls-pull-number.json",
        "000002-POST-app-installations-installation-id-access-tokens.json",
      ]);
      const get = JSON.parse(await readFile(path.join(root, "api", apiFiles[0] as string), "utf8"));
      expect(Object.keys(get).sort()).toEqual([
        "at",
        "client",
        "method",
        "path",
        "query",
        "responseBody",
        "responseHeaders",
        "route",
        "scenario",
        "seq",
        "status",
      ]);
      expect(get.responseBody.user).toEqual({
        email: "user@example.invalid",
        avatar_url: "",
        gravatar_id: "",
      });
      expect(get.responseBody.note).toContain("ZQSNTabcdefghijklm2-T"); // sentinels are kept
      const post = JSON.parse(
        await readFile(path.join(root, "api", apiFiles[1] as string), "utf8"),
      );
      expect(post.requestBody).toEqual({});
      expect(post.responseBody.token).toBe("[REDACTED]");
      const hooks = await readdir(path.join(root, "webhooks"));
      expect(hooks).toEqual(["000003-pull_request.opened.json"]);
      const hook = JSON.parse(
        await readFile(path.join(root, "webhooks", hooks[0] as string), "utf8"),
      );
      expect(Object.keys(hook.headers).sort()).toEqual([
        "X-GitHub-Delivery",
        "X-GitHub-Event",
        "X-GitHub-Hook-Installation-Target-ID",
        "X-GitHub-Hook-Installation-Target-Type",
      ]);
      expect(hook).toMatchObject({
        guid: "g-1",
        event: "pull_request",
        action: "opened",
        installationId: 777,
        repositoryId: 888,
        redelivery: false,
        statusCode: 202,
      });
      expect(hook.payload.sender.email).toBe("user@example.invalid");
      const index = (await readFile(path.join(root, "index.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(index.map((e: { kind: string; seq: number }) => `${e.kind}:${e.seq}`)).toEqual([
        "api:1",
        "api:2",
        "webhook:3",
      ]);
      for (const e of index) await stat(path.join(root, e.file));
      expect((await stat(path.join(root, "api"))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root, "api", apiFiles[0] as string))).mode & 0o777).toBe(0o600);
      expect(scrubJson({ a: [{ email: "x" }] })).toEqual({
        a: [{ email: "user@example.invalid" }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
