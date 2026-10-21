import { describe, expect, it } from "vitest";
import {
  atLeast,
  type CollaboratorRole,
  collaboratorRole,
  roleFrom,
} from "../../src/github/collaborator.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { fakeGitHubFactory } from "../helpers/app.js";
import { createFakeGitHubApi } from "../helpers/fake-github-api.js";
import { INSTALLATION_ID, OWNER, REPO } from "../helpers/github-builders.js";

async function setup() {
  const api = createFakeGitHubApi();
  const octokit = await fakeGitHubFactory(api).forInstallation(INSTALLATION_ID);
  const ask = (login: string, id: number) =>
    collaboratorRole(octokit, { owner: OWNER, repo: REPO, user: { id, login } });
  return { api, ask };
}

describe("collaborator role (Phase 1 step 2, D16)", () => {
  it("U-COL-1 role_name admin/maintain/write/triage/read map to roles; a custom role is judged by its base permission", async () => {
    const { api, ask } = await setup();
    const named: CollaboratorRole[] = ["admin", "maintain", "write", "triage", "read"];
    for (const [i, role] of named.entries()) {
      api.state.permissions.set(`u-${role}`, { id: 10 + i, role });
      expect(await ask(`u-${role}`, 10 + i), role).toEqual({ role, denied: null });
    }
    api.state.permissions.set("custom-w", { id: 30, role: "release-manager", permission: "write" });
    api.state.permissions.set("custom-a", { id: 31, role: "owner-ish", permission: "admin" });
    api.state.permissions.set("custom-r", { id: 32, role: "Triage", permission: "read" });
    expect(await ask("custom-w", 30)).toEqual({ role: "write", denied: null });
    expect(await ask("custom-a", 31)).toEqual({ role: "admin", denied: null });
    expect(await ask("custom-r", 32)).toEqual({ role: "read", denied: null });
    expect(roleFrom({ role_name: "none", permission: "none" })).toBe("none");
    expect(roleFrom({})).toBe("none");
  });

  it("U-COL-2 404 and 403 fail closed with the status; a 5xx throws a retryable job error", async () => {
    const { api, ask } = await setup();
    expect(await ask("stranger", 40)).toEqual({ role: "none", denied: 404 });
    api.state.permissions.set("hidden", { id: 41, role: "admin" });
    api.failNext("GET", /\/collaborators\/hidden\/permission$/, 403);
    expect(await ask("hidden", 41)).toEqual({ role: "none", denied: 403 });
    api.failNext("GET", /\/collaborators\/hidden\/permission$/, 502);
    const err = await ask("hidden", 41).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    api.failNext("GET", /\/collaborators\/hidden\/permission$/, 403, {
      "x-ratelimit-remaining": "0",
    });
    const limited = await ask("hidden", 41).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(Error);
    expect(limited).not.toBeInstanceOf(PermanentJobError);
  });

  it("U-COL-3 a response for another user id (a recycled login), or with no user, is none", async () => {
    const { api, ask } = await setup();
    api.state.permissions.set("recycled", { id: 99999, role: "admin" });
    expect(await ask("recycled", 50)).toEqual({ role: "none", denied: null });
    api.state.permissions.set("anonymous", { id: 51, role: "admin", noUser: true });
    expect(await ask("anonymous", 51)).toEqual({ role: "none", denied: null });
  });

  it("U-COL-4 atLeast orders the roles; triage is not write, maintain is", () => {
    const order: CollaboratorRole[] = ["none", "read", "triage", "write", "maintain", "admin"];
    for (const [i, role] of order.entries()) {
      for (const [j, min] of order.entries()) {
        if (min === "none") continue;
        expect(atLeast(role, min), `${role} >= ${min}`).toBe(i >= j);
      }
    }
    expect(atLeast("triage", "write")).toBe(false);
    expect(atLeast("maintain", "write")).toBe(true);
    expect(atLeast("write", "triage")).toBe(true);
    expect(atLeast("read", "triage")).toBe(false);
  });
});
