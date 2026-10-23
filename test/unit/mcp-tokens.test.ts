import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateToken,
  hashToken,
  parseBearer,
  redactTokens,
  tokenPrefix,
} from "../../src/mcp/tokens.js";

describe("MCP tokens (Phase 1 step 6, D6)", () => {
  it("U-MCPT-1 generateToken: graft_mcp_ + 43 base64url characters, 1,000 distinct; hashToken is SHA-256 hex of the whole string; tokenPrefix is 8 characters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = generateToken();
      expect(t).toMatch(/^graft_mcp_[A-Za-z0-9_-]{43}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(1000);
    const t = generateToken();
    const expected = createHash("sha256").update(t).digest("hex");
    expect(hashToken(t)).toBe(expected);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    // The whole string, prefix included: the secret alone hashes differently.
    expect(hashToken(t)).not.toBe(createHash("sha256").update(t.slice(10)).digest("hex"));
    expect(tokenPrefix(t)).toBe(t.slice(10, 18));
    expect(tokenPrefix(t)).toHaveLength(8);
    expect(tokenPrefix(t)).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it("U-MCPT-2 parseBearer: the exact header only; lower-case bearer, extra spaces, 42 or 44 characters, another prefix, two tokens → null", () => {
    const t = generateToken();
    expect(parseBearer(`Bearer ${t}`)).toBe(t);
    for (const bad of [
      `bearer ${t}`,
      `BEARER ${t}`,
      `Bearer  ${t}`,
      ` Bearer ${t}`,
      `Bearer ${t} `,
      `Bearer ${t.slice(0, -1)}`,
      `Bearer ${t}A`,
      `Bearer ghp_${t.slice(10)}`,
      `Bearer graft_mcq_${t.slice(10)}`,
      `Bearer ${t} ${t}`,
      `Bearer ${t},${t}`,
      `Basic ${t}`,
      t,
      "",
    ]) {
      expect(parseBearer(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer([`Bearer ${t}`, `Bearer ${t}`])).toBeNull();
  });

  it("U-MCPT-3 redactTokens replaces every token-shaped substring and nothing else", () => {
    const a = generateToken();
    const b = generateToken();
    const text = `first ${a}, then (${b})${a} and graft_mcp_short and graft_mcp_ plain`;
    expect(redactTokens(text)).toBe(
      "first graft_mcp_[redacted], then (graft_mcp_[redacted])graft_mcp_[redacted] and graft_mcp_short and graft_mcp_ plain",
    );
    expect(redactTokens("nothing to see")).toBe("nothing to see");
    expect(redactTokens(a)).not.toContain(a.slice(10));
  });
});
