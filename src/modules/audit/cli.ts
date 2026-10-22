/**
 * What `pnpm graft audit list` prints (Phase 1 step 3, spec §8). Reads the database only: no
 * GitHub call, no queue. The argument parsing and exit codes live with the other groups in
 * `src/bin/graft-ops.ts`; output goes through its terminal-safe writer.
 */
import { sql } from "kysely";
import type { Db } from "../../db/client.js";
import { AUDIT_KINDS, type AuditKind, type AuditRow, listAudit } from "./store.js";

export const AUDIT_LIMIT_DEFAULT = 50;
export const AUDIT_LIMIT_MAX = 500;

export function isAuditKind(v: string): v is AuditKind {
  return (AUDIT_KINDS as readonly string[]).includes(v);
}

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** `--since`: a date (`YYYY-MM-DD`, midnight UTC) or an ISO timestamp with a zone; else null. */
export function parseSince(v: string): Date | null {
  if (!ISO.test(v)) return null;
  const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) return null;
  if (v.length === 10 && d.toISOString().slice(0, 10) !== v) return null;
  return d;
}

/**
 * The repository ids whose full name is `fullName` (case-insensitive), removed ones included: the
 * audit trail of a repository outlives its removal until `pilot purge`.
 */
export async function repositoryIdsByName(db: Db, fullName: string): Promise<number[]> {
  const rows = await db
    .selectFrom("repositories")
    .select("id")
    .where(sql<string>`lower(full_name)`, "=", fullName.toLowerCase())
    .orderBy("id")
    .execute();
  return rows.map((r) => Number(r.id));
}

export interface AuditListOptions {
  repositoryIds: number[];
  since?: Date | undefined;
  kind?: AuditKind | undefined;
  limit: number;
}

/** Newest first across the matching repositories, at most `limit`. */
export async function auditEntries(db: Db, o: AuditListOptions): Promise<AuditRow[]> {
  const all: AuditRow[] = [];
  for (const repositoryId of o.repositoryIds) {
    all.push(
      ...(await listAudit(db, { repositoryId, since: o.since, kind: o.kind, limit: o.limit })),
    );
  }
  return all
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1))
    .slice(0, o.limit);
}

/** One line per row: `created_at  kind  #pr  head(7)  actor (role)  [self]  mode  reason`. */
export function renderAuditLine(r: AuditRow): string {
  const actor =
    r.actor_login === null
      ? "unknown"
      : r.actor_role === null
        ? r.actor_login
        : `${r.actor_login} (${r.actor_role})`;
  return [
    r.created_at.toISOString(),
    r.kind,
    `#${r.pr_number}`,
    r.head_sha.slice(0, 7),
    actor,
    ...(r.self ? ["self"] : []),
    r.policy_mode,
    ...(r.reason === null ? [] : [r.reason]),
  ].join("  ");
}

export function auditJson(rows: readonly AuditRow[]): { entries: Record<string, unknown>[] } {
  return {
    entries: rows.map((r) => ({
      createdAt: r.created_at.toISOString(),
      kind: r.kind,
      prNumber: r.pr_number,
      headSha: r.head_sha,
      actorLogin: r.actor_login,
      actorRole: r.actor_role,
      self: r.self,
      policyMode: r.policy_mode,
      reason: r.reason,
      labelEventAt: r.label_event_at?.toISOString() ?? null,
    })),
  };
}
