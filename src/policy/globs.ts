/** Glob validation for `graft.yaml` (spec §6.2). Pure. */
import picomatch from "picomatch";
import { normalizeGlob } from "../core/glob.js";
import { LIMITS } from "./constants.js";

// Letters, combining marks (an accent written as two code points), digits and the symbols below.
const ALLOWED = /^[\p{L}\p{M}\p{N}_.\-/*?[\]@+=~#%, ]+$/u;

/**
 * Scripts told apart for the lookalike check (D14). Any other letter is its own `Other:` bucket
 * (see `scriptOf`), so two unlisted scripts never combine either.
 */
const SCRIPTS: readonly (readonly [string, RegExp])[] = [
  "Latin",
  "Greek",
  "Cyrillic",
  "Armenian",
  "Hebrew",
  "Arabic",
  "Han",
  "Hiragana",
  "Katakana",
  "Hangul",
  "Bopomofo",
  "Thai",
  "Devanagari",
  "Georgian",
  "Bengali",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Gujarati",
  "Gurmukhi",
  "Sinhala",
  "Lao",
  "Khmer",
  "Myanmar",
  "Tibetan",
  "Ethiopic",
  "Cherokee",
  "Mongolian",
  "Syriac",
  "Thaana",
  "Coptic",
].map((name) => [name, new RegExp(`^\\p{Script=${name}}$`, "u")] as const);
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
const COMMON_OR_INHERITED = /^[\p{Script=Common}\p{Script=Inherited}]$/u;

/** The script of one letter; null for Common and Inherited (digits, punctuation, marks). */
function scriptOf(ch: string): string | null {
  if (COMMON_OR_INHERITED.test(ch)) return null;
  for (const [name, re] of SCRIPTS) if (re.test(ch)) return name;
  return "Other";
}

// UTS #39 "highly restrictive": one script, or Latin with Han+Hiragana+Katakana (Japanese), with
// Han+Bopomofo (Chinese), or with Han+Hangul (Korean).
const ALLOWED_MIXES: readonly ReadonlySet<string>[] = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Bopomofo"]),
  new Set(["Latin", "Han", "Hangul"]),
];

/** True when the letters of one path segment come from scripts that should not mix. */
export function mixesScripts(segment: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII fast path
  if (/^[\x00-\x7f]*$/.test(segment)) return false;
  const found = new Set<string>();
  for (const ch of segment) {
    if (!/^\p{L}$/u.test(ch)) continue;
    const sc = scriptOf(ch);
    if (sc !== null) found.add(sc);
  }
  if (found.size <= 1) return false;
  return !ALLOWED_MIXES.some((allowed) => [...found].every((x) => allowed.has(x)));
}

/** The distinct code points above U+007F, as `U+XXXX`, at most `max` (never the text itself). */
export function nonAsciiCodePoints(glob: string, max = 5): string[] {
  const out: string[] = [];
  for (const ch of glob) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x7f) continue;
    const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    if (!out.includes(label)) out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Returns null for a valid glob, or the `glob_invalid` detail (1 to 8, spec §8):
 * 1 empty or too long, 2 character not allowed, 3 `..` or empty segment, 4 more than 4 `**`
 * segments, 5 more than 3 `*` in one segment, 6 unbalanced `[ ]` or a `/` inside one, 7 does not compile (picomatch rejects it, or it holds `***`, `]+` or a `**` glued to other characters), 8 too
 * costly (more than 48 characters other than `*` in one segment, or 96 in all).
 */
export function validateGlob(glob: string): number | null {
  const chars = Array.from(glob);
  if (chars.length === 0 || chars.length > LIMITS.globChars) return 1;
  if (!ALLOWED.test(glob)) return 2;
  // Invisible characters (a combining grapheme joiner, variation selectors, zero-width spaces)
  // and combining marks that do not follow a letter make a glob read like another one.
  if (INVISIBLE.test(glob)) return 2;
  let afterLetter = false;
  for (const ch of glob) {
    if (/^\p{M}$/u.test(ch)) {
      if (!afterLetter) return 2;
    } else {
      afterLetter = /^\p{L}$/u.test(ch);
    }
  }
  // Compatibility characters (fullwidth forms, mathematical alphanumerics, the Kelvin, Angstrom
  // and Ohm signs, CJK compatibility ideographs) fold to other characters under NFKC. Checked
  // one code point at a time, so that precomposed letters, lone combining accents and Hangul
  // jamo (stable on their own) stay valid.
  for (const ch of glob) if (ch.normalize("NFKC") !== ch) return 10;
  // D14: `sеcrets/**` with a Cyrillic е reads right and never matches, which would silently loosen
  // a tightening rule. Per segment, so `руководство/docs/**` stays valid.
  for (const seg of glob.split("/")) if (mixesScripts(seg)) return 9;

  const body = glob.startsWith("/") ? glob.slice(1) : glob;
  const segments = body.split("/");
  if (segments.some((s) => s === "" || s === "..")) return 3;

  let doubleStars = 0;
  for (const s of segments) if (s === "**") doubleStars++;
  if (doubleStars > 4) return 4;
  for (const s of segments) {
    if (s === "**") continue;
    let stars = 0;
    for (const c of s) if (c === "*") stars++;
    if (stars > 3) return 5;
  }

  let open = false;
  for (const c of glob) {
    if (c === "[") {
      if (open) return 6;
      open = true;
    } else if (c === "]") {
      if (!open) return 6;
      open = false;
    } else if (c === "/" && open) {
      // The matcher splits at `/` first; picomatch would read `[a/b]` as one class.
      return 6;
    }
  }
  if (open) return 6;

  // Cost cap: the work of one match is about path length x pattern length, so bound the pattern.
  let total = 0;
  for (const s of segments) {
    if (s === "**") continue;
    let n = 0;
    for (const c of s) if (c !== "*") n++;
    if (n > LIMITS.globSegmentChars) return 8;
    total += n;
  }
  if (total > LIMITS.globTotalChars) return 8;

  // picomatch passes `]+` through as a regex quantifier and gives `***` odd zero-width matches; the
  // segment matcher (`src/core/glob.ts`) does not model either, so they do not compile (detail 7).
  if (/\*{3,}|\]\+/.test(glob)) return 7;
  // `**` glued to other characters (`/**.pem`, `a**b`): picomatch reads it as "any characters
  // across `/`", the segment matcher as `*`. The two differ, and the ambiguous form is rejected
  // (detail 7) so a tightening glob can never match less than its author meant.
  for (const seg of segments) if (seg !== "**" && seg.includes("**")) return 7;

  try {
    const re = picomatch.makeRe(normalizeGlob(glob), { dot: true, nocase: true });
    // picomatch answers a pattern it cannot compile (`[z-a]`) with the never-matching `$^`.
    if (re.source === "$^" || re.source.length > LIMITS.globRegexChars) return 7;
  } catch {
    return 7;
  }
  return null;
}
