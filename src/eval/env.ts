/**
 * Eval-only environment parsing (T15). Same defaults and parsing as `src/config`, copied on
 * purpose: the eval tool never imports `src/config`, which would demand a database URL and the
 * webhook secret.
 */
import { z } from "zod";
import { MODEL_ID } from "../llm/types.js";

export class EvalEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalEnvError";
  }
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, def: string) =>
  z.preprocess((v) => emptyToUndefined(v) ?? def, schema);
const intString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
const csv = (v: string): string[] =>
  v
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x !== "");
const loginList = z
  .string()
  .transform(csv)
  .refine((l) => l.every((x) => /^[a-z0-9-]+(\[bot\])?$/.test(x)), {
    message: "must be comma-separated GitHub logins (letters, digits, '-', optional [bot])",
  });
const emailList = z
  .string()
  .transform(csv)
  .refine((l) => l.every((x) => x.split("@").length === 2 && !/\s/.test(x)), {
    message: "must be comma-separated emails, each with exactly one '@'",
  });
const modelId = z.string().regex(MODEL_ID, "must be a Claude model ID");
const httpUrl = z
  .string()
  .refine(
    (v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol),
    "must be an http(s) URL",
  );
const boolString = z
  .enum(["true", "false"], { error: "must be true or false" })
  .transform((v) => v === "true");

const EnvSchema = z.object({
  GRAFT_EVAL_DIR: opt(z.string()),
  GRAFT_EVAL_KEY: opt(z.string()),
  GRAFT_EVAL_GITHUB_TOKEN: opt(z.string()),
  ANTHROPIC_API_KEY: opt(z.string().min(1)),
  ANTHROPIC_AUTH_TOKEN: opt(z.string().min(1)),
  ANTHROPIC_BASE_URL: opt(httpUrl),
  GRAFT_LLM_MODEL_FAST: withDefault(modelId, "claude-haiku-5-5"),
  GRAFT_LLM_MODEL_STRONG: withDefault(modelId, "claude-sonnet-5-5"),
  GRAFT_LLM_TIMEOUT_MS: withDefault(intString(5_000, 600_000), "120000"),
  GRAFT_LLM_MAX_RETRIES: withDefault(intString(0, 5), "2"),
  GRAFT_LLM_REFUSAL_FALLBACK: withDefault(boolString, "true"),
  GRAFT_LLM_REFUSAL_FALLBACK_MODEL: opt(modelId),
  GRAFT_AGENT_LOGINS: withDefault(loginList, ""),
  GRAFT_AGENT_COAUTHOR_EMAILS: withDefault(emailList, "noreply@anthropic.com"),
  GITHUB_APP_ID: opt(intString(1, Number.MAX_SAFE_INTEGER)),
  GITHUB_APP_PRIVATE_KEY_PATH: opt(z.string()),
  GITHUB_API_URL: withDefault(
    z.string().refine((v) => URL.canParse(v), "must be a URL"),
    "https://api.github.com",
  ),
});

export interface EvalEnv {
  evalDir: string | undefined;
  evalKey: string | undefined;
  githubToken: string | undefined;
  anthropicApiKey: string | undefined;
  anthropicAuthToken: string | undefined;
  anthropicBaseUrl: string | undefined;
  modelFast: string;
  modelStrong: string;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  llmRefusalFallback: boolean;
  llmRefusalFallbackModel: string | undefined;
  agentLogins: readonly string[];
  agentCoauthorEmails: readonly string[];
  githubAppId: number | undefined;
  githubAppPrivateKeyPath: string | undefined;
  githubApiUrl: string;
}

/** Error messages name variables only, never their values. */
export function parseEvalEnv(env: Record<string, string | undefined>): EvalEnv {
  const res = EnvSchema.safeParse(env);
  if (!res.success) {
    const problems = res.error.issues.map(
      (i) =>
        `${String(i.path[0] ?? "env")}: ${i.code === "invalid_type" ? "is required" : i.message}`,
    );
    throw new EvalEnvError(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  }
  const d = res.data;
  if (d.ANTHROPIC_API_KEY !== undefined && d.ANTHROPIC_AUTH_TOKEN !== undefined) {
    throw new EvalEnvError(
      "Invalid configuration:\n- ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: set at most one, not both",
    );
  }
  return {
    evalDir: d.GRAFT_EVAL_DIR,
    evalKey: d.GRAFT_EVAL_KEY,
    githubToken: d.GRAFT_EVAL_GITHUB_TOKEN,
    anthropicApiKey: d.ANTHROPIC_API_KEY,
    anthropicAuthToken: d.ANTHROPIC_AUTH_TOKEN,
    anthropicBaseUrl: d.ANTHROPIC_BASE_URL,
    modelFast: d.GRAFT_LLM_MODEL_FAST,
    modelStrong: d.GRAFT_LLM_MODEL_STRONG,
    llmTimeoutMs: d.GRAFT_LLM_TIMEOUT_MS,
    llmMaxRetries: d.GRAFT_LLM_MAX_RETRIES,
    llmRefusalFallback: d.GRAFT_LLM_REFUSAL_FALLBACK,
    llmRefusalFallbackModel: d.GRAFT_LLM_REFUSAL_FALLBACK_MODEL,
    agentLogins: Object.freeze([...d.GRAFT_AGENT_LOGINS]),
    agentCoauthorEmails: Object.freeze([...d.GRAFT_AGENT_COAUTHOR_EMAILS]),
    githubAppId: d.GITHUB_APP_ID,
    githubAppPrivateKeyPath: d.GITHUB_APP_PRIVATE_KEY_PATH,
    githubApiUrl: d.GITHUB_API_URL,
  };
}
