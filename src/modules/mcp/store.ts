/**
 * MCP tokens and `mcp_changes` (Phase 1 step 6, D6, D11, D18, D9 c). Only token hashes and prefixes
 * are stored; the token itself never reaches this file.
 */
import { type Selectable, sql, type Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { Database, McpTokensTable } from "../../db/schema.js";

type Executor = Db | Transaction<Database>;
export type TokenRow = Selectable<McpTokensTable>;

/** The repository a token is created for: active rows matched by name, case-insensitively. */
export async function findActiveRepositoriesByName(
  ex: Executor,
  fullName: string,
): Promise<{ id: number; full_name: string }[]> {
  return ex
    .selectFrom("repositories as r")
    .innerJoin("installations as i", "i.id", "r.installation_id")
    .select(["r.id", "r.full_name"])
    .where(sql<string>`lower(r.full_name)`, "=", fullName.toLowerCase())
    .where("r.removed_at", "is", null)
    .where("i.deleted_at", "is", null)
    .limit(2)
    .execute();
}

export type CreateTokenResult =
  | { ok: true; id: string; expiresAt: Date }
  | { ok: false; reason: "duplicate_name" | "cap_reached" };

/**
 * D11: insert a token row. The cap and the name rule are checked under a lock on the repository row,
 * so two concurrent `create`s cannot both take the last slot.
 */
export async function createTokenRow(
  db: Db,
  o: {
    repositoryId: number;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    createdBy: string;
    now: Date;
    expiresAt: Date;
    maxActive: number;
  },
): Promise<CreateTokenResult> {
  return db.transaction().execute(async (tx) => {
    await tx
      .selectFrom("repositories")
      .select("id")
      .where("id", "=", o.repositoryId)
      .forUpdate()
      .execute();
    const active = await tx
      .selectFrom("mcp_tokens")
      .select(["name"])
      .where("repository_id", "=", o.repositoryId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", o.now)
      .execute();
    if (active.some((t) => t.name === o.name)) return { ok: false, reason: "duplicate_name" };
    if (active.length >= o.maxActive) return { ok: false, reason: "cap_reached" };
    // An expired token keeps its name reserved by the partial index until revoked; revoke it now
    // so the name can be reused (the row stays, with who had access when).
    await tx
      .updateTable("mcp_tokens")
      .set({ revoked_at: o.now, revoked_by: "system", revoke_reason: "expired" })
      .where("repository_id", "=", o.repositoryId)
      .where("name", "=", o.name)
      .where("revoked_at", "is", null)
      .where("expires_at", "<=", o.now)
      .execute();
    const row = await tx
      .insertInto("mcp_tokens")
      .values({
        repository_id: o.repositoryId,
        name: o.name,
        token_hash: o.tokenHash,
        token_prefix: o.tokenPrefix,
        created_by: o.createdBy,
        created_at: o.now,
        expires_at: o.expiresAt,
      })
      .returning(["id", "expires_at"])
      .executeTakeFirstOrThrow();
    return { ok: true, id: row.id, expiresAt: row.expires_at };
  });
}

/** `list`: active tokens of a repository, or every row with `all`. Never the hash. */
export async function listTokens(
  ex: Executor,
  repositoryId: number,
  o: { all: boolean; now: Date },
): Promise<Omit<TokenRow, "token_hash">[]> {
  let q = ex
    .selectFrom("mcp_tokens")
    .select([
      "id",
      "repository_id",
      "name",
      "token_prefix",
      "created_by",
      "created_at",
      "expires_at",
      "last_used_at",
      "revoked_at",
      "revoked_by",
      "revoke_reason",
    ])
    .where("repository_id", "=", repositoryId);
  if (!o.all) q = q.where("revoked_at", "is", null).where("expires_at", ">", o.now);
  return q.orderBy("created_at", "desc").orderBy("id").execute();
}

/** D11: `revoke`. Unknown id → `unknown`; an already revoked token → `already` (exit 0). */
export async function revokeToken(
  ex: Executor,
  o: { id: string; actor: string; reason: string; now: Date },
): Promise<"revoked" | "already" | "unknown"> {
  const row = await ex
    .selectFrom("mcp_tokens")
    .select(["id", "revoked_at"])
    .where("id", "=", o.id)
    .executeTakeFirst();
  if (!row) return "unknown";
  if (row.revoked_at !== null) return "already";
  const res = await ex
    .updateTable("mcp_tokens")
    .set({ revoked_at: o.now, revoked_by: o.actor, revoke_reason: o.reason })
    .where("id", "=", o.id)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0 ? "revoked" : "already";
}

/** `mode show`: active tokens of a repository and the newest use. */
export async function tokenSummary(
  ex: Executor,
  repositoryId: number,
  now: Date,
): Promise<{ active: number; lastUsedAt: Date | null }> {
  const row = await ex
    .selectFrom("mcp_tokens")
    .select((eb) => [eb.fn.countAll<string>().as("n"), eb.fn.max("last_used_at").as("last")])
    .where("repository_id", "=", repositoryId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return { active: Number(row?.n ?? 0), lastUsedAt: (row?.last as Date | null) ?? null };
}

/** D18: the PR `open_change` opened; a second insert for the same PR is a no-op. */
export async function insertMcpChange(
  ex: Executor,
  o: { repositoryId: number; tokenId: string; prNumber: number; headSha: string },
): Promise<void> {
  await ex
    .insertInto("mcp_changes")
    .values({
      repository_id: o.repositoryId,
      token_id: o.tokenId,
      pr_number: o.prNumber,
      head_sha: o.headSha,
    })
    .onConflict((oc) => oc.columns(["repository_id", "pr_number"]).doNothing())
    .execute();
}

/**
 * D9 (c): opens of a repository in the rolling hour, counted where every process sees them. A
 * claimed slot (a row with no PR number yet) counts as an open.
 */
export async function opensInLastHour(ex: Executor, repositoryId: number): Promise<number> {
  const row = await ex
    .selectFrom("mcp_changes")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("repository_id", "=", repositoryId)
    .where("created_at", ">", sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * Phase 1 step 7 (D9 b): every claim older than an hour, in every repository. A crashed claim
 * holds its slot for an hour; this lets the daily rollup drop it even in a repository where no
 * later claim comes. PR rows are never touched. Returns how many claims were deleted.
 */
export async function purgeStaleClaims(ex: Executor): Promise<number> {
  const res = await ex
    .deleteFrom("mcp_changes")
    .where("pr_number", "is", null)
    .where("created_at", "<", sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}

/**
 * D9 (c) under concurrent calls (review 1, finding 7): count the rolling hour and claim a slot in
 * one short transaction holding the repository row lock, as `createTokenRow` does. The claim is an
 * `mcp_changes` row with no PR number, so every process counts it. No GitHub call runs inside the
 * lock. Null when the cap is reached. A claim older than an hour (left by a crash between the claim
 * and `settleOpenClaim`) is deleted here; until then it holds its slot.
 */
export async function claimOpenSlot(
  db: Db,
  o: { repositoryId: number; tokenId: string; perHour: number },
): Promise<string | null> {
  return db.transaction().execute(async (tx) => {
    await tx
      .selectFrom("repositories")
      .select("id")
      .where("id", "=", o.repositoryId)
      .forUpdate()
      .execute();
    await tx
      .deleteFrom("mcp_changes")
      .where("repository_id", "=", o.repositoryId)
      .where("pr_number", "is", null)
      .where("created_at", "<=", sql<Date>`now() - interval '1 hour'`)
      .execute();
    if ((await opensInLastHour(tx, o.repositoryId)) >= o.perHour) return null;
    const row = await tx
      .insertInto("mcp_changes")
      .values({
        repository_id: o.repositoryId,
        token_id: o.tokenId,
        pr_number: null,
        head_sha: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  });
}

/**
 * The end of a claimed open: the claim becomes the PR's row (D18), or, with `pr` null, the slot is
 * given back. The PR row is inserted with `ON CONFLICT DO NOTHING`: a concurrent call may have
 * adopted the new PR first.
 */
export async function settleOpenClaim(
  db: Db,
  o: {
    claimId: string;
    repositoryId: number;
    tokenId: string;
    pr: { number: number; headSha: string } | null;
  },
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("mcp_changes")
      .where("id", "=", o.claimId)
      .where("pr_number", "is", null)
      .execute();
    if (o.pr !== null) {
      await insertMcpChange(tx, {
        repositoryId: o.repositoryId,
        tokenId: o.tokenId,
        prNumber: o.pr.number,
        headSha: o.pr.headSha,
      });
    }
  });
}

export async function isMcpChange(
  ex: Executor,
  repositoryId: number,
  prNumber: number,
): Promise<boolean> {
  const row = await ex
    .selectFrom("mcp_changes")
    .select("id")
    .where("repository_id", "=", repositoryId)
    .where("pr_number", "=", prNumber)
    .executeTakeFirst();
  return row !== undefined;
}
