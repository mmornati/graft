import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { summaryCardRoutes } from "../../src/http/summary-card.js";
import {
  cardKey,
  cardMarkdown,
  decodeCard,
  encodeCard,
  renderCardSvg,
} from "../../src/modules/policy/card.js";
import { modelText, type SummaryModel } from "../../src/modules/policy/summary.js";

const KEY = cardKey("a-webhook-secret-of-some-length");

const model = (over: Partial<SummaryModel> = {}): SummaryModel => ({
  level: "orange",
  title: "Needs human review",
  subtitle: "3 things to check · 2 approvals needed",
  headSha: "34290fb5d437cf42a36260e1705b6d341a7376cb",
  report: true,
  gates: [
    { key: "intent", label: "Intent", value: "Matches", status: "ok" },
    { key: "risk", label: "Risk", value: "Sensitive", status: "warn" },
    { key: "ci", label: "CI", value: "15/16 running", status: "running" },
    { key: "review", label: "AI review", value: "Ran", status: "neutral" },
    { key: "approvals", label: "Approvals", value: "0/2", status: "warn" },
  ],
  ...over,
});

describe("summary card", () => {
  it("U-CARD-1 a signed card decodes to the same words; another key or any edit does not", () => {
    const token = encodeCard(model(), KEY);
    expect(decodeCard(token, KEY)).toEqual({ ...model(), headSha: "34290fb" });
    expect(decodeCard(token, cardKey("another-webhook-secret-value"))).toBeNull();
    const [data, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(
      Buffer.from(data, "base64url").toString().replace("Matches", "Matched"),
    ).toString("base64url");
    expect(decodeCard(`${forged}.${sig}`, KEY)).toBeNull();
    expect(decodeCard(`${data}.`, KEY)).toBeNull();
    expect(decodeCard("x".repeat(2000), KEY)).toBeNull();
    expect(decodeCard("garbage", KEY)).toBeNull();
  });

  it("U-CARD-2 only Graft's own words can be signed: markup and mentions are refused", () => {
    expect(() => encodeCard(model({ title: "<script>" }), KEY)).toThrow();
    expect(() => encodeCard(model({ subtitle: "@octocat" }), KEY)).toThrow();
    const gates = model().gates.map((g) => (g.key === "ci" ? { ...g, value: "a&b" } : g));
    expect(() => encodeCard(model({ gates }), KEY)).toThrow();
  });

  it("U-CARD-3 the SVG shows the verdict, the gates and the readiness in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const svg = renderCardSvg(model({ title: "Don't merge yet", level: "red" }), theme);
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg).toContain("Don&apos;t merge yet");
      expect(svg).toContain("15/16 running");
      expect(svg).toContain("1 of 5 gates");
      expect(svg).toContain("Head 34290fb · report mode, Graft blocks nothing");
      expect(svg).not.toMatch(/<script|onload|href=/i);
    }
    expect(renderCardSvg(model(), "dark")).toContain("#0d1117");
    expect(renderCardSvg(model(), "light")).toContain("#ffffff");
  });

  it("U-CARD-4 the markdown is a picture with a dark source and an alt text that says it all", () => {
    const md = cardMarkdown(model(), { publicUrl: "https://graft.example.com", key: KEY });
    const token = encodeCard(model(), KEY);
    expect(md).toBe(
      `<picture><source media="(prefers-color-scheme: dark)" srcset="https://graft.example.com/summary-card/${token}.svg?theme=dark"><img alt="Needs human review: 3 things to check · 2 approvals needed. Intent: Matches. Risk: Sensitive. CI: 15/16 running. AI review: Ran. Approvals: 0/2." src="https://graft.example.com/summary-card/${token}.svg?theme=light" width="720"></picture>`,
    );
    expect(modelText(model({ subtitle: "" }))).toMatch(/^Needs human review\. Intent: Matches\./);
  });

  it("U-CARD-5 the route serves a valid card as an immutable SVG and 404s anything else", async () => {
    const app = Fastify();
    await app.register(summaryCardRoutes({ key: KEY }));
    const token = encodeCard(model(), KEY);
    const ok = await app.inject({ url: `/summary-card/${token}.svg?theme=dark` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
    expect(ok.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.body).toContain("#0d1117");
    const light = await app.inject({ url: `/summary-card/${token}.svg?theme=<x>` });
    expect(light.body).toContain("#ffffff");
    for (const url of [
      `/summary-card/${token}`,
      `/summary-card/${token}x.svg`,
      "/summary-card/a.b.svg",
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(404);
    }
    await app.close();
  });
});
