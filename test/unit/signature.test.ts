import { verify } from "@octokit/webhooks-methods";
import { describe, expect, it } from "vitest";
import { sign } from "../helpers/sign.js";

const secret = "a-test-secret-of-sufficient-length";
const body = JSON.stringify({ hello: "world" });

describe("signature verification", () => {
  it("U-SIG-1 a correct sha256= signature verifies", async () => {
    expect(await verify(secret, body, sign(body, secret))).toBe(true);
  });

  it("U-SIG-2 a body with one byte changed fails", async () => {
    expect(await verify(secret, `${body} `, sign(body, secret))).toBe(false);
  });

  it("U-SIG-3 a wrong secret fails", async () => {
    expect(await verify(secret, body, sign(body, "another-secret-entirely-different"))).toBe(false);
  });

  it("U-SIG-4 a malformed header fails without throwing", async () => {
    const good = sign(body, secret);
    const hex = good.slice("sha256=".length);
    for (const bad of [`sha1=${hex}`, hex, "sha256=abcd", "sha256=", "garbage"]) {
      let result: boolean | "threw";
      try {
        result = await verify(secret, body, bad);
      } catch {
        result = "threw";
      }
      expect(result, bad).toBe(false);
    }
  });
});
