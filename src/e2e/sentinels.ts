/**
 * Sentinels (D14, T9): unique tokens planted in PR titles, bodies, commit messages and diff lines.
 * INV-3 looks for them in Graft's database; any hit outside the allowed classes is a privacy bug.
 */
import { randomBytes } from "node:crypto";

export const SENTINEL_KINDS = ["T", "B", "C", "D"] as const;
export type SentinelKind = (typeof SENTINEL_KINDS)[number];
export type Sentinels = Record<SentinelKind, string>;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array, n: number): string {
  let out = "";
  for (let i = 0; out.length < n; i++) out += B32[(bytes[i % bytes.length] as number) % 32];
  return out;
}

/** `ZQSNT` + 12 lowercase base32 characters + `-` + kind. */
export function newSentinels(random: (n: number) => Uint8Array = randomBytes): Sentinels {
  const body = `ZQSNT${base32(random(12), 12)}`;
  return { T: `${body}-T`, B: `${body}-B`, C: `${body}-C`, D: `${body}-D` };
}

export const SENTINEL_RE = /ZQSNT[a-z2-7]{12}-[TBCD]/g;

/** Title ends with ` (ref <T>)`. */
export const withTitleSentinel = (title: string, s: Sentinels): string => `${title} (ref ${s.T})`;

/** `<!-- <B> -->` on its own line, before any trailer paragraph. */
export const bodySentinelLine = (s: Sentinels): string => `<!-- ${s.B} -->`;

/** A paragraph between the subject and the trailers. */
export const commitSentinelParagraph = (s: Sentinels): string => `ref ${s.C}`;

/** The comment line a diff adds, by file type. */
export function diffSentinelLine(path: string, s: Sentinels): string {
  return path.endsWith(".md") ? `<!-- ${s.D} -->` : `# ${s.D}`;
}
