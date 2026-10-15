/**
 * The ONLY way model text, or any other untrusted text, reaches GitHub markdown (step 3, T4).
 * Pure. Step 5 reuses it.
 *
 * Never put untrusted text in a table cell; render it in lists only.
 */

const WORD_JOINER = "⁠";

/** Steps 1-5 shared by both functions. */
function normalize(text: string, maxChars: number): string {
  let t = text.normalize("NFC");
  t = t.replace(/\r\n|[\r\n\t]/g, " ");
  t = t.replace(/[\p{Cc}\p{Cf}]/gu, "");
  t = t.replace(/ {2,}/g, " ").trim();
  const points = Array.from(t);
  if (points.length > maxChars) t = `${points.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
  return t;
}

const SPECIAL = /[\\`*_[\]()<>!|~$&{}#]/g;

/** One line of inline prose, with every markdown, mention, autolink and HTML-comment trick defused. */
export function escapeProse(text: string, maxChars: number): string {
  let t = normalize(text, maxChars).replace(SPECIAL, (c) => `\\${c}`);
  // A line must not become a list item, an ordered list item or a setext heading underline.
  if (/^[-+=]/.test(t)) {
    t = `\\${t}`;
  } else {
    const m = /^\d+(?=[.)]|\\\))/.exec(t);
    if (m) {
      const rest = t.slice(m[0].length);
      t = rest.startsWith(".") ? `${m[0]}\\${rest}` : t; // ")" is already escaped by SPECIAL
    }
  }
  t = t.replace(/[@#]/g, (c) => `${c}${WORD_JOINER}`);
  t = t.replace(/:\/\//g, `:${WORD_JOINER}//`);
  // GitHub turns GH-123 into an issue reference (and a back-reference on the issue).
  t = t.replace(/\b(GH)(?=-\d)/gi, `$1${WORD_JOINER}`);
  t = t.replace(/www\./gi, (m) => `${m.slice(0, 3)}${WORD_JOINER}.`);
  // Unreachable: `<` and `!` are already escaped above; kept for defence in depth. The mutation
  // check for this rule applies to `codeSpan`.
  t = t.replace(/<!--/g, `<${WORD_JOINER}!--`);
  return t;
}

/** Inline code span; never contains a newline or an HTML comment opener. */
export function codeSpan(text: string, maxChars = 200): string {
  const t = normalize(text, maxChars).replace(/<!--/g, `<${WORD_JOINER}!--`);
  if (t === "") return "`(empty)`";
  if (t.includes("`") || t.startsWith(" ") || t.endsWith(" ")) {
    let longest = 0;
    for (const run of t.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
    const fence = "`".repeat(longest + 1);
    return `${fence} ${t} ${fence}`;
  }
  return `\`${t}\``;
}
