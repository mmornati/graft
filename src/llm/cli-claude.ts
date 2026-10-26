/**
 * Claude Code in print mode (`claude -p`), checked against Claude Code 2.1.284:
 *
 *   claude -p --output-format json --tools "" --strict-mcp-config --setting-sources ""
 *     --disable-slash-commands --no-session-persistence --model <id> --system-prompt <system>
 *     [--effort <level>] [--json-schema <schema>]
 *
 * The PR text goes on stdin. No tool is available, no MCP server, settings file, hook, plugin or
 * skill is loaded, and nothing is saved. Pass explicit model IDs: aliases can resolve to older
 * models. The output-token limit goes through `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
 *
 * `--json-schema` is validated and re-prompted by the CLI, not constrained decoding; Graft
 * validates the answer again either way.
 */
import type { CliAdapter, CliParsed } from "./cli.js";
import { parseJsonAnswer } from "./openai-compatible.js";
import { type LlmFailure, type LlmUsage, ZERO_USAGE } from "./types.js";

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  stop_reason?: string | null;
  result?: string;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

function statusFailure(status: number): LlmFailure {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  if (status === 401 || status === 403) return "auth";
  return "bad_request";
}

/** The answering model: the one `modelUsage` reports, when it reports exactly one. */
function answeringModel(r: ClaudeResult): string | undefined {
  const ids = Object.keys(r.modelUsage ?? {});
  return ids.length === 1 ? ids[0] : undefined;
}

export const claudeCliAdapter: CliAdapter = {
  name: "claude",
  build(req, caps) {
    return {
      args: [
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--model",
        req.model,
        "--system-prompt",
        req.system,
        ...(caps.effort ? ["--effort", req.effort] : []),
        ...(caps.nativeSchema ? ["--json-schema", JSON.stringify(req.outputSchema)] : []),
      ],
      stdin: req.user,
      env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxOutputTokens) },
    };
  },
  parse({ stdout, code }): CliParsed {
    let r: ClaudeResult;
    try {
      r = JSON.parse(stdout) as ClaudeResult;
    } catch {
      // No JSON at all: the CLI failed before answering (not installed right, not logged in).
      return { ok: false, failure: code === 0 ? "invalid_json" : "unavailable", usage: ZERO_USAGE };
    }
    const usage: LlmUsage = {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
      cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: r.usage?.cache_creation_input_tokens ?? 0,
    };
    const model = answeringModel(r);
    const fail = (failure: LlmFailure): CliParsed => ({
      ok: false,
      failure,
      usage,
      ...(model ? { model } : {}),
    });

    if (typeof r.api_error_status === "number") return fail(statusFailure(r.api_error_status));
    if (r.subtype === "error_max_structured_output_retries" || r.subtype === "error_max_turns") {
      return fail("invalid_json");
    }
    if (r.stop_reason === "refusal") return fail("refusal");
    if (r.stop_reason === "max_tokens") return fail("max_tokens");
    if (r.is_error || r.type !== "result") {
      // An error without an HTTP status: most often no login. Its text is never logged.
      return fail(/log ?in|credential|api key|auth/i.test(r.result ?? "") ? "auth" : "unavailable");
    }
    if (r.structured_output !== undefined && r.structured_output !== null) {
      return { ok: true, value: r.structured_output, usage, ...(model ? { model } : {}) };
    }
    const parsed = parseJsonAnswer(r.result ?? "");
    return parsed.ok
      ? { ok: true, value: parsed.value, usage, ...(model ? { model } : {}) }
      : fail("invalid_json");
  },
};
