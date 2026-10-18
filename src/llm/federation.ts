/**
 * Workload Identity Federation: the workload exchanges an OIDC JWT from its platform (a projected
 * Kubernetes token, a cloud metadata token written to a file) for a short-lived Claude API token.
 *
 * Shared by `src/config` and `src/eval/env`, which both parse the same variables. The SDK's own
 * environment resolution is never used: the validated values are passed explicitly.
 */
import { isAbsolute } from "node:path";
import { identityTokenFromFile } from "@anthropic-ai/sdk/lib/credentials/identity-token";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import type { AccessTokenProvider } from "@anthropic-ai/sdk/lib/credentials/types";
import { WorkloadIdentityError } from "@anthropic-ai/sdk/lib/credentials/types";
import { z } from "zod";
import type { LlmFailure } from "./types.js";

export interface AnthropicFederation {
  /** `fdrl_...`; the one federation value that is logged. */
  readonly ruleId: string;
  /** Organization UUID. */
  readonly organizationId: string;
  /** `svac_...`. */
  readonly serviceAccountId: string;
  /** `wrkspc_...` (or `default`); needed when the rule spans several workspaces. */
  readonly workspaceId: string | undefined;
  /** Absolute path to the identity token, re-read on every exchange. */
  readonly identityTokenFile: string;
}

const TAGGED = (prefix: string) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,200}$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The field rules; each parser wraps them in its own optional/empty handling. */
export const FEDERATION_FIELDS = {
  ANTHROPIC_FEDERATION_RULE_ID: z
    .string()
    .regex(TAGGED("fdrl"), "must be a federation rule ID (fdrl_...)"),
  ANTHROPIC_ORGANIZATION_ID: z.string().regex(UUID, "must be the organization UUID"),
  ANTHROPIC_SERVICE_ACCOUNT_ID: z
    .string()
    .regex(TAGGED("svac"), "must be a service account ID (svac_...)"),
  ANTHROPIC_WORKSPACE_ID: z
    .string()
    .refine(
      (v) => v === "default" || TAGGED("wrkspc").test(v),
      "must be a workspace ID (wrkspc_...) or default",
    ),
  ANTHROPIC_IDENTITY_TOKEN_FILE: z
    .string()
    .refine((v) => isAbsolute(v) && !v.includes("\0"), "must be an absolute file path"),
} as const;

const REQUIRED = [
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
] as const;

export interface CredentialEnv {
  ANTHROPIC_API_KEY?: string | undefined;
  ANTHROPIC_AUTH_TOKEN?: string | undefined;
  ANTHROPIC_BASE_URL?: string | undefined;
  ANTHROPIC_FEDERATION_RULE_ID?: string | undefined;
  ANTHROPIC_ORGANIZATION_ID?: string | undefined;
  ANTHROPIC_SERVICE_ACCOUNT_ID?: string | undefined;
  ANTHROPIC_WORKSPACE_ID?: string | undefined;
  ANTHROPIC_IDENTITY_TOKEN_FILE?: string | undefined;
}

function federationSet(d: CredentialEnv): boolean {
  return [...REQUIRED, "ANTHROPIC_WORKSPACE_ID" as const].some((k) => d[k] !== undefined);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Cross-field rules on already-parsed values: at most one way to authenticate, federation is
 * all-or-nothing, and the identity token never travels over cleartext HTTP. Names only, never values.
 */
export function credentialProblems(d: CredentialEnv): string[] {
  const problems: string[] = [];
  const federation = federationSet(d);
  const ways = [
    d.ANTHROPIC_API_KEY !== undefined ? "ANTHROPIC_API_KEY" : null,
    d.ANTHROPIC_AUTH_TOKEN !== undefined ? "ANTHROPIC_AUTH_TOKEN" : null,
    federation ? "ANTHROPIC_FEDERATION_*" : null,
  ].filter((w) => w !== null);
  if (ways.length > 1) {
    problems.push(`${ways.join(" / ")}: set at most one way to authenticate, not several`);
  }
  if (federation) {
    const missing = REQUIRED.filter((k) => d[k] === undefined);
    if (missing.length > 0) {
      problems.push(`${missing.join(" / ")}: federation needs all of ${REQUIRED.join(", ")}`);
    }
    if (d.ANTHROPIC_BASE_URL !== undefined) {
      const u = new URL(d.ANTHROPIC_BASE_URL);
      if (u.protocol !== "https:" && !LOOPBACK.has(u.hostname)) {
        problems.push("ANTHROPIC_BASE_URL: must be https with federation (it receives the token)");
      }
    }
  }
  return problems;
}

/** Call after `credentialProblems` returned nothing. */
export function federationFrom(d: CredentialEnv): AnthropicFederation | undefined {
  if (
    d.ANTHROPIC_FEDERATION_RULE_ID === undefined ||
    d.ANTHROPIC_ORGANIZATION_ID === undefined ||
    d.ANTHROPIC_SERVICE_ACCOUNT_ID === undefined ||
    d.ANTHROPIC_IDENTITY_TOKEN_FILE === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    ruleId: d.ANTHROPIC_FEDERATION_RULE_ID,
    organizationId: d.ANTHROPIC_ORGANIZATION_ID,
    serviceAccountId: d.ANTHROPIC_SERVICE_ACCOUNT_ID,
    workspaceId: d.ANTHROPIC_WORKSPACE_ID,
    identityTokenFile: d.ANTHROPIC_IDENTITY_TOKEN_FILE,
  });
}

/**
 * A failed token exchange, already mapped to the LLM failure taxonomy. Its message carries no
 * path, token or response body.
 */
export class FederationError extends Error {
  constructor(
    readonly failure: LlmFailure,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "FederationError";
  }
}

/** The exchange is not covered by the request's deadline signal: bound it on its own. */
const EXCHANGE_TIMEOUT_MS = 30_000;

function exchangeFailure(status: number | null, unreachable: boolean): LlmFailure {
  if (unreachable) return "unavailable";
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 500) return "unavailable";
  // 400/401/403: a rejected JWT, rule or ID; null: an unusable token or response.
  return "auth";
}

/**
 * The SDK's OIDC federation provider, reading the identity token file on every exchange (so a
 * rotated, single-use token is picked up), with its errors mapped to `FederationError`.
 */
export function federatedCredentials(
  f: AnthropicFederation,
  baseURL: string,
  fetchImpl: typeof fetch,
): AccessTokenProvider {
  const readToken = identityTokenFromFile(f.identityTokenFile);
  const identityTokenProvider = async () => {
    try {
      return await readToken();
    } catch {
      throw new FederationError(
        "auth",
        undefined,
        "identity token file cannot be read or is empty",
      );
    }
  };
  return async (opts) => {
    // Per exchange, so concurrent exchanges cannot see each other's network failure.
    let unreachable = false;
    const exchangeFetch: typeof fetch = async (input, init) => {
      try {
        return await fetchImpl(input, {
          ...init,
          signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        });
      } catch (err) {
        unreachable = true;
        throw err;
      }
    };
    try {
      return await oidcFederationProvider({
        identityTokenProvider,
        federationRuleId: f.ruleId,
        organizationId: f.organizationId,
        serviceAccountId: f.serviceAccountId,
        workspaceId: f.workspaceId,
        baseURL: baseURL.replace(/\/+$/, ""),
        fetch: exchangeFetch,
      })(opts);
    } catch (err) {
      if (err instanceof FederationError) throw err;
      if (err instanceof WorkloadIdentityError) {
        const status = err.statusCode;
        throw new FederationError(
          exchangeFailure(status, unreachable),
          status ?? undefined,
          `token exchange failed${status === null ? "" : ` with status ${status}`}`,
        );
      }
      throw err;
    }
  };
}
