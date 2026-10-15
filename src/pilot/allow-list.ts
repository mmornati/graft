/**
 * The gate report's allow-list: reviewers who review without being requested, matched by their
 * immutable numeric GitHub user ID (never by login: a login freed by a rename can be registered
 * by someone else, who would then inherit the vote). One entry per line, `#` starts a comment:
 *
 *     12345            # an ID alone
 *     alice:12345      # login:id, the login is informational and never matched
 *
 * A line of digits is ALWAYS an ID, even though GitHub allows all-digit logins: to name a person
 * whose login is numeric write `@1234` (login-only, like `@alice`) for `resolve`, or `1234:5678`.
 * A login-only line is an error; `pnpm graft pilot allow-list resolve <file>` rewrites such lines
 * as `login:id`. The report records only the count and the SHA-256 of the file.
 */
import { createHash } from "node:crypto";

export class AllowListError extends Error {
  constructor(
    readonly line: number,
    readonly kind: "login_only" | "invalid" = "invalid",
  ) {
    super(
      kind === "login_only"
        ? `allow-list: line ${line} has a login but no numeric user ID; run "pnpm graft pilot allow-list resolve <file>" to resolve the ID`
        : `allow-list: line ${line} is not "<id>" or "<login>:<id>"`,
    );
    this.name = "AllowListError";
  }
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;
const ID = /^[1-9][0-9]{0,15}$/;

export interface AllowList {
  /** GitHub user ids. */
  ids: ReadonlySet<number>;
  count: number;
  sha256: string;
}

type Entry =
  | { kind: "blank" }
  | { kind: "id"; id: number; login?: string }
  | { kind: "login"; login: string };

/** One line without its comment. Returns undefined when it is neither of the two formats. */
function parseEntry(raw: string): Entry | undefined {
  const hash = raw.indexOf("#");
  const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  if (line === "") return { kind: "blank" };
  // `@login` is an explicit login-only entry: the only way to write a numeric login for `resolve`.
  if (line.startsWith("@")) {
    const login = line.slice(1).trim();
    return LOGIN.test(login) ? { kind: "login", login } : undefined;
  }
  const colon = line.indexOf(":");
  if (colon < 0) {
    if (ID.test(line)) return { kind: "id", id: Number(line) };
    // A line of digits is always read as an ID (so an out-of-range one is malformed, not a login).
    return LOGIN.test(line) && !/^[0-9]+$/.test(line) ? { kind: "login", login: line } : undefined;
  }
  const login = line.slice(0, colon).trim();
  const id = line.slice(colon + 1).trim();
  if (!LOGIN.test(login) || !ID.test(id)) return undefined;
  return { kind: "id", id: Number(id), login };
}

const idIsSafe = (id: number): boolean => Number.isSafeInteger(id);

/** Throws AllowListError naming the line number only (never the line). */
export function parseAllowList(text: string): AllowList {
  const ids = new Set<number>();
  text.split(/\r?\n/).forEach((raw, idx) => {
    const e = parseEntry(raw);
    if (e === undefined) throw new AllowListError(idx + 1, "invalid");
    if (e.kind === "login") throw new AllowListError(idx + 1, "login_only");
    if (e.kind === "id") {
      if (!idIsSafe(e.id)) throw new AllowListError(idx + 1, "invalid");
      ids.add(e.id);
    }
  });
  return {
    ids,
    count: ids.size,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

export const emptyAllowList = (): AllowList => parseAllowList("");

export class AllowListResolveError extends Error {
  constructor(readonly lines: readonly number[]) {
    super(
      `allow-list: no GitHub user found for line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}; nothing was written`,
    );
    this.name = "AllowListResolveError";
  }
}

/**
 * Rewrites every login-only line as `login:id` (keeping its comment and line ending) using
 * `lookup`, which returns undefined for an unknown user. All-or-nothing: if any login does not
 * resolve, throws AllowListResolveError naming the line numbers. Other lines are left as they are
 * and a malformed line is an AllowListError, as in `parseAllowList`.
 */
export async function resolveAllowList(
  text: string,
  lookup: (login: string) => Promise<number | undefined>,
): Promise<{ text: string; resolved: number }> {
  const raws = text.split("\n");
  const missing: number[] = [];
  let resolved = 0;
  const out: string[] = [];
  for (const [idx, rawWithCr] of raws.entries()) {
    const cr = rawWithCr.endsWith("\r") ? "\r" : "";
    const raw = cr ? rawWithCr.slice(0, -1) : rawWithCr;
    const e = parseEntry(raw);
    if (e === undefined) throw new AllowListError(idx + 1, "invalid");
    if (e.kind !== "login") {
      out.push(rawWithCr);
      continue;
    }
    const id = await lookup(e.login);
    if (id === undefined || !Number.isSafeInteger(id) || id < 1) {
      missing.push(idx + 1);
      out.push(rawWithCr);
      continue;
    }
    resolved++;
    const hash = raw.indexOf("#");
    const comment = hash >= 0 ? ` ${raw.slice(hash)}` : "";
    out.push(`${e.login}:${id}${comment}${cr}`);
  }
  if (missing.length > 0) throw new AllowListResolveError(missing);
  return { text: out.join("\n"), resolved };
}
