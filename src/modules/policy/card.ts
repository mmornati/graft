/**
 * The status card image at the top of the review summary: the verdict, a "ready to merge" bar and
 * the five gates, drawn as an SVG in a light and a dark version.
 *
 * Stateless: the image URL carries the card's words, signed with a key derived from the webhook
 * secret, and the server only checks the signature and draws. Nothing is read from the database,
 * and the URL holds nothing the comment does not already show. Only Graft-written words go into a
 * card (labels, gate values, the verdict); every one is checked against a closed character set on
 * the way in and escaped as XML on the way out. The URL changes whenever the card does, so the
 * image can be cached for good (GitHub's image proxy caches it too).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { GateKey, GateStatus, Level, SummaryModel } from "./summary.js";
import { modelText } from "./summary.js";

export const CARD_PATH = "/summary-card";
const SIG_BYTES = 16;
const MAX_TOKEN_CHARS = 1500;

const LEVELS = ["pending", "red", "orange", "yellow", "green"] as const;
const STATUSES = ["ok", "warn", "bad", "neutral", "running"] as const;
const KEYS = ["intent", "risk", "ci", "review", "approvals"] as const;
/** Graft's own words only: letters, digits, spaces and a few marks. */
const WORDS = /^[A-Za-z0-9 ./·'-]*$/u;
const words = (max: number) => z.string().max(max).regex(WORDS);

const payloadSchema = z.strictObject({
  v: z.literal(1),
  l: z.enum(LEVELS),
  t: words(40),
  s: words(80),
  g: z.array(z.tuple([z.enum(KEYS), words(24), z.enum(STATUSES)])).length(5),
  h: z.string().regex(/^[0-9a-f]{7}$/),
  r: z.union([z.literal(0), z.literal(1)]),
});
type Payload = z.infer<typeof payloadSchema>;

export function cardKey(webhookSecret: string): Buffer {
  return createHmac("sha256", webhookSecret).update("graft summary card v1").digest();
}

const b64 = (b: Buffer) => b.toString("base64url");
const sign = (key: Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest().subarray(0, SIG_BYTES);

const GATE_LABEL: Record<GateKey, string> = {
  intent: "Intent",
  risk: "Risk",
  ci: "CI",
  review: "AI review",
  approvals: "Approvals",
};

export function encodeCard(m: SummaryModel, key: Buffer): string {
  const p: Payload = {
    v: 1,
    l: m.level,
    t: m.title,
    s: m.subtitle,
    g: m.gates.map((g) => [g.key, g.value, g.status]),
    h: m.headSha.slice(0, 7),
    r: m.report ? 1 : 0,
  };
  // Refuse to sign anything the decoder would refuse: a bug shows here, not as a broken image.
  payloadSchema.parse(p);
  const data = b64(Buffer.from(JSON.stringify(p)));
  return `${data}.${b64(sign(key, data))}`;
}

/** null for anything not signed by this server or not a valid card. */
export function decodeCard(token: string, key: Buffer): SummaryModel | null {
  if (token.length > MAX_TOKEN_CHARS) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), "base64url");
  const want = sign(key, data);
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const res = payloadSchema.safeParse(raw);
  if (!res.success) return null;
  const p = res.data;
  if (p.g.some(([k], n) => k !== KEYS[n])) return null;
  return {
    level: p.l,
    title: p.t,
    subtitle: p.s,
    gates: p.g.map(([key, value, status]) => ({ key, label: GATE_LABEL[key], value, status })),
    headSha: p.h,
    report: p.r === 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const attr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A `<picture>` that follows the reader's light or dark theme. */
export function cardMarkdown(m: SummaryModel, o: { publicUrl: string; key: Buffer }): string {
  const url = `${o.publicUrl}${CARD_PATH}/${encodeCard(m, o.key)}.svg`;
  return [
    "<picture>",
    `<source media="(prefers-color-scheme: dark)" srcset="${attr(`${url}?theme=dark`)}">`,
    `<img alt="${attr(modelText(m))}" src="${attr(`${url}?theme=light`)}" width="${WIDTH}">`,
    "</picture>",
  ].join("");
}

// ---------------------------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------------------------

export type Theme = "light" | "dark";

interface Palette {
  bg: string;
  border: string;
  text: string;
  muted: string;
  track: string;
  status: Record<GateStatus, { fg: string; bg: string }>;
}

const PALETTE: Record<Theme, Palette> = {
  light: {
    bg: "#ffffff",
    border: "#d1d9e0",
    text: "#1f2328",
    muted: "#59636e",
    track: "#d1d9e0",
    status: {
      ok: { fg: "#1a7f37", bg: "#dafbe1" },
      warn: { fg: "#9a6700", bg: "#fff8c5" },
      bad: { fg: "#cf222e", bg: "#ffebe9" },
      running: { fg: "#0969da", bg: "#ddf4ff" },
      neutral: { fg: "#59636e", bg: "#f6f8fa" },
    },
  },
  dark: {
    bg: "#0d1117",
    border: "#3d444d",
    text: "#f0f6fc",
    muted: "#9198a1",
    track: "#3d444d",
    status: {
      ok: { fg: "#3fb950", bg: "#12261e" },
      warn: { fg: "#d29922", bg: "#272115" },
      bad: { fg: "#f85149", bg: "#2d1214" },
      running: { fg: "#58a6ff", bg: "#121d2f" },
      neutral: { fg: "#9198a1", bg: "#151b23" },
    },
  },
};

const LEVEL_STATUS: Record<Level, GateStatus> = {
  pending: "running",
  green: "ok",
  yellow: "neutral",
  orange: "warn",
  red: "bad",
};
const LEVEL_GLYPH: Record<Level, string> = {
  pending: "…",
  green: "✓",
  yellow: "i",
  orange: "!",
  red: "×",
};

const WIDTH = 720;
const HEIGHT = 156;
const PAD = 20;
const GAP = 8;
const FONT =
  "-apple-system, BlinkMacSystemFont, &apos;Segoe UI&apos;, &apos;Noto Sans&apos;, Helvetica, Arial, sans-serif";

const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function renderCardSvg(m: SummaryModel, theme: Theme): string {
  const c = PALETTE[theme];
  const lead = c.status[LEVEL_STATUS[m.level]];
  const passed = m.gates.filter((g) => g.status === "ok").length;
  const tileW = (WIDTH - 2 * PAD - 4 * GAP) / 5;
  const segW = 22;
  const barX = WIDTH - PAD - (5 * segW + 4 * 3);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${xml(modelText(m))}" font-family="${FONT}">`,
    `<title>${xml(modelText(m))}</title>`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="12" fill="${c.bg}" stroke="${c.border}"/>`,
    `<circle cx="${PAD + 18}" cy="${PAD + 18}" r="18" fill="${lead.bg}"/>`,
    `<text x="${PAD + 18}" y="${PAD + 25}" text-anchor="middle" font-size="20" font-weight="700" fill="${lead.fg}">${xml(LEVEL_GLYPH[m.level])}</text>`,
    `<text x="${PAD + 48}" y="${PAD + 15}" font-size="17" font-weight="600" fill="${c.text}">${xml(m.title)}</text>`,
    `<text x="${PAD + 48}" y="${PAD + 34}" font-size="13" fill="${c.muted}">${xml(m.subtitle)}</text>`,
    `<text x="${WIDTH - PAD}" y="${PAD + 8}" text-anchor="end" font-size="11" fill="${c.muted}">Ready to merge</text>`,
  ];
  m.gates.forEach((g, n) => {
    const fill = g.status === "ok" ? c.status.ok.fg : c.track;
    parts.push(
      `<rect x="${barX + n * (segW + 3)}" y="${PAD + 15}" width="${segW}" height="6" rx="3" fill="${fill}"/>`,
    );
  });
  parts.push(
    `<text x="${WIDTH - PAD}" y="${PAD + 36}" text-anchor="end" font-size="11" fill="${c.muted}">${passed} of 5 gates</text>`,
  );
  const tileY = PAD + 54;
  m.gates.forEach((g, n) => {
    const x = PAD + n * (tileW + GAP);
    const s = c.status[g.status];
    parts.push(
      `<rect x="${x}" y="${tileY}" width="${tileW}" height="50" rx="8" fill="${s.bg}"/>`,
      `<text x="${x + 10}" y="${tileY + 19}" font-size="11" fill="${s.fg}">${xml(g.label)}</text>`,
      `<text x="${x + 10}" y="${tileY + 38}" font-size="14" font-weight="600" fill="${g.status === "neutral" ? c.text : s.fg}">${xml(g.value)}</text>`,
    );
  });
  parts.push(
    `<text x="${PAD}" y="${HEIGHT - 12}" font-size="11" fill="${c.muted}">Head ${xml(m.headSha.slice(0, 7))}${m.report ? " · report mode, Graft blocks nothing" : ""}</text>`,
    "</svg>",
  );
  return parts.join("");
}
