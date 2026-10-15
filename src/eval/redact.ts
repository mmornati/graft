/**
 * Redaction (E14, §6.4): secrets always, other kinds on request. Line by line, never changing the
 * line count and never touching paths, statuses or counts. Values are never recorded: only
 * `{kind, count}`.
 */
import type { CardInputs } from "../modules/intent/index.js";

export interface RedactOptions {
  emails?: boolean;
  hosts?: readonly string[];
  /** Regular expression sources; kind `custom`. */
  patterns?: readonly string[];
}

export interface RedactionCount {
  kind: string;
  count: number;
}

/*
 * Secret rules (E14, widened beyond the §6.4 table; see README §7). Every pattern is bounded: the
 * quantifiers that follow an open prefix are capped, so a long adversarial line cannot cause
 * catastrophic backtracking (test U-RED-12).
 */
const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "aws_key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // OpenAI keys: `sk-`, `sk-proj-`, `sk-svcacct-` followed by a long token. Runs after anthropic.
  { kind: "openai_key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe_key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { kind: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
];

/** `scheme://user:PASSWORD@host`: only the password is replaced. */
const URL_CREDENTIALS =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/[^\s:/@"'`]{1,100}:)([^\s@/"'`]{1,200})(?=@)/g;
/** `Authorization: Bearer|Basic|Token VALUE`: the scheme word stays. */
const AUTH_HEADER =
  /(\bauthorization["'`]?[ \t]{0,3}[:=][ \t]{0,3}["'`]?(?:bearer|basic|token)[ \t]{1,3})([A-Za-z0-9._~+/=-]{8,})/gi;
/** `<password>value</password>` and the like. */
const XML_ELEMENT = /(<([A-Za-z0-9_.-]{1,60})>)([^<\s][^<]{7,200}?)(?=<\/\2>)/g;

/**
 * An assignment candidate: an identifier of at most 80 characters (it must start at an identifier
 * boundary), an optional closing quote (JSON or YAML key), then `=`, `==`, `:=`, `=>` or `:`. The
 * value is parsed by hand afterwards, so no regex backtracks over it.
 */
const ASSIGN_HEAD =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,80})(\\?["'`]?)([ \t]{0,20})(:=|=>|={1,3}|:(?![:=]))([ \t]{0,20})/g;

const KEY_SUBSTRING =
  /password|passwd|passphrase|secret|credential|api_?key|access_?key|private_?key/;
const KEY_SEGMENT = /(?:^|_)(?:tokens?|pwd|auth|authorization|bearer)(?:_|$)/;
/**
 * Intentional over-redaction is accepted for names that really are secrets in some codebases. These
 * trailing words mark a name as metadata about a secret, not the secret itself (`password_length`).
 */
const BENIGN_LAST =
  /(?:^|_)(?:length|len|size|count|max|min|limit|type|name|path|file|url|uri|ttl|expiry|expires|expiration|enabled|required|pattern|regex|label|placeholder)$/;

function isSecretName(ident: string): boolean {
  const n = ident
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-.]+/g, "_");
  if (!KEY_SUBSTRING.test(n) && !KEY_SEGMENT.test(n)) return false;
  return !BENIGN_LAST.test(n);
}

const VALUE_MIN = 8;
// Placeholders, env-var lookups and function calls are code, not secrets.
const NOT_A_VALUE = new RegExp(
  [
    "^\\[REDACTED:", // already replaced
    "^\\$\\{", // ${VAR}
    "^\\$\\(", // $(cmd)
    "^\\$[A-Z_][A-Z0-9_]*$", // $VAR (a bcrypt hash such as $2b$12$... is still redacted)
    "^\\{\\{", // {{ template }}
    "^<[A-Za-z_-]+>?$", // <placeholder> (the first word of "<your token here>")
    "^%[({]", // %(name)s
    "^//", // the rest of a URL
    "^(?:process\\.env|os\\.environ|os\\.getenv|ENV\\[|env\\[)",
    "^[A-Za-z_$][\\w$.]*\\(", // a function call
  ].join("|"),
);
const NULLISH = /^(?:none|null|undefined|nil|false|true)$/i;

/** Where the value of an assignment starts and ends, or null when there is none to redact. */
function valueSpan(line: string, from: number): { start: number; end: number } | null {
  const c = line[from];
  if (c === undefined) return null;
  const esc = c === "\\" && /["'`]/.test(line[from + 1] ?? "");
  const q = esc ? line.slice(from, from + 2) : c;
  if (esc || c === '"' || c === "'" || c === "`") {
    const start = from + q.length;
    const close = line.indexOf(q, start);
    if (close !== -1) return { start, end: close };
    // No closing quote on this line: treat what follows as an unquoted value.
    return unquoted(line, start);
  }
  return unquoted(line, from);
}

function unquoted(line: string, start: number): { start: number; end: number } | null {
  let end = start;
  while (end < line.length && !/[\s"'`]/.test(line.charAt(end))) end += 1;
  // A trailing separator is not part of the value.
  while (end > start && /[,;)\]}]/.test(line.charAt(end - 1))) end -= 1;
  return end > start ? { start, end } : null;
}

function redactAssignments(line: string, counter: Counter): string {
  ASSIGN_HEAD.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = ASSIGN_HEAD.exec(line); m !== null; m = ASSIGN_HEAD.exec(line)) {
    const ident = m[1] ?? "";
    const headEnd = m.index + m[0].length;
    if (!isSecretName(ident)) continue;
    const span = valueSpan(line, headEnd);
    if (!span) continue;
    const value = line.slice(span.start, span.end);
    if (value.length < VALUE_MIN || NOT_A_VALUE.test(value) || NULLISH.test(value)) continue;
    counter.add("assignment");
    out += `${line.slice(last, span.start)}[REDACTED:assignment]`;
    last = span.end;
    ASSIGN_HEAD.lastIndex = Math.max(span.end, headEnd);
  }
  return out + line.slice(last);
}

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEEP_EMAIL = (e: string): boolean =>
  e.toLowerCase() === "noreply@anthropic.com" || /@users\.noreply\.github\.com$/i.test(e);

/**
 * Throws (a fixed message, never the pattern) when the source is not a regular expression or
 * matches the empty string: such a pattern would insert a marker between every character.
 */
export function validateRedactPattern(source: string): void {
  let re: RegExp;
  try {
    re = new RegExp(source, "g");
  } catch {
    throw new RedactPatternError("--redact-pattern is not a valid regular expression");
  }
  if (re.test("")) {
    throw new RedactPatternError("--redact-pattern must not match the empty string");
  }
}

export class RedactPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedactPatternError";
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hostRegex(host: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*${escapeRe(host)}(?![A-Za-z0-9-])`,
    "gi",
  );
}

class Counter {
  private readonly counts = new Map<string, number>();
  add(kind: string, n = 1): void {
    if (n > 0) this.counts.set(kind, (this.counts.get(kind) ?? 0) + n);
  }
  list(): RedactionCount[] {
    return [...this.counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  }
}

function makeRedactor(opts: RedactOptions, counter: Counter) {
  const extra: { kind: string; re: RegExp }[] = [];
  for (const h of opts.hosts ?? []) extra.push({ kind: "host", re: hostRegex(h) });
  for (const p of opts.patterns ?? []) {
    validateRedactPattern(p);
    extra.push({ kind: "custom", re: new RegExp(p, "g") });
  }

  const replaceAll = (line: string, kind: string, re: RegExp, keep?: (m: string) => boolean) =>
    line.replace(re, (m) => {
      if (keep?.(m)) return m;
      counter.add(kind);
      return `[REDACTED:${kind}]`;
    });

  function redactLine(line: string): string {
    let t = line;
    for (const { kind, re } of SECRET_PATTERNS) t = replaceAll(t, kind, re);
    t = t.replace(AUTH_HEADER, (_m, head: string, value: string) => {
      if (value.startsWith("[REDACTED:")) return _m;
      counter.add("bearer");
      return `${head}[REDACTED:bearer]`;
    });
    t = t.replace(URL_CREDENTIALS, (_m, head: string) => {
      counter.add("url_credentials");
      return `${head}[REDACTED:url_credentials]`;
    });
    t = t.replace(XML_ELEMENT, (m, open: string, name: string, value: string) => {
      if (!isSecretName(name) || NOT_A_VALUE.test(value)) return m;
      counter.add("assignment");
      return `${open}[REDACTED:assignment]`;
    });
    t = redactAssignments(t, counter);
    if (opts.emails) t = replaceAll(t, "email", EMAIL, KEEP_EMAIL);
    for (const { kind, re } of extra) t = replaceAll(t, kind === "host" ? "host" : kind, re);
    return t;
  }

  /** `patch`: the first character of a line is a diff prefix (`+`, `-`, space) and stays. */
  function redactText(text: string, patch: boolean): string {
    let inKey = false;
    return text
      .split("\n")
      .map((line) => {
        if (patch && line.startsWith("@@")) {
          // A hunk header ends any key block and keeps its `@@` markers; only its context text is scrubbed.
          inKey = false;
          return redactLine(line);
        }
        if (patch && line.startsWith("\\")) return line; // "\ No newline at end of file"
        const prefix = patch && /^[+\- ]/.test(line) ? line.slice(0, 1) : "";
        const body = line.slice(prefix.length);
        if (inKey) {
          if (KEY_END.test(body)) inKey = false;
          return `${prefix}[REDACTED:private_key]`;
        }
        const begin = KEY_BEGIN.exec(body);
        if (begin) {
          counter.add("private_key");
          if (!KEY_END.test(body.slice(begin.index + begin[0].length))) inKey = true;
          return `${prefix}[REDACTED:private_key]`;
        }
        return prefix + redactLine(body);
      })
      .join("\n");
  }
  return redactText;
}

export function redactInputs(
  inputs: CardInputs,
  opts: RedactOptions = {},
): { inputs: CardInputs; redactions: RedactionCount[] } {
  const counter = new Counter();
  const redactText = makeRedactor(opts, counter);
  const text = (s: string) => redactText(s, false);
  const out: CardInputs = {
    ...inputs,
    pr: { ...inputs.pr, title: text(inputs.pr.title), body: text(inputs.pr.body) },
    issue: inputs.issue
      ? { ...inputs.issue, title: text(inputs.issue.title), body: text(inputs.issue.body) }
      : null,
    files: inputs.files.map((f) => ({
      ...f,
      patch: f.patch === null ? null : redactText(f.patch, true),
    })),
  };
  return { inputs: out, redactions: counter.list() };
}
