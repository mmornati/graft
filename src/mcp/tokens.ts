/**
 * MCP tokens (Phase 1 step 6, D6). Pure apart from `node:crypto`: no database, no GitHub.
 *
 * A token is `graft_mcp_` followed by 43 base64url characters (32 random bytes). Graft stores the
 * hex SHA-256 of the whole string and the first 8 characters after the prefix, never the token.
 * The token has 256 bits of entropy, so a fast unpeppered hash is as strong as a slow one, and the
 * lookup is by hash, so no secret is ever compared in user code.
 */
import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "graft_mcp_";
const SECRET_CHARS = 43;
/** D7: the one accepted header shape. Case and spacing are exact on purpose. */
const BEARER_RE = /^Bearer (graft_mcp_[A-Za-z0-9_-]{43})$/;
/** D10: any token-shaped substring, for redaction. */
const TOKEN_LIKE_RE = /graft_mcp_[A-Za-z0-9_-]{43}/g;

export function generateToken(): string {
  const secret = randomBytes(32).toString("base64url");
  if (secret.length !== SECRET_CHARS) throw new Error("unexpected token length");
  return `${TOKEN_PREFIX}${secret}`;
}

/** Hex SHA-256 of the whole token string, prefix included. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The first 8 characters after `graft_mcp_`, shown by `mcp-token list`. */
export function tokenPrefix(token: string): string {
  return token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8);
}

/** The token of an `Authorization` header value, or null for anything but the exact D7 shape. */
export function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  return BEARER_RE.exec(header)?.[1] ?? null;
}

/** Replaces every token-shaped substring with `graft_mcp_[redacted]`. */
export function redactTokens(text: string): string {
  return text.replace(TOKEN_LIKE_RE, `${TOKEN_PREFIX}[redacted]`);
}
