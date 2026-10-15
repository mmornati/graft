import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Capture } from "../../src/e2e/capture.js";
import { ASKPASS_SCRIPT, createGitPusher, gitSubcommand } from "../../src/e2e/git-pusher.js";
import { readActorToken } from "../../src/e2e/preflight.js";
import { buildReport, writeReport } from "../../src/e2e/report.js";
import { describeError, REDACTED, SecretRegistry, safeIo } from "../../src/e2e/secrets.js";
import { loadState, type RunState, saveState } from "../../src/e2e/state.js";
import type { E2eDeps } from "../../src/e2e/types.js";

const TOKEN = "ghp_SENTINELtoken0123456789abcdefghij";
const SMEE = "https://smee.io/abcDEF123";

async function tree(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += `\n${await readFile(path.join(e.parentPath, e.name), "utf8")}`;
  }
  return out;
}

function sampleState(secret: string): RunState {
  return {
    version: 1,
    runId: "e2e-20261015-abcdef",
    target: "offline",
    startedAt: "2026-10-15T10:00:00.000Z",
    finishedAt: "2026-10-15T10:10:00.000Z",
    sandbox: {
      repo: "mmornati/graft-sandbox",
      visibility: "private",
      outsiderMode: "collaborator",
      installationId: 1,
      repositoryId: 2,
    },
    actor: { login: "mmornati", id: 1 },
    outsider: null,
    options: {
      interactive: false,
      dryRun: false,
      lenientModel: false,
      maxCostUsd: 5,
      estimateUsd: 1,
      llmFlag: "auto",
      waitCron: false,
      withSourceBaseline: false,
    },
    graft: {
      appId: 1,
      gitCommit: "abc",
      dirty: false,
      promptVersion: "intent-v1",
      pricingVerifiedAt: "2026-10-06",
    },
    llmMode: "live",
    scope: { "s01.leak": secret },
    sentinels: {},
    issueNumber: null,
    scenarios: [
      {
        id: "s01",
        title: "Agent typo fix",
        status: "fail",
        prs: [],
        startedAt: "2026-10-15T10:00:00.000Z",
        durationMs: 1,
        costUsd: 0,
        tokens: 0,
        assertions: [
          { id: "s01.x", kind: "system", expected: "a", observed: `leaked ${secret}`, ok: false },
        ],
        invariants: [{ id: "INV-1", status: "fail", detail: `detail ${secret}` }],
        error: { name: "Error", message: `boom ${secret}` },
      },
    ],
    evidence: { A01: { v: secret } },
    sentinelHits: [],
    lastDeliveryAt: null,
    spentUsd: 0,
    tokens: 0,
    assumptions: [{ id: "A01", title: "t", anchor: null, status: "fail", evidence: { v: secret } }],
    exitCode: 1,
  };
}

describe("secrets and redaction", () => {
  it("U-LIVE-SEC-1 registered values (also in JSON, Error messages and stacks), each pattern and the smee URL are redacted; redaction is idempotent", () => {
    const r = new SecretRegistry();
    r.add(TOKEN);
    r.add("a-webhook-secret-value-0123");
    r.add(SMEE);
    const once = r.redact(
      `x ${TOKEN} y ${JSON.stringify({ k: TOKEN })} z a-webhook-secret-value-0123 ${SMEE}/path`,
    );
    expect(once).not.toContain(TOKEN);
    expect(once).not.toContain("a-webhook-secret-value-0123");
    expect(once).not.toContain("smee.io");
    expect(r.redact(once)).toBe(once);

    const err = new Error(`failed with ${TOKEN}`);
    expect(r.redact(String(err.stack))).not.toContain(TOKEN);
    expect(r.redact(err.message)).toBe(`failed with ${REDACTED}`);

    const empty = new SecretRegistry();
    const cases: [string, string][] = [
      ["ghp_0123456789abcdefghijABCDEFGHIJ", "ghp_"],
      ["ghs_0123456789abcdefghijABCDEFGHIJ", "ghs_"],
      ["github_pat_0123456789abcdefghij_ABCDEF", "github_pat_"],
      ["sk-ant-api03-abcdefghij", "sk-ant-"],
      ["eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJl", "eyJ"],
      ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "BEGIN RSA"],
      ["Authorization: bearer abcdefghijklmnop1234", "abcdefghij"],
      ["token abcdefghijklmnop1234", "abcdefghij"],
      ["https://smee.io/zzzYYY", "smee.io"],
    ];
    for (const [input, needle] of cases) {
      const out = empty.redact(`before ${input} after`);
      expect(out, input).toContain(REDACTED);
      expect(out, input).not.toContain(needle);
      expect(empty.redact(out)).toBe(out);
    }
    // Prose is left alone.
    expect(empty.redact("the token budget is used up")).toBe("the token budget is used up");
  });

  it("U-LIVE-SEC-1 describeError keeps name, status, method and route; never a message of a request error", () => {
    const e = Object.assign(new Error(`bad ${TOKEN}`), {
      name: "HttpError",
      status: 422,
      request: {
        method: "POST",
        url: `https://api.github.com/repos/o/r/pulls?access_token=${TOKEN}`,
      },
      response: { headers: { "x-github-request-id": "ABCD:1" } },
    });
    const text = describeError(e);
    expect(text).toBe("HttpError: HTTP 422: POST /repos/o/r/pulls: request ABCD:1");
    expect(text).not.toContain(TOKEN);
  });

  it("U-LIVE-SEC-2 a secret in an observation, a probe error and a capture body is in no file of the run directory and in no io output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-sec-"));
    try {
      const secrets = new SecretRegistry();
      secrets.add(TOKEN);
      const outputs: string[] = [];
      const io = safeIo({ out: (s) => outputs.push(s), err: (s) => outputs.push(s) }, secrets);
      io.out(`token is ${TOKEN}\n`);
      io.err(`${describeError(new Error(`probe failed ${TOKEN}`))}\n`);

      const state = sampleState(TOKEN);
      await saveState(dir, state, secrets);
      const report = buildReport(state, {
        assumptions: state.assumptions,
        humanTodo: [],
        exitCode: 1,
        finishedAt: state.finishedAt as string,
      });
      await writeReport(path.join(dir, state.runId), report, secrets);
      const capture = new Capture(path.join(dir, state.runId, "capture"), secrets, {
        runId: state.runId,
        graftCommit: "abc",
        sandbox: "mmornati/graft-sandbox",
        appId: 1,
        createdAt: "2026-10-15T10:00:00.000Z",
      });
      await capture.api(
        {
          client: "actor",
          method: "POST",
          route: "/repos/{owner}/{repo}/issues",
          path: "/repos/o/r/issues",
          query: {},
          status: 201,
          requestBody: { body: `has ${TOKEN}` },
          responseHeaders: {},
          responseBody: {
            echoed: TOKEN,
            user: { email: "someone@example.org", avatar_url: "https://a/b" },
          },
        },
        "s01",
        "2026-10-15T10:00:01.000Z",
      );
      const all = await tree(dir);
      expect(all).not.toContain(TOKEN);
      expect(all).toContain(REDACTED);
      expect(outputs.join("")).not.toContain(TOKEN);
      expect(outputs.join("")).toContain(REDACTED);
      // The state reads back and holds the redaction, not the secret.
      const back = await loadState(dir, state.runId);
      expect(JSON.stringify(back)).not.toContain(TOKEN);
      // 0700 directories and 0600 files.
      expect((await stat(path.join(dir, state.runId))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dir, state.runId, "state.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("U-LIVE-SEC-3 gh auth token is spawned with argv [auth, token] and no shell; a failing gh exits 2 without echoing its output", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const deps = {
      env: {},
      spawn: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
      },
    } as unknown as E2eDeps;
    const secrets = new SecretRegistry();
    expect(await readActorToken(deps, secrets)).toBe(TOKEN);
    expect(calls).toEqual([{ command: "gh", args: ["auth", "token"] }]);
    expect(secrets.redact(`value ${TOKEN}`)).not.toContain(TOKEN);

    const failing = {
      env: {},
      spawn: async () => ({ code: 1, stdout: `partial ${TOKEN}`, stderr: `gh said ${TOKEN}` }),
    } as unknown as E2eDeps;
    const err = await readActorToken(failing, new SecretRegistry()).catch((e: unknown) => e);
    expect((err as { code?: number }).code).toBe(2);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it("U-LIVE-SEC-3 git runs anonymous and isolated: no user config, no credential helper; the token reaches the push only through an askpass program and the child environment", async () => {
    const spawned: { command: string; args: string[]; env?: Record<string, string> | undefined }[] =
      [];
    const dirs: string[] = [];
    let askpassBody = "";
    const pusher = createGitPusher(async (command, args, o) => {
      spawned.push({ command, args, env: o?.env });
      if (args.includes("clone")) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const target = args[args.length - 1] as string;
        dirs.push(target);
        await mkdir(path.join(target, ".github", "workflows"), { recursive: true });
        await writeFile(path.join(target, "README.md"), "# copy\n");
        await writeFile(path.join(target, ".github", "workflows", "ci.yml"), "name: ci\n");
      }
      if (args.includes("push") && o?.env?.GIT_ASKPASS) {
        askpassBody = await readFile(o.env.GIT_ASKPASS, "utf8");
        expect((await stat(o.env.GIT_ASKPASS)).mode & 0o777).toBe(0o700);
      }
      return {
        code: 0,
        stdout: args.includes("rev-parse") ? "0123456789abcdef0123456789abcdef01234567\n" : "",
        stderr: "",
      };
    });
    const res = await pusher.copyAndPush({
      sandbox: "mmornati/graft-sandbox",
      source: "mmornati/ai-running-coach",
      token: TOKEN,
      files: new Map([["graft.yaml", "version: 1\n"]]),
      drop: [".github/workflows/", ".circleci/"],
      message: "copy",
      marker: (sha) => JSON.stringify({ graftE2eSandbox: 1, sourceCommit: sha }),
    });
    expect(res.sourceCommit).toBe("0123456789abcdef0123456789abcdef01234567");
    for (const s of spawned) {
      // Every git child ignores the user's and the system's configuration and never prompts.
      // The literal values, not the constant under test.
      expect(s.env, s.args.join(" ")).toMatchObject({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(JSON.stringify(s.args)).not.toContain(TOKEN);
      expect(s.args.join(" ")).not.toMatch(/https:\/\/[^@\s]*@/);
      expect(s.args.join(" ")).not.toContain("credential.helper=!");
    }
    const clone = spawned.find((s) => s.args.includes("clone"));
    expect(clone?.args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    expect(clone?.env?.GRAFT_E2E_GIT_TOKEN).toBeUndefined();
    const push = spawned.find((s) => s.args.includes("push"));
    expect(push?.args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    expect(push?.args).toContain("https://github.com/mmornati/graft-sandbox.git");
    expect(push?.env).toMatchObject({ GRAFT_E2E_GIT_TOKEN: TOKEN });
    expect(askpassBody).toBe(ASKPASS_SCRIPT);
    expect(askpassBody).not.toContain(TOKEN);
    await expect(stat(dirs[0] as string)).rejects.toThrow();
  });

  it("a failing git command is named by its subcommand, not by an option value", async () => {
    expect(gitSubcommand(["-c", "credential.helper=", "push", "--quiet", "x"])).toBe("push");
    expect(
      gitSubcommand(["-c", "user.name=Graft E2E", "-c", "user.email=a@b", "commit", "-m", "x"]),
    ).toBe("commit");
    const pusher = createGitPusher(async () => ({ code: 1, stdout: "", stderr: "" }));
    const err = await pusher
      .copyAndPush({
        sandbox: "a/b",
        source: "c/d",
        token: TOKEN,
        files: new Map(),
        drop: [],
        message: "m",
        marker: () => "{}",
      })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("git clone failed (exit 1)");
  });
});

describe("child environment", () => {
  it("U-LIVE-SEC-4 no child inherits GRAFT_E2E_*; a git child starts without GIT_* variables; explicit values are kept", async () => {
    const { childEnv } = await import("../../src/e2e/child-env.js");
    const parent = {
      PATH: "/bin",
      HOME: "/home/x",
      GRAFT_E2E_ACTOR_TOKEN: TOKEN,
      GRAFT_E2E_OUTSIDER_TOKEN: "outsider",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://evil/.insteadOf",
      GIT_CONFIG_PARAMETERS: "'x=y'",
      GIT_ASKPASS: "/usr/bin/vscode-askpass",
      GIT_TRACE_CURL: "1",
      UNSET: undefined,
    };
    expect(childEnv(parent, "git")).toEqual({ PATH: "/bin", HOME: "/home/x" });
    // Other children keep GIT_* (pnpm and vitest may need them) but never the runner's tokens.
    const pnpm = childEnv(parent, "pnpm", { GRAFT_E2E_OFFLINE_OUT: "/out" });
    expect(Object.keys(pnpm).sort()).toEqual(
      [
        "GIT_ASKPASS",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_PARAMETERS",
        "GIT_TRACE_CURL",
        "GRAFT_E2E_OFFLINE_OUT",
        "HOME",
        "PATH",
      ].sort(),
    );
    expect(JSON.stringify(pnpm)).not.toContain(TOKEN);
    // What the pusher sets explicitly is applied on top.
    expect(childEnv(parent, "git", { GIT_ASKPASS: "/tmp/a", GRAFT_E2E_GIT_TOKEN: "t" })).toEqual({
      PATH: "/bin",
      HOME: "/home/x",
      GIT_ASKPASS: "/tmp/a",
      GRAFT_E2E_GIT_TOKEN: "t",
    });
    // And the entry point uses it for every spawn.
    const entry = await readFile(new URL("../../src/bin/graft.ts", import.meta.url), "utf8");
    expect(entry).toContain("childEnv(process.env, command");
  });
});
