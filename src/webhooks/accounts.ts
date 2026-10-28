/**
 * The account allow-list (`GRAFT_ALLOWED_ACCOUNTS`). A public App can be installed by anyone, and
 * GitHub signs that installation's deliveries with the App's own secret, so the signature alone
 * does not tell a stranger's delivery from the operator's. The receiver asks this file which
 * account a delivery belongs to and drops it, before it is stored, when that account is not listed.
 */
import type { Db } from "../db/client.js";

function login(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const l = typeof o.login === "string" ? o.login : typeof o.slug === "string" ? o.slug : "";
  return l === "" ? undefined : l.toLowerCase();
}

function field(v: unknown, key: string): unknown {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
}

/**
 * The lowercased login a delivery's payload names: the installation's account (installation
 * events), else the repository's owner, else the organization. Undefined when it names none.
 */
export function payloadAccount(payload: Record<string, unknown>): string | undefined {
  return (
    login(field(payload.installation, "account")) ??
    login(field(payload.repository, "owner")) ??
    login(payload.organization)
  );
}

export type AccountVerdict = { allowed: true } | { allowed: false; account: string | undefined };

/**
 * Whether a delivery may be processed. Everything is allowed when the list is empty, and so is a
 * delivery without an installation (`ping`, App-level events): no installation token can be
 * minted for it. Otherwise the account comes from the payload or, when the payload names none,
 * from the stored installation; an account that cannot be found is refused.
 */
export async function checkAccount(
  db: Db,
  allowed: readonly string[],
  installationId: number | undefined,
  payload: Record<string, unknown>,
): Promise<AccountVerdict> {
  if (allowed.length === 0 || installationId === undefined) return { allowed: true };
  let account = payloadAccount(payload);
  if (account === undefined) {
    const row = await db
      .selectFrom("installations")
      .select("account_login")
      .where("id", "=", installationId)
      .executeTakeFirst();
    account = row?.account_login ? row.account_login.toLowerCase() : undefined;
  }
  return account !== undefined && allowed.includes(account)
    ? { allowed: true }
    : { allowed: false, account };
}
