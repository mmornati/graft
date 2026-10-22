import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { fixtureNames, loadFixture } from "../helpers/fixtures.js";

const require = createRequire(import.meta.url);
const schema = require("@octokit/webhooks-schemas") as Record<string, unknown>;

const EXPECTED = [
  // Phase 1 step 4: guard triggers.
  "check_run.completed",
  "check_run.requested_action",
  "check_run.rerequested",
  "check_suite.completed",
  "installation.created",
  "installation.deleted",
  "installation.new_permissions_accepted",
  "installation.suspend",
  "installation.unsuspend",
  "installation_repositories.added",
  "installation_repositories.removed",
  // Phase 1 step 2: team and membership triggers.
  "membership.added",
  "ping",
  "pull_request.closed",
  "pull_request.edited",
  "pull_request.labeled",
  // Phase 1 step 3: the break-glass label (a variant of pull_request.labeled).
  "pull_request.labeled.break-glass",
  "pull_request.opened",
  "pull_request.reopened",
  "pull_request.synchronize",
  "pull_request_review.dismissed",
  "pull_request_review.submitted",
  "push",
  "push.default",
  "status",
  "team.deleted",
];

// Definitions are named "<event>$<action>" ("ping$event" for ping). A third part names a variant.
const definitionFor = (name: string): string =>
  name === "ping" || name === "push" || name === "status"
    ? `${name}$event`
    : name === "push.default"
      ? "push$event"
      : name.split(".").slice(0, 2).join("$");

describe("webhook fixtures", () => {
  it("has exactly the fixtures from the spec", () => {
    expect(fixtureNames()).toEqual(EXPECTED);
  });

  it("U-FIX-1 every fixture validates against @octokit/webhooks-schemas", () => {
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema(schema, "root");
    for (const name of fixtureNames()) {
      const { payload } = loadFixture(name);
      const validate = ajv.getSchema(`root#/definitions/${definitionFor(name)}`);
      if (!validate) throw new Error(`no validator for ${name}`);
      const ok = validate(payload);
      expect(ok, `${name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
    }
  });

  it("U-FIX-2 every fixture uses installation 1000001 and only graft-sandbox repos", () => {
    for (const name of fixtureNames()) {
      const { payload } = loadFixture(name);
      const installation = payload.installation as { id: number } | undefined;
      if (installation) expect(installation.id, name).toBe(1000001);
      const fullNames: string[] = [];
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            if (k === "full_name" && typeof x === "string") fullNames.push(x);
            else walk(x);
          }
        }
      };
      walk(payload);
      for (const fn of fullNames) expect(fn, name).toMatch(/^graft-sandbox\/sample-(ts|py)$/);
    }
  });

  it("U-FIX-3 the push fixture targets the PR fixture's base branch, so the smoke fan-out finds the PR", () => {
    const push = loadFixture("push").payload as { ref: string; repository: { id: number } };
    const opened = loadFixture("pull_request.opened").payload as {
      pull_request: { base: { ref: string } };
      repository: { id: number };
    };
    expect(push.ref).toBe(`refs/heads/${opened.pull_request.base.ref}`);
    expect(push.repository.id).toBe(opened.repository.id);
  });
});
