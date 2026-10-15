/** Glob validation for `graft.yaml` (spec §6.2). Pure. */
import picomatch from "picomatch";
import { normalizeGlob } from "../core/glob.js";
import { LIMITS } from "./constants.js";

const ALLOWED = /^[\p{L}\p{N}_.\-/*?[\]@+=~#%, ]+$/u;

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
