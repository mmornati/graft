/**
 * D7: one indexed query per request, no cache, so a revoked token stops working on the next one.
 * The secret goes no further than `hashToken`: the `AuthInfo` the SDK hands to every tool carries
 * `[redacted]` in its `token` field.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";
import { sql } from "kysely";
import type { Db } from "../../db/client.js";
import { hashToken } from "../../mcp/tokens.js";

export interface McpPrincipal {
  tokenId: string;
  repositoryId: number;
  installationId: number;
  /** The repository's current `full_name` (D8 compares the `repository` argument with it). */
  fullName: string;
}

export type McpAuthInfo = AuthInfo & { extra: McpPrincipal & Record<string, unknown> };

/**
 * The `AuthInfo` of a token, or null when the token is unknown, expired, revoked or orphaned. The
 * only code that holds the secret next to the principal: its `token` field is always `[redacted]`.
 */
export async function authorizeToken(db: Db, token: string): Promise<McpAuthInfo | null> {
  const row = await db
    .selectFrom("mcp_tokens as t")
    .innerJoin("repositories as r", "r.id", "t.repository_id")
    .innerJoin("installations as i", "i.id", "r.installation_id")
    .select(["t.id as tokenId", "r.id as repositoryId", "i.id as installationId", "r.full_name"])
    .where("t.token_hash", "=", hashToken(token))
    .where("t.revoked_at", "is", null)
    .where("t.expires_at", ">", sql<Date>`now()`)
    .where("r.removed_at", "is", null)
    .where("i.deleted_at", "is", null)
    .where("i.suspended_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  return authInfoFor({
    tokenId: row.tokenId,
    repositoryId: Number(row.repositoryId),
    installationId: Number(row.installationId),
    fullName: row.full_name,
  });
}

/** D11: at most one `last_used_at` write per token per minute. */
export async function touchLastUsed(db: Db, tokenId: string): Promise<void> {
  await db
    .updateTable("mcp_tokens")
    .set({ last_used_at: sql<Date>`now()` })
    .where("id", "=", tokenId)
    .where((eb) =>
      eb.or([
        eb("last_used_at", "is", null),
        eb("last_used_at", "<", sql<Date>`now() - interval '1 minute'`),
      ]),
    )
    .execute();
}

function authInfoFor(p: McpPrincipal): McpAuthInfo {
  return {
    token: "[redacted]",
    clientId: p.tokenId,
    scopes: [`repository:${p.repositoryId}`],
    extra: { ...p },
  };
}
