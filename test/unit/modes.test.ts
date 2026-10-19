import { describe, expect, it } from "vitest";
import {
  type EffectiveModesInput,
  effectiveModes,
  lowest,
  type Mode,
  PERMISSION_NEEDS,
  type PermissionLevel,
  type Switch,
} from "../../src/modes/index.js";

const base = (over: Partial<EffectiveModesInput> = {}): EffectiveModesInput => ({
  ceiling: "enforce",
  requested: { policy_mode: "enforce", guard_mode: "enforce", mcp_write: "on" },
  permissions: { contents: "write", pull_requests: "write", checks: "write" },
  installationActive: true,
  repositoryActive: true,
  ...over,
});

describe("effective modes", () => {
  it("U-MODE-1 all defaults give report/report/off with reason repository", () => {
    const m = effectiveModes({
      ceiling: "report",
      requested: { policy_mode: "report", guard_mode: "report", mcp_write: "off" },
      permissions: null,
      installationActive: true,
      repositoryActive: true,
    });
    expect(m.ceiling).toBe("report");
    expect(m.policy).toEqual({ requested: "report", effective: "report", reason: "repository" });
    expect(m.guard).toEqual({ requested: "report", effective: "report", reason: "repository" });
    expect(m.mcpWrite).toEqual({ requested: "off", effective: "off", reason: "repository" });
  });

  it("U-MODE-2 requested enforce under a report ceiling is report with reason ceiling; mcp_write on is off", () => {
    const m = effectiveModes(base({ ceiling: "report" }));
    expect(m.policy).toMatchObject({
      requested: "enforce",
      effective: "report",
      reason: "ceiling",
    });
    expect(m.guard).toMatchObject({ requested: "enforce", effective: "report", reason: "ceiling" });
    expect(m.mcpWrite).toMatchObject({ requested: "on", effective: "off", reason: "ceiling" });
  });

  it("U-MODE-3 contents: read lowers the guard (permission_missing, contents:write); policy stays enforce", () => {
    const m = effectiveModes(
      base({ permissions: { contents: "read", pull_requests: "write", checks: "write" } }),
    );
    expect(m.guard).toEqual({
      requested: "enforce",
      effective: "report",
      reason: "permission_missing",
      missing: "contents:write",
    });
    expect(m.policy).toMatchObject({ effective: "enforce", reason: "repository" });
    expect(m.mcpWrite).toMatchObject({ effective: "on", reason: "repository" });
    // An absent permission is missing too.
    const none = effectiveModes(base({ permissions: {} }));
    expect(none.guard).toMatchObject({ reason: "permission_missing", missing: "contents:write" });
    expect(none.mcpWrite).toMatchObject({
      effective: "off",
      reason: "permission_missing",
      missing: "pull_requests:write",
    });
  });

  it("U-MODE-4 permissions never read: guard and mcp are permissions_unknown, policy stays enforce", () => {
    const m = effectiveModes(base({ permissions: null }));
    expect(m.guard).toMatchObject({ effective: "report", reason: "permissions_unknown" });
    expect(m.mcpWrite).toMatchObject({ effective: "off", reason: "permissions_unknown" });
    expect(m.policy).toMatchObject({ effective: "enforce", reason: "repository" });
    expect(m.guard.missing).toBeUndefined();
  });

  it("U-MODE-5 contents: admin satisfies write", () => {
    const m = effectiveModes(base({ permissions: { contents: "admin", pull_requests: "admin" } }));
    expect(m.guard).toMatchObject({ effective: "enforce", reason: "repository" });
    expect(m.mcpWrite).toMatchObject({ effective: "on", reason: "repository" });
  });

  it("U-MODE-6 an inactive installation beats every other reason; a removed repository beats the ceiling", () => {
    const inactive = effectiveModes(
      base({
        ceiling: "report",
        permissions: null,
        installationActive: false,
        repositoryActive: false,
      }),
    );
    for (const s of [inactive.policy, inactive.guard, inactive.mcpWrite]) {
      expect(s.reason).toBe("installation_inactive");
      expect(["report", "off"]).toContain(s.effective);
    }
    const removed = effectiveModes(base({ ceiling: "report", repositoryActive: false }));
    for (const s of [removed.policy, removed.guard, removed.mcpWrite]) {
      expect(s.reason).toBe("repository_removed");
    }
    // A key already at report/off says "repository" only when the repository is usable.
    const idle = effectiveModes(
      base({
        requested: { policy_mode: "report", guard_mode: "report", mcp_write: "off" },
        installationActive: false,
      }),
    );
    expect(idle.policy.reason).toBe("installation_inactive");
  });

  it("U-MODE-7 for every combination, effective is never above requested, the ceiling or the permissions", () => {
    const modes: Mode[] = ["report", "enforce"];
    const switches: Switch[] = ["off", "on"];
    const levels: (PermissionLevel | undefined)[] = [undefined, "read", "write", "admin"];
    const perms: EffectiveModesInput["permissions"][] = [null];
    for (const contents of levels) {
      for (const pr of levels) {
        perms.push({
          ...(contents ? { contents } : {}),
          ...(pr ? { pull_requests: pr } : {}),
        });
      }
    }
    let cases = 0;
    for (const ceiling of modes)
      for (const policy_mode of modes)
        for (const guard_mode of modes)
          for (const mcp_write of switches)
            for (const permissions of perms)
              for (const installationActive of [true, false])
                for (const repositoryActive of [true, false]) {
                  const m = effectiveModes({
                    ceiling,
                    requested: { policy_mode, guard_mode, mcp_write },
                    permissions,
                    installationActive,
                    repositoryActive,
                  });
                  cases++;
                  const usable = installationActive && repositoryActive;
                  const tag = JSON.stringify({
                    ceiling,
                    policy_mode,
                    guard_mode,
                    mcp_write,
                    permissions,
                    installationActive,
                    repositoryActive,
                  });
                  expect(lowest(["report", "enforce"], m.policy.effective, policy_mode), tag).toBe(
                    m.policy.effective,
                  );
                  expect(lowest(["report", "enforce"], m.guard.effective, guard_mode), tag).toBe(
                    m.guard.effective,
                  );
                  expect(lowest(["off", "on"], m.mcpWrite.effective, mcp_write), tag).toBe(
                    m.mcpWrite.effective,
                  );
                  for (const eff of [
                    m.policy.effective === "enforce",
                    m.guard.effective === "enforce",
                    m.mcpWrite.effective === "on",
                  ]) {
                    if (eff) {
                      expect(ceiling, tag).toBe("enforce");
                      expect(usable, tag).toBe(true);
                    }
                  }
                  if (m.guard.effective === "enforce") {
                    const [name, need] = PERMISSION_NEEDS.guard_mode[0];
                    expect(permissions?.[name], tag).toMatch(
                      need === "write" ? /write|admin/ : /.*/,
                    );
                  }
                  if (m.mcpWrite.effective === "on") {
                    expect(permissions?.pull_requests, tag).toMatch(/write|admin/);
                  }
                }
    expect(cases).toBe(2 * 2 * 2 * 2 * perms.length * 2 * 2);
  });
});
