import { describe, expect, it } from "vitest";
import { effectiveCeiling } from "../../src/modes/index.js";
import { modesOf } from "../../src/modules/modes/effective.js";
import type { RepositoryModeRow } from "../../src/modules/modes/store.js";

const row = (storedCeiling: string | null): RepositoryModeRow => ({
  repositoryId: 1,
  installationId: 2,
  fullName: "acme/api",
  requested: { policy_mode: "enforce", guard_mode: "enforce", mcp_write: "on" },
  repositoryActive: true,
  installationActive: true,
  permissions: { contents: "write", pull_requests: "write", checks: "write" },
  permissionsReadAt: new Date("2026-10-01T00:00:00Z"),
  storedCeiling,
});

describe("Phase 1 step 7, D2: the ceiling is the lower of the process's and the worker's", () => {
  it("U-CEIL-1 effectiveCeiling", () => {
    expect(effectiveCeiling("enforce", null)).toBe("enforce");
    expect(effectiveCeiling("enforce", undefined)).toBe("enforce");
    expect(effectiveCeiling("enforce", "report")).toBe("report");
    expect(effectiveCeiling("report", "enforce")).toBe("report");
    expect(effectiveCeiling("enforce", "enforce")).toBe("enforce");
    expect(effectiveCeiling("report", null)).toBe("report");
    expect(effectiveCeiling("enforce", "garbage")).toBe("report");
    expect(effectiveCeiling("enforce", "")).toBe("report");
  });

  it("U-CEIL-2 modesOf with a stored report ceiling lowers every requested enforce mode", () => {
    const m = modesOf(row("report"), "enforce");
    expect(m.ceiling).toBe("report");
    expect(m.policy).toMatchObject({
      requested: "enforce",
      effective: "report",
      reason: "ceiling",
    });
    expect(m.guard).toMatchObject({ requested: "enforce", effective: "report", reason: "ceiling" });
    expect(m.mcpWrite).toMatchObject({ requested: "on", effective: "off", reason: "ceiling" });
    // The control: no stored row, the process's enforce applies.
    const open = modesOf(row(null), "enforce");
    expect(open.policy.effective).toBe("enforce");
    expect(open.guard.effective).toBe("enforce");
    expect(open.mcpWrite.effective).toBe("on");
  });
});
