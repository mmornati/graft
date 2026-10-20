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
    });
    expect(m.default_events).toEqual(["check_run", "pull_request", "pull_request_review", "push"]);
    expect(m.public).toBe(false);
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

  it("U-MAN-3 both manifests have the same events", () => {
    expect(manifest("app-manifest.report.json").default_events).toEqual(
      manifest("app-manifest.json").default_events,
    );
  });
});
