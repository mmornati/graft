/**
 * Secrets and redaction (T7). A `SecretRegistry` holds every secret value the runner learns
 * (tokens, the App key, the webhook secret, the smee URL, installation tokens, JWTs); `redact`
 * replaces each with `[REDACTED]` and then applies patterns for secrets the registry has not seen.
 * Every sink (output, report, state, capture, error messages) goes through it.
 */
import { toTerminalSafe } from "../eval/terminal.js";

export const REDACTED = "[REDACTED]";

const PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "github_pat", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "anthropic_key", re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: "jwt", re: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  {
    name: "pem",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  // Spec: `(token|bearer)\s+\S+`. Narrowed to a credential-looking word so prose such as
  // "token budget" survives (README §7, E2E runner).
  { name: "bearer", re: /\b(token|bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: "smee", re: /https:\/\/smee\.io\/\S+/g },
];

/** Names of the redaction rules, for the capture manifest. */
export const REDACTION_RULES: readonly string[] = [
  "registry",
  ...PATTERNS.map((p) => p.name),
  "email",
  "avatar",
];

/** Secrets shorter than this are ignored: they would redact ordinary words. */
const MIN_SECRET_LENGTH = 8;

export class SecretRegistry {
  private readonly values = new Set<string>();

  add(value: string | undefined | null): void {
    if (typeof value !== "string") return;
    const v = value.trim();
    if (v.length < MIN_SECRET_LENGTH) return;
    this.values.add(v);
    // A PEM may reach us with escaped or unescaped newlines.
    if (v.includes("\n")) this.values.add(v.replace(/\n/g, "\\n"));
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  /** The registered values, longest first (so a token that contains another is replaced whole). */
  private ordered(): string[] {
    return [...this.values].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const v of this.ordered()) out = out.split(v).join(REDACTED);
    for (const { re } of PATTERNS) out = out.replace(re, REDACTED);
    return out;
  }

  /** True when any registered secret occurs in the text (used by the log-file scan). */
  contains(text: string): boolean {
    for (const v of this.values) if (text.includes(v)) return true;
    return false;
  }

  /** Redacts every string inside a JSON-like value. Keys are kept. */
  redactJson<T>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value))) as T;
  }
}

/**
 * What survives of an error: name, HTTP status, method, route template and request id. Never the
 * message of a request error (it can carry a body) and never a stack.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & {
      status?: unknown;
      request?: { method?: unknown; url?: unknown };
      response?: { headers?: Record<string, unknown> };
    };
    const parts = [e.name];
    if (typeof e.status === "number") parts.push(`HTTP ${e.status}`);
    if (e.request && typeof e.request.method === "string") {
      parts.push(`${e.request.method} ${routeOf(String(e.request.url ?? ""))}`);
    }
    const rid = e.response?.headers?.["x-github-request-id"];
    if (typeof rid === "string") parts.push(`request ${rid}`);
    // Errors raised by the runner itself (WaitTimeout, GuardRefusal, ...) carry a safe message.
    if (e.status === undefined && e.request === undefined) parts.push(e.message);
    return parts.join(": ");
  }
  return "unknown error";
}

/** A request URL without its query string and with numeric ids kept (no token is ever in a URL). */
function routeOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? "";
  }
}

export interface SafeIo {
  out(s: string): void;
  err(s: string): void;
}

/** Wraps raw output functions so everything printed is redacted and terminal-safe. */
export function safeIo(
  raw: { out(s: string): void; err(s: string): void },
  secrets: SecretRegistry,
): SafeIo {
  const clean = (s: string) => toTerminalSafe(secrets.redact(s));
  return { out: (s) => raw.out(clean(s)), err: (s) => raw.err(clean(s)) };
}
