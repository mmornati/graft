/**
 * Regenerates test/fixtures/webhooks/*.json from @octokit/webhooks-examples, rewritten into one
 * fictional world (org graft-sandbox). Run: pnpm tsx scripts/generate-fixtures.ts
 * The output is committed; this script only documents how it was produced.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv, type ErrorObject } from "ajv";

const require = createRequire(import.meta.url);

interface Example {
  name: string;
  examples: Record<string, unknown>[];
}
const catalog = require("@octokit/webhooks-examples") as Example[];

const OUT = new URL("../test/fixtures/webhooks/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const ORG = { login: "graft-sandbox", id: 9000001 };
const INSTALLATION_ID = 1000001;
const REPOS = {
  ts: { id: 2000001, name: "sample-ts" },
  py: { id: 2000002, name: "sample-py" },
};

function pick(
  event: string,
  action: string | undefined,
  where?: (e: Record<string, unknown>) => boolean,
) {
  const entry = catalog.find((c) => c.name === event);
  if (!entry) throw new Error(`no examples for ${event}`);
  const found = entry.examples.find(
    (e) => (action === undefined || e.action === action) && (where ? where(e) : true),
  );
  if (!found) throw new Error(`no example ${event}.${action}`);
  return structuredClone(found);
}

/** Replace every well-known upstream identity with the fictional world. */
function rewrite(value: unknown): unknown {
  let text = JSON.stringify(value);
  const replacements: [RegExp, string][] = [
    [/github\/hello-world/g, "graft-sandbox/sample-ts"],
    [/hello-world/g, REPOS.ts.name],
    [/"login": ?"github"/g, `"login":"${ORG.login}"`],
    [/\boctocat\b/g, "graft-dev"],
    [/Codertocat\/Hello-World/g, "graft-sandbox/sample-ts"],
    [/Codertocat/g, ORG.login],
    [/Octocoders/g, ORG.login],
    [/Hello-World/g, REPOS.ts.name],
    [/\b21031067\b/g, String(ORG.id)],
    [/\b957387\b/g, String(INSTALLATION_ID)],
    [/\b186853002\b/g, String(REPOS.ts.id)],
  ];
  for (const [re, to] of replacements) text = text.replace(re, to);
  return JSON.parse(text);
}

function repo(r: { id: number; name: string }) {
  return {
    id: r.id,
    node_id: `R_fake${r.id}`,
    name: r.name,
    full_name: `${ORG.login}/${r.name}`,
    private: true,
  };
}

function fixInstallation(p: Record<string, unknown>): void {
  const inst = p.installation as Record<string, unknown>;
  inst.id = INSTALLATION_ID;
  inst.target_type = "Organization";
  inst.suspended_at ??= null;
  inst.suspended_by ??= null;
  inst.target_id = ORG.id;
  inst.access_tokens_url = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`;
  inst.html_url = `https://github.com/organizations/${ORG.login}/settings/installations/${INSTALLATION_ID}`;
  const account = inst.account as Record<string, unknown>;
  account.type = "Organization";
  account.login = ORG.login;
  account.id = ORG.id;
}

// Some upstream examples predate the current schema. Fill missing required properties with a
// neutral value until the payload validates, so the committed fixtures are schema-valid.
const schema = require("@octokit/webhooks-schemas") as Record<string, unknown>;
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(schema, "root");

function neutral(key: string): unknown {
  if (key === "topics") return [];
  if (key === "custom_properties") return {};
  if (key === "visibility") return "private";
  if (/^is_|_required$/.test(key)) return false;
  return null;
}

function at(root: unknown, instancePath: string): Record<string, unknown> | undefined {
  let cur: unknown = root;
  for (const part of instancePath.split("/").filter(Boolean)) {
    cur = (cur as Record<string, unknown>)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur && typeof cur === "object" ? (cur as Record<string, unknown>) : undefined;
}

function repair(name: string, payload: Record<string, unknown>): void {
  const def = name === "ping" ? "ping$event" : name.replace(".", "$");
  const validate = ajv.getSchema(`root#/definitions/${def}`);
  if (!validate) throw new Error(`no schema for ${name}`);
  for (let i = 0; i < 25 && !validate(payload); i++) {
    const errors = (validate.errors ?? []) as ErrorObject[];
    let changed = false;
    for (const e of errors) {
      if (e.keyword !== "required") continue;
      const key = (e.params as { missingProperty: string }).missingProperty;
      const target = at(payload, e.instancePath);
      if (target && !(key in target)) {
        target[key] = neutral(key);
        changed = true;
      }
    }
    if (!changed) throw new Error(`${name}: cannot repair: ${JSON.stringify(errors.slice(0, 3))}`);
  }
  if (!validate(payload)) throw new Error(`${name}: still invalid after repair`);
}

const fixtures: Record<string, Record<string, unknown>> = {};

const TEST_APP_ID = 12345;

/** Read a dotted path out of a JSON-ish value. */
function get(root: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], root);
}

/** A request about one of Graft's own check runs on the PR fixture's head commit. */
function fixCheckRun(p: Record<string, unknown>, checkName = "graft/provenance"): void {
  const pr = rewrite(fixtures["pull_request.opened"]?.pull_request);
  const sha = get(pr, "head.sha") as string;
  p.repository = { ...(p.repository as Record<string, unknown>), ...repo(REPOS.ts) };
  const run = p.check_run as Record<string, unknown>;
  const suite = run.check_suite as Record<string, unknown>;
  run.name = checkName;
  run.head_sha = sha;
  run.external_id = "";
  run.app = { ...(run.app as Record<string, unknown>), id: TEST_APP_ID };
  run.check_suite = {
    ...suite,
    head_sha: sha,
    after: sha,
    app: { ...(suite.app as Record<string, unknown>), id: TEST_APP_ID },
  };
  const side = (s: string) => ({
    ref: get(pr, `${s}.ref`),
    sha: get(pr, `${s}.sha`),
    repo: {
      id: get(pr, `${s}.repo.id`),
      url: get(pr, `${s}.repo.url`),
      name: get(pr, `${s}.repo.name`),
    },
  });
  run.pull_requests = [
    {
      id: get(pr, "id"),
      number: get(pr, "number"),
      url: get(pr, "url"),
      head: side("head"),
      base: side("base"),
    },
  ];
}

{
  // Older upstream example: add the fields the current schema requires.
  const p = pick("ping", undefined);
  const hook = p.hook as Record<string, unknown>;
  hook.deliveries_url ??= `https://api.github.com/hooks/${String(hook.id)}/deliveries`;
  // GitHub App pings carry no repository.
  p.repository = undefined;
  fixtures.ping = p;
}
{
  const p = pick("installation", "created");
  p.repositories = [repo(REPOS.ts), repo(REPOS.py)];
  fixtures["installation.created"] = p;
}
{
  const p = pick("installation", "deleted");
  p.repositories = [repo(REPOS.ts), repo(REPOS.py)];
  fixtures["installation.deleted"] = p;
}
fixtures["installation.suspend"] = pick("installation", "suspend");
fixtures["installation.unsuspend"] = pick("installation", "unsuspend");
fixtures["installation.new_permissions_accepted"] = pick(
  "installation",
  "new_permissions_accepted",
);
{
  const p = pick("installation_repositories", "added");
  p.repository_selection = "selected";
  p.requester ??= null;
  p.repositories_added = [repo(REPOS.py)];
  p.repositories_removed = [];
  p.repositories = undefined;
  fixtures["installation_repositories.added"] = p;
}
{
  const p = pick("installation_repositories", "removed");
  p.repository_selection = "selected";
  p.repositories_added = [];
  p.requester ??= null;
  p.repositories_removed = [repo(REPOS.py)];
  p.repositories = undefined;
  fixtures["installation_repositories.removed"] = p;
}
fixtures["pull_request.opened"] = pick("pull_request", "opened");
fixtures["pull_request.synchronize"] = pick("pull_request", "synchronize");
fixtures["pull_request.reopened"] = pick("pull_request", "reopened");
{
  // The upstream catalog has no `edited` example: clone `opened`.
  const p = pick("pull_request", "opened");
  p.action = "edited";
  p.changes = { body: { from: "Old description." } };
  fixtures["pull_request.edited"] = p;
}
{
  // The upstream catalog has no merged example, so turn the first closed one into a merge.
  const p = pick("pull_request", "closed");
  const pr = p.pull_request as Record<string, unknown>;
  pr.merged = true;
  pr.state = "closed";
  pr.merged_at = pr.closed_at;
  pr.merged_by = pr.user;
  fixtures["pull_request.closed"] = p;
}
fixtures["check_run.rerequested"] = pick("check_run", "rerequested");
// A reviewer clicked "Card is accurate" on the graft/intent check (step 3).
fixtures["check_run.requested_action"] = pick("check_run", "requested_action");

for (const [name, payload] of Object.entries(fixtures)) {
  const rewritten = rewrite(payload) as Record<string, unknown>;
  if (name.startsWith("installation")) fixInstallation(rewritten);
  else if (name !== "ping")
    rewritten.installation = { id: INSTALLATION_ID, node_id: "I_fake1000001" };
  if (name === "check_run.rerequested") fixCheckRun(rewritten);
  if (name === "check_run.requested_action") {
    fixCheckRun(rewritten, "graft/intent");
    rewritten.requested_action = { identifier: "card_up" };
    rewritten.sender = {
      ...(rewritten.sender as Record<string, unknown>),
      login: "reviewer-1",
      id: 5000001,
      type: "User",
    };
  }
  repair(name, rewritten);
  writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify(rewritten, null, 2)}\n`);
  console.log("wrote", name);
}
