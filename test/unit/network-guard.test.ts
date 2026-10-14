import { describe, expect, it } from "vitest";

describe("network guard", () => {
  it("U-NET-1 fetch to a non-localhost host throws the network-guard error", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(
      "network access in tests: example.com",
    );
  });
});
