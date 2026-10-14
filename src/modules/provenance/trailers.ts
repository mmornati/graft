/** Pure trailer-block parser: git `interpret-trailers` rules, simplified (README / step 2 §6.1). */

export interface Trailer {
  key: string;
  value: string;
}

export interface TrailerBlock {
  trailers: Trailer[];
  /** The text was longer than MAX_MESSAGE_CHARS and was cut from the front (P2). */
  truncated: boolean;
  /** The candidate block had more than MAX_BLOCK_LINES lines and was ignored (P7). */
  blockTooLong: boolean;
}

export const MAX_MESSAGE_CHARS = 16_384;
export const MAX_BLOCK_LINES = 100;

/** Git whitespace: space and tab only (JS trim() also strips U+00A0, U+FEFF, ...). */
export const trimWs = (v: string): string => v.replace(/^[ \t]+|[ \t]+$/g, "");

const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$/;
const KNOWN_KEYS = /^(graft-.*|signed-off-by|co-authored-by)$/i;

export function parseTrailerBlock(text: string, opts: { hasTitle: boolean }): TrailerBlock {
  // P1
  let t = text.replace(/\r\n?/g, "\n");
  // P2
  let truncated = false;
  if (t.length > MAX_MESSAGE_CHARS) {
    truncated = true;
    t = t.slice(-MAX_MESSAGE_CHARS);
    const nl = t.indexOf("\n");
    t = nl === -1 ? "" : t.slice(nl + 1);
  }
  const lines = t.split("\n");
  while (lines.length > 0 && trimWs(lines[lines.length - 1] ?? "") === "") lines.pop();

  // P3: paragraphs separated by whitespace-only lines.
  const paragraphs: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (trimWs(line) === "") {
      if (cur.length > 0) paragraphs.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) paragraphs.push(cur);

  const none = (blockTooLong = false): TrailerBlock => ({ trailers: [], truncated, blockTooLong });
  const block = paragraphs[paragraphs.length - 1];
  if (!block) return none();
  // After a front cut the subject is gone, so the single remaining paragraph is not a subject.
  if (opts.hasTitle && !truncated && paragraphs.length === 1) return none();
  // P7
  if (block.length > MAX_BLOCK_LINES) return none(true);

  // P4
  type Kind = "trailer" | "continuation" | "other";
  const kinds: Kind[] = [];
  for (const line of block) {
    const prev = kinds[kinds.length - 1];
    if (TRAILER_LINE.test(line)) kinds.push("trailer");
    else if (/^[ \t]/.test(line) && (prev === "trailer" || prev === "continuation"))
      kinds.push("continuation");
    else kinds.push("other");
  }

  // P5
  const trailerCount = kinds.filter((k) => k === "trailer").length;
  const allTrailers = kinds.every((k) => k !== "other");
  let accepted = allTrailers;
  if (!accepted && trailerCount / block.length >= 0.25) {
    accepted = block.some((line, i) => {
      if (kinds[i] !== "trailer") return false;
      const m = TRAILER_LINE.exec(line);
      return m !== null && KNOWN_KEYS.test(m[1] ?? "");
    });
  }
  if (!accepted) return none();

  // P6, P8
  const trailers: Trailer[] = [];
  block.forEach((line, i) => {
    const kind = kinds[i];
    if (kind === "trailer") {
      const m = TRAILER_LINE.exec(line);
      if (m) trailers.push({ key: m[1] ?? "", value: trimWs(m[2] ?? "") });
    } else if (kind === "continuation") {
      const last = trailers[trailers.length - 1];
      if (last) last.value = trimWs(`${last.value} ${trimWs(line)}`);
    }
  });
  return { trailers, truncated, blockTooLong: false };
}
