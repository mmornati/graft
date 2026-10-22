import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../github/${name}`, import.meta.url), "utf8")) as {
    default_permissions: Record<string, string>;
    default_events: string[];
    public: boolean;
    name: string;
    description: string;
  };

describe("github app manifest", () => {
  it("U-MAN-1 permissions and events equal the expected objects; public is false", () => {
    const m = manifest("app-manifest.json");
    expect(m.default_permissions).toEqual({
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "write",
      checks: "write",
      // Phase 1 step 2: team constraints (D15).
      members: "read",
      // Phase 1 step 4: commit statuses for the post-merge guard (D2).
      statuses: "read",
    });
    expect(m.default_events).toEqual([
      "check_run",
      "check_suite",
      "membership",
      "pull_request",
      "pull_request_review",
      "push",
      "status",
      "team",
    ]);
    expect(m.public).toBe(false);
  });

  it("U-MAN-4 members is never above read, in either manifest; both carry the membership and team events", () => {
    for (const name of ["app-manifest.json", "app-manifest.report.json"]) {
      const m = manifest(name);
      expect(m.default_permissions.members, name).toBe("read");
      expect(m.default_events, name).toEqual(expect.arrayContaining(["membership", "team"]));
    }
  });

  it("U-MAN-2 the report manifest's permissions are a subset of the full one's, and only checks and pull_requests are above read", () => {
    const full = manifest("app-manifest.json");
    const report = manifest("app-manifest.report.json");
    const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
    for (const [name, level] of Object.entries(report.default_permissions)) {
      expect(full.default_permissions[name], name).toBeDefined();
      expect(rank[level], name).toBeLessThanOrEqual(
        rank[full.default_permissions[name] as string] as number,
      );
      if (name !== "checks" && name !== "pull_requests") {
        expect(level, `${name} must stay read-only`).toBe("read");
      }
    }
    expect(report.public).toBe(false);
    expect(report.name).toMatch(/report only/i);
    expect(report.description).toMatch(/report only/i);
  });

  it("U-MAN-5 statuses is never above read and neither manifest has actions; both carry check_suite and status", () => {
    for (const name of ["app-manifest.json", "app-manifest.report.json"]) {
      const m = manifest(name);
      expect(m.default_permissions.statuses, name).toBe("read");
      expect(m.default_permissions, name).not.toHaveProperty("actions");
      expect(m.default_events, name).toEqual(expect.arrayContaining(["check_suite", "status"]));
      expect(m.default_events, name).not.toContain("workflow_run");
    }
  });

  it("U-MAN-3 both manifests have the same events", () => {
    expect(manifest("app-manifest.report.json").default_events).toEqual(
      manifest("app-manifest.json").default_events,
    );
  });
});
