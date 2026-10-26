/**
 * The provider registry: the model providers an operator configures on the server, and the roles
 * (`fast`, `strong`, `refusalFallback`) that point at them as `<provider id>/<model>`.
 *
 * Read from `GRAFT_LLM_PROVIDERS` (inline YAML or JSON) or `GRAFT_LLM_PROVIDERS_FILE`. Without
 * either, Graft keeps the single Messages API client built from the `ANTHROPIC_*` settings.
 *
 * Secrets never sit in the document: an entry names the environment variable that holds its key.
 * The resolved credential is kept in a closure, so serializing a registry never shows it. Problems
 * name fields and variables, never values.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AnthropicCredential } from "./anthropic.js";
import { FORBIDDEN_ENV } from "./cli.js";
import type { Price } from "./pricing.js";
import { FULL_CAPABILITIES, type LlmCapabilities, MODEL_ID } from "./types.js";

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,29}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** A model ID on a provider other than an Anthropic-format endpoint: no spaces, no control characters. */
export const GENERIC_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,159}$/;

const envName = z.string().regex(ENV_NAME, "must be an environment variable name");
const httpUrl = z
  .string()
  .refine(
    (v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol),
    "must be an http(s) URL",
  );
const usd = z.number().min(0).max(1000);
const price = z
  .object({ input: usd, output: usd, cacheRead: usd.optional(), cacheWrite: usd.optional() })
  .strict();
const capabilityOverrides = z
  .object({
    nativeSchema: z.boolean().optional(),
    promptCache: z.boolean().optional(),
    effort: z.boolean().optional(),
    reportsUsage: z.boolean().optional(),
  })
  .strict();

const common = {
  id: z.string().regex(PROVIDER_ID, "must be 1-30 characters of a-z, 0-9 and '-'"),
  capabilities: capabilityOverrides.optional(),
  prices: z.record(z.string().regex(GENERIC_MODEL_ID, "must be a model ID"), price).optional(),
};

const anthropicEntry = z
  .object({
    ...common,
    kind: z.literal("anthropic"),
    baseUrl: httpUrl.optional(),
    apiKeyEnv: envName.optional(),
    authTokenEnv: envName.optional(),
  })
  .strict();

const openAiCompatibleEntry = z
  .object({
    ...common,
    kind: z.literal("openai-compatible"),
    baseUrl: httpUrl,
    apiKeyEnv: envName.optional(),
    zeroRetention: z.boolean().optional(),
    maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  })
  .strict();

/** CLI kinds: a coding agent's command-line tool on this machine (self-hosted only). */
export const CLI_KINDS = ["cli:claude"] as const;
export type CliKind = (typeof CLI_KINDS)[number];

/** A bare command name looked up on PATH, or an absolute path. */
const COMMAND = /^(\/[^\0\n]{1,1023}|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

const cliEntry = <K extends CliKind>(kind: K) =>
  z
    .object({
      ...common,
      kind: z.literal(kind),
      command: z.string().regex(COMMAND, "must be a command name or an absolute path").optional(),
      passEnv: z
        .array(
          envName.refine(
            (n) => !FORBIDDEN_ENV.test(n),
            "names a variable Graft never passes to a CLI",
          ),
        )
        .max(20)
        .optional(),
    })
    .strict();

const entrySchema = z.discriminatedUnion(
  "kind",
  [anthropicEntry, openAiCompatibleEntry, cliEntry("cli:claude")],
  {
    error: `kind must be "anthropic", "openai-compatible" or ${CLI_KINDS.map((k) => `"${k}"`).join(", ")}`,
  },
);

const roleRef = z.string().min(3).max(200);
const documentSchema = z
  .object({
    providers: z.array(entrySchema).min(1).max(20),
    roles: z
      .object({ fast: roleRef, strong: roleRef, refusalFallback: roleRef.optional() })
      .strict(),
  })
  .strict();

type Entry = z.infer<typeof entrySchema>;
export type ProviderKind = Entry["kind"];

interface ProviderCommon {
  readonly id: string;
  readonly capabilities: LlmCapabilities;
  /** Per-model prices (USD per million tokens), matched by longest prefix of the bare model ID. */
  readonly prices: Readonly<Record<string, Price>>;
}

export interface AnthropicProvider extends ProviderCommon {
  readonly kind: "anthropic";
  /** Messages API base URL; undefined means the Claude API. */
  readonly baseUrl: string | undefined;
  /** True when the entry has no key of its own and uses the `ANTHROPIC_*` credential. */
  readonly sharedCredential: boolean;
  readonly credential: () => AnthropicCredential;
}

export interface OpenAiCompatibleProvider extends ProviderCommon {
  readonly kind: "openai-compatible";
  /** Chat Completions base URL (it ends before `/chat/completions`). */
  readonly baseUrl: string;
  /** Always false: the `ANTHROPIC_*` credential never goes to another format's endpoint. */
  readonly sharedCredential: false;
  /** The bearer token, or undefined for a server that needs none. */
  readonly credential: () => string | undefined;
  /** OpenRouter: zero-data-retention endpoints only, no data collection. */
  readonly zeroRetention: boolean;
  readonly maxTokensParam: "max_tokens" | "max_completion_tokens";
}

export interface CliProvider extends ProviderCommon {
  readonly kind: CliKind;
  /** A command name on PATH or an absolute path. */
  readonly command: string;
  /** Variables passed to the CLI on top of the base set (its login, say). */
  readonly passEnv: readonly string[];
  readonly baseUrl: undefined;
  readonly sharedCredential: false;
}

export type LlmProvider = AnthropicProvider | OpenAiCompatibleProvider | CliProvider;

/** `self-hosted` (the default) allows the CLI kinds; `hosted` refuses them. */
export type Deployment = "hosted" | "self-hosted";

/**
 * What each kind assumes before an entry's overrides. An OpenAI-format server is only assumed to
 * take JSON-schema output (Graft validates the answer anyway): many models reject
 * `reasoning_effort`, and caching, where it exists, needs no markers.
 */
export const DEFAULT_CAPABILITIES: Record<ProviderKind, LlmCapabilities> = {
  anthropic: FULL_CAPABILITIES,
  "openai-compatible": Object.freeze({
    nativeSchema: true,
    promptCache: false,
    effort: false,
    reportsUsage: true,
  }),
  // The CLI caches on its own; Graft cannot place markers.
  "cli:claude": Object.freeze({
    nativeSchema: true,
    promptCache: false,
    effort: true,
    reportsUsage: true,
  }),
};

export interface LlmRoles {
  readonly fast: string;
  readonly strong: string;
  readonly refusalFallback: string | undefined;
}

export interface LlmRegistry {
  readonly providers: readonly LlmProvider[];
  /** Each `<provider id>/<model>`. */
  readonly roles: LlmRoles;
}

/** Which model IDs each kind accepts. */
const MODEL_PATTERN: Record<ProviderKind, { re: RegExp; message: string }> = {
  anthropic: { re: MODEL_ID, message: "must be a Claude model ID" },
  "openai-compatible": { re: GENERIC_MODEL_ID, message: "must be a model ID" },
  "cli:claude": { re: MODEL_ID, message: "must be a Claude model ID" },
};

const DEFAULT_COMMAND: Record<CliKind, string> = { "cli:claude": "claude" };

function isCliKind(kind: string): kind is CliKind {
  return (CLI_KINDS as readonly string[]).includes(kind);
}

/** The `ANTHROPIC_*` settings an `anthropic` entry without its own key falls back to. */
export interface AnthropicDefaults {
  credential: AnthropicCredential | null;
  baseUrl: string | undefined;
}

/** `<provider id>/<model>` split at the first `/`; null when there is no provider part. */
export function splitModelRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

function capabilitiesOf(e: Entry): LlmCapabilities {
  return Object.freeze({ ...DEFAULT_CAPABILITIES[e.kind], ...(e.capabilities ?? {}) });
}

function pricesOf(e: Entry): Readonly<Record<string, Price>> {
  const out: Record<string, Price> = {};
  for (const [model, p] of Object.entries(e.prices ?? {})) {
    // An unpriced cache rate costs what plain input does: never cheaper than the operator said.
    out[model] = Object.freeze({
      input: p.input,
      output: p.output,
      cacheRead: p.cacheRead ?? p.input,
      cacheWrite: p.cacheWrite ?? p.input,
    });
  }
  return Object.freeze(out);
}

function secretFrom(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  field: string,
  problems: string[],
): string | undefined {
  const v = env[name];
  if (v === undefined || v.trim() === "") {
    problems.push(`${field}: names a variable that is not set`);
    return undefined;
  }
  return v;
}

function anthropicProvider(
  e: Extract<Entry, { kind: "anthropic" }>,
  at: string,
  env: Readonly<Record<string, string | undefined>>,
  defaults: AnthropicDefaults,
  problems: string[],
): AnthropicProvider | null {
  if (e.apiKeyEnv !== undefined && e.authTokenEnv !== undefined) {
    problems.push(`${at}.apiKeyEnv / ${at}.authTokenEnv: set at most one, not both`);
    return null;
  }
  const base = {
    id: e.id,
    kind: "anthropic" as const,
    capabilities: capabilitiesOf(e),
    prices: pricesOf(e),
  };
  if (e.apiKeyEnv !== undefined) {
    const apiKey = secretFrom(env, e.apiKeyEnv, `${at}.apiKeyEnv`, problems);
    if (apiKey === undefined) return null;
    return { ...base, baseUrl: e.baseUrl, sharedCredential: false, credential: () => ({ apiKey }) };
  }
  if (e.authTokenEnv !== undefined) {
    const authToken = secretFrom(env, e.authTokenEnv, `${at}.authTokenEnv`, problems);
    if (authToken === undefined) return null;
    return {
      ...base,
      baseUrl: e.baseUrl,
      sharedCredential: false,
      credential: () => ({ authToken }),
    };
  }
  const shared = defaults.credential;
  if (shared === null) {
    problems.push(
      `${at}: has no credential; set apiKeyEnv or authTokenEnv, or the ANTHROPIC_* credential`,
    );
    return null;
  }
  // The shared credential goes where ANTHROPIC_BASE_URL says (federation exchanges its token there).
  if (e.baseUrl !== undefined) {
    problems.push(
      `${at}.baseUrl: an entry using the ANTHROPIC_* credential uses ANTHROPIC_BASE_URL; set apiKeyEnv or authTokenEnv to use another URL`,
    );
    return null;
  }
  return { ...base, baseUrl: defaults.baseUrl, sharedCredential: true, credential: () => shared };
}

function openAiCompatibleProvider(
  e: Extract<Entry, { kind: "openai-compatible" }>,
  at: string,
  env: Readonly<Record<string, string | undefined>>,
  problems: string[],
): OpenAiCompatibleProvider | null {
  let apiKey: string | undefined;
  if (e.apiKeyEnv !== undefined) {
    apiKey = secretFrom(env, e.apiKeyEnv, `${at}.apiKeyEnv`, problems);
    if (apiKey === undefined) return null;
  }
  const host = new URL(e.baseUrl).hostname;
  if (e.zeroRetention === true && host !== "openrouter.ai") {
    problems.push(`${at}.zeroRetention: is only understood by OpenRouter (openrouter.ai)`);
    return null;
  }
  return {
    id: e.id,
    kind: "openai-compatible",
    capabilities: capabilitiesOf(e),
    prices: pricesOf(e),
    baseUrl: e.baseUrl,
    sharedCredential: false,
    credential: () => apiKey,
    zeroRetention: e.zeroRetention ?? false,
    maxTokensParam:
      e.maxTokensParam ?? (host === "api.openai.com" ? "max_completion_tokens" : "max_tokens"),
  };
}

function cliProvider(
  e: Extract<Entry, { kind: CliKind }>,
  at: string,
  deployment: Deployment,
  problems: string[],
): CliProvider | null {
  if (deployment === "hosted") {
    // Section 1 of docs/plan/llm-provider-expansion.md: a personal CLI login may not serve
    // other people's pull requests.
    problems.push(
      `${at}.kind: ${e.kind} uses a personal CLI login and is refused when GRAFT_DEPLOYMENT=hosted`,
    );
    return null;
  }
  return {
    id: e.id,
    kind: e.kind,
    capabilities: capabilitiesOf(e),
    prices: pricesOf(e),
    command: e.command ?? DEFAULT_COMMAND[e.kind],
    passEnv: Object.freeze([...(e.passEnv ?? [])]),
    baseUrl: undefined,
    sharedCredential: false,
  };
}

function issuePath(path: readonly PropertyKey[]): string {
  return path
    .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
    .join("")
    .slice(1);
}

/**
 * Parse and check a registry document. `source` names the variable it came from, for messages.
 * `env` resolves `apiKeyEnv` / `authTokenEnv`; nothing else is read from it.
 */
export function parseRegistry(
  source: string,
  text: string,
  env: Readonly<Record<string, string | undefined>>,
  defaults: AnthropicDefaults,
  deployment: Deployment = "self-hosted",
): { registry: LlmRegistry; problems: [] } | { registry: undefined; problems: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    // The parser's message can quote the document: report the position-free fact only.
    return { registry: undefined, problems: [`${source}: is not valid YAML or JSON`] };
  }
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      registry: undefined,
      problems: parsed.error.issues.map((i) => {
        const at = issuePath(i.path);
        return `${source}: ${at === "" ? "" : `${at}: `}${i.code === "invalid_type" ? "is missing or has the wrong type" : i.message}`;
      }),
    };
  }

  const problems: string[] = [];
  const providers: LlmProvider[] = [];
  const seen = new Set<string>();
  parsed.data.providers.forEach((e, i) => {
    const at = `${source}: providers[${i}]`;
    if (seen.has(e.id)) {
      problems.push(`${at}.id: is used by another provider`);
      return;
    }
    seen.add(e.id);
    const p =
      e.kind === "anthropic"
        ? anthropicProvider(e, at, env, defaults, problems)
        : e.kind === "openai-compatible"
          ? openAiCompatibleProvider(e, at, env, problems)
          : cliProvider(e, at, deployment, problems);
    if (p) providers.push(Object.freeze(p));
  });

  // A CLI gets no other provider's key: those variables are for their own endpoints.
  const keyVars = new Set(
    parsed.data.providers.flatMap((e) =>
      "apiKeyEnv" in e || "authTokenEnv" in e
        ? [
            ...("apiKeyEnv" in e && e.apiKeyEnv ? [e.apiKeyEnv] : []),
            ...("authTokenEnv" in e && e.authTokenEnv ? [e.authTokenEnv] : []),
          ]
        : [],
    ),
  );
  parsed.data.providers.forEach((e, i) => {
    if (!isCliKind(e.kind) || !("passEnv" in e)) return;
    (e.passEnv ?? []).forEach((name, j) => {
      if (keyVars.has(name)) {
        problems.push(`${source}: providers[${i}].passEnv[${j}]: is another provider's key`);
      }
    });
  });

  const byId = new Map(providers.map((p) => [p.id, p]));
  const role = (name: keyof LlmRoles, ref: string | undefined): string | undefined => {
    if (ref === undefined) return undefined;
    const at = `${source}: roles.${name}`;
    const split = splitModelRef(ref);
    if (!split) {
      problems.push(`${at}: must be <provider id>/<model>`);
      return undefined;
    }
    const p = byId.get(split.provider);
    if (!p) {
      if (!seen.has(split.provider)) problems.push(`${at}: names no configured provider`);
      return undefined;
    }
    const rule = MODEL_PATTERN[p.kind];
    if (!rule.re.test(split.model)) {
      problems.push(`${at}: ${rule.message} for a ${p.kind} provider`);
      return undefined;
    }
    return ref;
  };
  const fast = role("fast", parsed.data.roles.fast);
  const strong = role("strong", parsed.data.roles.strong);
  const refusalFallback = role("refusalFallback", parsed.data.roles.refusalFallback);

  if (problems.length > 0 || fast === undefined || strong === undefined) {
    return { registry: undefined, problems };
  }
  return {
    registry: Object.freeze({
      providers: Object.freeze(providers),
      roles: Object.freeze({ fast, strong, refusalFallback }),
    }),
    problems: [],
  };
}

/** The model variables a registry replaces; setting one beside it is an error, not an override. */
export const LEGACY_MODEL_VARS = [
  "GRAFT_LLM_MODEL_FAST",
  "GRAFT_LLM_MODEL_STRONG",
  "GRAFT_LLM_REFUSAL_FALLBACK_MODEL",
] as const;

/**
 * The registry from `GRAFT_LLM_PROVIDERS` or `GRAFT_LLM_PROVIDERS_FILE`, for the server config and
 * the eval tool alike. Undefined, with no problem, when neither is set. `env` is the raw
 * environment: it tells whether a model variable was set and resolves each entry's key variable.
 */
export function loadRegistry(o: {
  inline: string | undefined;
  file: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  defaults: AnthropicDefaults;
  deployment?: Deployment;
}): { registry: LlmRegistry | undefined; problems: string[] } {
  if (o.inline === undefined && o.file === undefined) return { registry: undefined, problems: [] };
  if (o.inline !== undefined && o.file !== undefined) {
    return {
      registry: undefined,
      problems: ["GRAFT_LLM_PROVIDERS / GRAFT_LLM_PROVIDERS_FILE: set at most one, not both"],
    };
  }
  const legacy = LEGACY_MODEL_VARS.filter((k) => (o.env[k] ?? "").trim() !== "");
  if (legacy.length > 0) {
    return {
      registry: undefined,
      problems: [
        `${legacy.join(" / ")}: unset with a provider registry; its roles name the models`,
      ],
    };
  }
  if (o.file !== undefined) {
    let text: string;
    try {
      text = readFileSync(o.file, "utf8");
    } catch {
      return { registry: undefined, problems: ["GRAFT_LLM_PROVIDERS_FILE: file cannot be read"] };
    }
    return parseRegistry("GRAFT_LLM_PROVIDERS_FILE", text, o.env, o.defaults, o.deployment);
  }
  return parseRegistry("GRAFT_LLM_PROVIDERS", o.inline as string, o.env, o.defaults, o.deployment);
}
