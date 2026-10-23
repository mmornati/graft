/**
 * `pnpm graft mcp-token create|list|revoke` (§10, D11). The ops CLI is the only way to manage
 * tokens. `create` prints the token once, to stdout; it is never taken as an argument, never
 * logged and never stored (only its hash and prefix are).
 */
import type { Db } from "../../db/client.js";
import { generateToken, hashToken, TOKEN_PREFIX, tokenPrefix } from "../../mcp/tokens.js";
import {
  createTokenRow,
  findActiveRepositoriesByName,
  listTokens,
  revokeToken,
  type TokenRow,
  tokenSummary,
} from "./store.js";

const DAY_MS = 86_400_000;
export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;

/** D11: 1 to 64 printable characters (no control or format characters). */
export const validTokenName = (s: string): boolean =>
  /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,64}$/u.test(s) && Array.from(s).length <= 64 && s.trim() !== "";

/** A revoke reason: 1 to 200 printable characters on one line (the column's own cap). */
export const validRevokeReason = (s: string): boolean =>
  /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,200}$/u.test(s) && s.trim() !== "";

export type IssueResult =
  | { ok: true; token: string; id: string; expiresAt: Date }
  | { ok: false; message: string };

export async function issueToken(
  db: Db,
  o: {
    repo: string;
    name: string;
    expiresInDays: number;
    actor: string;
    now: Date;
    maxActive: number;
  },
): Promise<IssueResult> {
  const repos = await findActiveRepositoriesByName(db, o.repo);
  if (repos.length === 0) return { ok: false, message: "unknown or removed repository" };
  if (repos.length > 1) return { ok: false, message: "ambiguous repository; nothing created" };
  const repository = repos[0] as { id: number };
  const token = generateToken();
  const created = await createTokenRow(db, {
    repositoryId: Number(repository.id),
    name: o.name,
    tokenHash: hashToken(token),
    tokenPrefix: tokenPrefix(token),
    createdBy: o.actor,
    now: o.now,
    expiresAt: new Date(o.now.getTime() + o.expiresInDays * DAY_MS),
    maxActive: o.maxActive,
  });
  if (!created.ok) {
    return {
      ok: false,
      message:
        created.reason === "duplicate_name"
          ? "a token with this name is already active for the repository"
          : `the repository already has the maximum of ${o.maxActive} active tokens`,
    };
  }
  return { ok: true, token, id: created.id, expiresAt: created.expiresAt };
}

export async function repositoryTokens(
  db: Db,
  repo: string,
  o: { all: boolean; now: Date },
): Promise<Omit<TokenRow, "token_hash">[] | null> {
  const repos = await findActiveRepositoriesByName(db, repo);
  const first = repos[0];
  if (!first || repos.length > 1) return null;
  return listTokens(db, Number(first.id), o);
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/** `list --json`: the same fields as the text form. Never the hash. */
export function tokenListJson(rows: readonly Omit<TokenRow, "token_hash">[]): unknown[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: `${TOKEN_PREFIX}${r.token_prefix}…`,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    lastUsedAt: iso(r.last_used_at),
    revokedBy: r.revoked_by,
    revokedAt: iso(r.revoked_at),
    revokeReason: r.revoke_reason,
  }));
}

export function renderTokenList(rows: readonly Omit<TokenRow, "token_hash">[]): string {
  if (rows.length === 0) return "no tokens\n";
  return rows
    .map((r) => {
      const revoked =
        r.revoked_at === null
          ? ""
          : `  revoked by ${r.revoked_by} at ${r.revoked_at.toISOString()} (${r.revoke_reason ?? "no reason"})`;
      return `${r.id}  ${JSON.stringify(r.name)}  ${TOKEN_PREFIX}${r.token_prefix}…  created by ${r.created_by} at ${r.created_at.toISOString()}  expires ${r.expires_at.toISOString()}  last used ${iso(r.last_used_at) ?? "never"}${revoked}\n`;
    })
    .join("");
}

export { revokeToken };

function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** `mode show` (§10): `mcp tokens  2 active (newest used 3 minutes ago)`. */
export async function tokenShowLine(db: Db, repositoryId: number, now: Date): Promise<string> {
  const s = await tokenSummary(db, repositoryId, now);
  const used =
    s.active === 0
      ? ""
      : s.lastUsedAt === null
        ? " (never used)"
        : ` (newest used ${ago(now.getTime() - s.lastUsedAt.getTime())})`;
  return `mcp tokens  ${s.active} active${used}`;
}

export const MCP_OFF_NOTE = "note: the MCP endpoint is off on this shell's config";
