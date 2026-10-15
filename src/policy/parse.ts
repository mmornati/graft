/**
 * Safe parsing of `graft.yaml` (spec T4, D6). Pure, and it never throws for any input bytes.
 *
 * Order, stopping at the first failing step of 1 to 4: size, strict UTF-8, flow-depth pre-scan,
 * one YAML document without errors. Then anchors, aliases and tags are rejected BEFORE `toJS`
 * runs, so no alias is ever resolved (no billion-laughs expansion). Then zod and the refinements.
 */
import { createHash } from "node:crypto";
import {
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseAllDocuments,
  visit,
} from "yaml";
import { LIMITS } from "./constants.js";
import type { PolicyError } from "./errors.js";
import {
  crossChecks,
  normalizePolicy,
  type PathSeg,
  type Policy,
  type RawIssue,
  structuralIssues,
} from "./schema.js";

export type ParseResult =
  | { ok: true; policy: Policy; hash: string }
  | { ok: false; errors: PolicyError[] };

const err = (
  code: PolicyError["code"],
  o: {
    line?: number | null;
    column?: number | null;
    location?: string | null;
    detail?: number;
  } = {},
): PolicyError => ({
  code,
  location: o.location ?? null,
  line: o.line ?? null,
  column: o.column ?? null,
  ...(o.detail !== undefined ? { detail: o.detail } : {}),
});

/** sha256 hex of the canonical JSON (sorted keys) of a value. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Flow nesting of `[` and `{` outside quotes and comments (step 3). A bracket opens a flow
 * collection, and a quote opens a quoted scalar, only where a YAML value can start: at the start
 * of a block line or right after a `:`, `-` or `?` indicator, a `,`, `[` or `{`. Inside a plain
 * scalar they are plain text, so they do not count.
 */
function flowDepthError(text: string): PolicyError | null {
  const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
  let depth = 0;
  let line = 1;
  let col = 0;
  let prev = "\n";
  let canStart = true;
  let quote: "'" | '"' | null = null;
  let comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    col++;
    if (c === "\n") {
      line++;
      col = 0;
      comment = false;
      // Inside a flow collection the context continues; a block line starts a fresh value.
      if (depth === 0 && quote === null) canStart = true;
      prev = c;
      continue;
    }
    if (comment) {
      prev = c;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        i++;
        col++;
      } else if (c === '"') quote = null;
      prev = c;
      continue;
    }
    if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") {
          i++;
          col++;
        } else quote = null;
      }
      prev = c;
      continue;
    }
    if (c === "#" && /\s/.test(prev)) {
      comment = true;
    } else if (/\s/.test(c)) {
      // whitespace never changes the context
    } else if ((c === "]" || c === "}") && depth > 0) {
      depth--;
      canStart = false;
    } else if (
      c === ":" &&
      (isSpace(text[i + 1]) || (depth > 0 && /[,\]}]/.test(text[i + 1] ?? "")))
    ) {
      canStart = true;
    } else if (c === "," && depth > 0) {
      canStart = true;
    } else if ((c === "-" || c === "?") && canStart && isSpace(text[i + 1])) {
      canStart = true;
    } else if (canStart) {
      canStart = false;
      if (c === '"' || c === "'") quote = c;
      else if (c === "[" || c === "{") {
        depth++;
        canStart = true;
        if (depth > LIMITS.flowDepth) return err("yaml_too_deep", { line, column: col });
      }
    }
    prev = c;
  }
  return null;
}

function pathToLocation(path: readonly PathSeg[]): string | null {
  if (path.length === 0) return null;
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg + 1}]`;
    else out += out === "" ? seg : `.${seg}`;
  }
  return out;
}

/** The start offset of the deepest node the path reaches (a key node for `key`). */
function offsetFor(doc: Document, path: readonly PathSeg[], key?: string): number | null {
  let cur: unknown = doc.contents;
  let best: number | null = null;
  const note = (n: unknown) => {
    const r = (n as { range?: [number, number, number] | null } | null)?.range;
    if (r) best = r[0];
  };
  note(cur);
  const step = (seg: PathSeg): boolean => {
    if (isMap(cur) && typeof seg === "string") {
      const pair = cur.items.find((p) => isScalar(p.key) && String(p.key.value) === seg);
      if (!pair) return false;
      note(pair.key);
      cur = pair.value;
      if (cur) note(cur);
      return cur !== null && cur !== undefined;
    }
    if (isSeq(cur) && typeof seg === "number") {
      const item = cur.items[seg];
      if (item === undefined) return false;
      cur = item;
      if (cur) note(cur);
      return cur !== null;
    }
    return false;
  };
  for (const seg of path) if (!step(seg)) return best;
  if (key !== undefined && isMap(cur)) {
    const pair = cur.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
    if (pair) note(pair.key);
  }
  return best;
}

function finish(errors: PolicyError[]): ParseResult {
  const sorted = errors
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const la = a.e.line ?? Number.MAX_SAFE_INTEGER;
      const lb = b.e.line ?? Number.MAX_SAFE_INTEGER;
      if (la !== lb) return la - lb;
      const ca = a.e.column ?? Number.MAX_SAFE_INTEGER;
      const cb = b.e.column ?? Number.MAX_SAFE_INTEGER;
      return ca !== cb ? ca - cb : a.i - b.i;
    })
    .map((x) => x.e);
  if (sorted.length > LIMITS.errors) {
    const kept = sorted.slice(0, LIMITS.errors - 1);
    kept.push(err("too_many_errors"));
    return { ok: false, errors: kept };
  }
  return { ok: false, errors: sorted };
}

export function parsePolicyText(bytes: Uint8Array): ParseResult {
  try {
    return parseUnsafe(bytes);
  } catch {
    // Defence in depth: a parser failure (for example a stack overflow) is a syntax error.
    return { ok: false, errors: [err("yaml_syntax")] };
  }
}

function parseUnsafe(bytes: Uint8Array): ParseResult {
  // 1. size
  if (bytes.byteLength > LIMITS.fileBytes) {
    return { ok: false, errors: [err("file_too_large", { detail: bytes.byteLength })] };
  }
  // 2. strict UTF-8; the decoder strips a leading BOM
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, errors: [err("file_not_utf8")] };
  }
  // 3. flow nesting
  const deep = flowDepthError(text);
  if (deep) return { ok: false, errors: [deep] };

  // 4. exactly one document, no errors, no warnings (except unresolved tags, reported in step 5)
  const lc = new LineCounter();
  const docs = parseAllDocuments(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    strict: true,
    prettyErrors: false,
    // A complex key makes `toJS` print a Node warning; the schema reports it as an unknown key.
    logLevel: "silent",
    lineCounter: lc,
  });
  const list = Array.isArray(docs) ? docs : [docs];
  const posOf = (offset: number | null | undefined) => {
    if (offset === null || offset === undefined) return { line: null, column: null };
    const p = lc.linePos(offset);
    return { line: p.line, column: p.col };
  };
  if (list.length > 1) {
    const second = list[1] as Document;
    const at = posOf(second.range?.[0] ?? second.contents?.range?.[0]);
    return { ok: false, errors: [err("yaml_multiple_documents", at)] };
  }
  const doc = list[0];
  if (doc === undefined || doc.contents === null) {
    return { ok: false, errors: [err("not_a_mapping")] };
  }
  const syntax: PolicyError[] = [];
  for (const e of doc.errors) {
    syntax.push(
      err(e.code === "DUPLICATE_KEY" ? "yaml_duplicate_key" : "yaml_syntax", posOf(e.pos[0])),
    );
  }
  for (const w of doc.warnings) {
    if (w.code === "TAG_RESOLVE_FAILED") continue;
    syntax.push(err("yaml_syntax", posOf(w.pos[0])));
  }
  if (syntax.length > 0) return finish(syntax);

  // 5. anchors, aliases and explicit tags: rejected before anything is resolved
  const banned: PolicyError[] = [];
  visit(doc, {
    Node(_key, node: Node) {
      const at = posOf(node.range?.[0]);
      if (isAlias(node) || node.anchor) banned.push(err("yaml_alias", at));
      else if (node.tag) banned.push(err("yaml_tag", at));
      if (isAlias(node)) return visit.SKIP;
      return undefined;
    },
  });
  if (banned.length > 0) return finish(banned);

  // 6. plain data
  const js: unknown = doc.toJS({ maxAliasCount: 0 });
  if (js === null || typeof js !== "object" || Array.isArray(js)) {
    return { ok: false, errors: [err("not_a_mapping")] };
  }

  // 7. schema and refinements
  const { issues: structural, data } = structuralIssues(js);
  const all: RawIssue[] = [...structural, ...crossChecks(js)];
  if (all.length > 0 || data === null) {
    const seen = new Set<string>();
    const errors: PolicyError[] = [];
    for (const i of all) {
      const id = `${i.code}|${JSON.stringify(i.path)}|${i.key ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      errors.push({
        code: i.code,
        location: pathToLocation(i.path),
        ...posOf(offsetFor(doc, i.path, i.key)),
        ...(i.key !== undefined ? { key: i.key } : {}),
        ...(i.detail !== undefined ? { detail: i.detail } : {}),
      });
    }
    return finish(errors.length > 0 ? errors : [err("wrong_type")]);
  }

  // 8. hash
  const policy = normalizePolicy(data);
  return { ok: true, policy, hash: canonicalHash(policy) };
}
