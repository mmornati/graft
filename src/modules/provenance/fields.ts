/** Pure: turns parsed trailers into validated Graft fields (step 2 §6.2, §6.3). */
import { type Trailer, trimWs } from "./trailers.js";

export type GraftField = "agent" | "model" | "task" | "session";
export const TRAILER_KEYS: Record<GraftField, string> = {
  agent: "Graft-Agent",
  model: "Graft-Model",
  task: "Graft-Task",
  session: "Graft-Session",
};
export type WarningCode =
  | "invalid_value"
  | "value_too_long"
  | "empty_value"
  | "duplicate_key"
  | "unknown_graft_key"
  | "invalid_session_url"
  | "message_truncated"
  | "block_too_long";
export interface ProvenanceWarning {
  code: WarningCode;
  field?: GraftField;
  commitSha?: string;
  source: "commit" | "pr_body";
}

export const MAX_RAW_VALUE_CHARS = 2048;

const KEY_TO_FIELD = new Map<string, GraftField>(
  (Object.keys(TRAILER_KEYS) as GraftField[]).map((f) => [TRAILER_KEYS[f].toLowerCase(), f]),
);

const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,99}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
const TASK_RE = /^[A-Za-z0-9#][A-Za-z0-9._:/#@+-]{0,127}$/;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/** Normalized href with ( ) [ ] | backslash, backtick and * percent-encoded, or null. */
export function validateSessionUrl(raw: string): string | null {
  // ASCII printable only: rejects bidi controls, zero-width characters, spaces and newlines.
  if (raw.length === 0 || raw.length > MAX_RAW_VALUE_CHARS || !/^[\x21-\x7e]+$/.test(raw)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  // WHATWG already lowercases and punycodes the host. One trailing dot (FQDN form) is allowed.
  const host = url.hostname.replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  // D14: plain LDH only (letters, digits, hyphen, dot), so the host is safe as markdown link text.
  if (host.length > 253 || !HOST_RE.test(host)) return null;
  const href = url.href
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D")
    .replace(/\|/g, "%7C")
    .replace(/\\/g, "%5C")
    .replace(/`/g, "%60")
    .replace(/\*/g, "%2A");
  return href.length <= MAX_RAW_VALUE_CHARS ? href : null;
}

function normalize(field: GraftField, raw: string): string | null {
  const v = trimWs(raw);
  switch (field) {
    case "agent": {
      const n = v.replace(/[ \t]+/g, " ");
      return AGENT_RE.test(n) ? n : null;
    }
    case "model":
      return MODEL_RE.test(v) ? v : null;
    case "task":
      return TASK_RE.test(v) ? v : null;
    case "session":
      return validateSessionUrl(v);
  }
}

const COAUTHOR_EMAIL = /<([^<>\s]+@[^<>\s]+)>\s*$/;

export function extractGraftFields(
  trailers: Trailer[],
  o: { agentCoauthorEmails: readonly string[] },
): {
  fields: Partial<Record<GraftField, string>>;
  warnings: Omit<ProvenanceWarning, "source" | "commitSha">[];
  agentCoauthor: boolean;
} {
  const fields: Partial<Record<GraftField, string>> = {};
  const warnings: Omit<ProvenanceWarning, "source" | "commitSha">[] = [];
  let agentCoauthor = false;
  const emails = new Set(o.agentCoauthorEmails.map((e) => e.toLowerCase()));

  for (const { key, value } of trailers) {
    const lower = key.toLowerCase();
    if (lower === "co-authored-by") {
      const email = COAUTHOR_EMAIL.exec(value)?.[1];
      if (email && emails.has(email.toLowerCase())) agentCoauthor = true;
      continue;
    }
    const field = KEY_TO_FIELD.get(lower);
    if (!field) {
      if (lower.startsWith("graft-")) warnings.push({ code: "unknown_graft_key" });
      continue;
    }
    if (value.length > MAX_RAW_VALUE_CHARS) {
      warnings.push({ code: "value_too_long", field });
      continue;
    }
    if (trimWs(value) === "") {
      warnings.push({ code: "empty_value", field });
      continue;
    }
    const normalized = normalize(field, value);
    if (normalized === null) {
      warnings.push({ code: field === "session" ? "invalid_session_url" : "invalid_value", field });
      continue;
    }
    const existing = fields[field];
    if (existing !== undefined && existing !== normalized) {
      warnings.push({ code: "duplicate_key", field });
    }
    fields[field] = normalized;
  }
  return { fields, warnings, agentCoauthor };
}
