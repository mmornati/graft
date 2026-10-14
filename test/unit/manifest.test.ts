import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("github app manifest", () => {
  it("U-MAN-1 permissions and events equal the expected objects; public is false", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../github/app-manifest.json", import.meta.url), "utf8"),
    );
    expect(manifest.default_permissions).toEqual({
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "write",
      checks: "write",
    });
    expect(manifest.default_events).toEqual(["check_run", "pull_request"]);
    expect(manifest.public).toBe(false);
  });
});
