/**
 * The gate report's allow-list: reviewers who review without being requested. One login per line,
 * `#` starts a comment. The report records only the count and the SHA-256 of the file.
 */
import { createHash } from "node:crypto";

export class AllowListError extends Error {
  constructor(readonly line: number) {
    super(`allow-list: line ${line} is not a GitHub login`);
    this.name = "AllowListError";
  }
}

const LOGIN = /^[a-z0-9-]+(\[bot\])?$/;

export interface AllowList {
  logins: ReadonlySet<string>;
  count: number;
  sha256: string;
}

/** Throws AllowListError naming the line number only (never the line). */
export function parseAllowList(text: string): AllowList {
  const logins = new Set<string>();
  text.split(/\r?\n/).forEach((raw, idx) => {
    const hash = raw.indexOf("#");
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim().toLowerCase();
    if (line === "") return;
    if (!LOGIN.test(line)) throw new AllowListError(idx + 1);
    logins.add(line);
  });
  return {
    logins,
    count: logins.size,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

export const emptyAllowList = (): AllowList => parseAllowList("");
