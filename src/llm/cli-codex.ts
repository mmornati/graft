/**
 * Codex in exec mode (`codex exec`), built from the help and feature list of codex-cli 0.162.1.
 * It has not been run against a live login: check it with `pnpm eval --live` before use.
 *
 *   codex exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
 *     --sandbox read-only --color never -m <model> -c <overrides> --disable <feature>... -
 *
 * Codex has no single switch for "no tools": every feature that gives the model a tool is
 * disabled by name, web search, MCP servers and AGENTS.md are switched off in config, the
 * sandbox is read-only, and shell commands inherit no environment. The adapter also fails any call
 * whose event stream shows a tool item, so a feature a later version adds cannot quietly run.
 *
 * Graft's system prompt goes in `developer_instructions`. The login is read from `CODEX_HOME`
 * (`~/.codex` unless the entry's `passEnv` names `CODEX_HOME`), or from `CODEX_API_KEY` /
 * `OPENAI_API_KEY` when `passEnv` names one; sessions are not saved (`--ephemeral`). OpenAI
 * recommends an API key or a Business access token for automation.
 */
import { type CliAdapter, type CliParsed, failureForMessage } from "./cli.js";
import { parseJsonAnswer } from "./openai-compatible.js";
import { type LlmFailure, type LlmUsage, ZERO_USAGE } from "./types.js";

/** Every codex-cli 0.162.1 feature that is on by default and hands the model a tool or a host. */
export const CODEX_FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "unified_exec_tty",
  "shell_snapshot",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "computer_use",
  "apps",
  "plugins",
  "remote_plugin",
  "hooks",
  "multi_agent",
  "image_generation",
  "view_image",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "goals",
  "code_mode_host",
  "sleep_tool",
  "workspace_dependencies",
  "worktrees",
  "in_app_local_automation",
] as const;

/** Item types that only carry text; anything else is a tool the model used. */
const TEXT_ITEMS = new Set(["agent_message", "reasoning", "todo_list", "error"]);

/** A TOML basic string: JSON's escapes are valid TOML escapes. */
const toml = (s: string) => JSON.stringify(s);

interface Event {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
}

export const codexCliAdapter: CliAdapter = {
  name: "codex",
  build(req, caps) {
    return {
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-m",
        req.model,
        "-c",
        `developer_instructions=${toml(req.system)}`,
        "-c",
        'web_search="disabled"',
        "-c",
        "mcp_servers={}",
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        'shell_environment_policy.inherit="none"',
        ...(caps.effort ? ["-c", `model_reasoning_effort=${toml(req.effort)}`] : []),
        ...CODEX_FEATURES_OFF.flatMap((f) => ["--disable", f]),
        "-", // the prompt is read from stdin
      ],
      stdin: req.user,
    };
  },
  parse({ stdout, code }): CliParsed {
    const events: Event[] = [];
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as Event);
      } catch {
        // Not an event.
      }
    }
    const usage: LlmUsage = { ...ZERO_USAGE };
    let text: string | undefined;
    let failed: string | undefined;
    let lastError: string | undefined;
    let completed = false;
    let toolUsed = false;
    for (const e of events) {
      const itemType = e.item?.type;
      if ((e.type === "item.started" || e.type === "item.completed") && itemType) {
        if (!TEXT_ITEMS.has(itemType)) toolUsed = true;
        if (e.type === "item.completed" && itemType === "agent_message") text = e.item?.text;
      }
      if (e.type === "turn.completed") completed = true;
      if (e.type === "turn.completed" && e.usage) {
        // OpenAI counts cached input inside input; Graft counts it apart, as Anthropic does.
        const cached = e.usage.cached_input_tokens ?? 0;
        usage.inputTokens += Math.max(0, (e.usage.input_tokens ?? 0) - cached);
        usage.cacheReadTokens += cached;
        usage.outputTokens += e.usage.output_tokens ?? 0;
      }
      if (e.type === "turn.failed") failed = e.error?.message ?? "";
      // "Reconnecting... 2/5" and the like: an outcome only if the turn never completes.
      if (e.type === "error") lastError = e.message ?? "";
    }
    if (failed === undefined && !completed && lastError !== undefined) failed = lastError;
    const fail = (failure: LlmFailure): CliParsed => ({ ok: false, failure, usage });

    if (toolUsed) return fail("bad_request");
    if (failed !== undefined) return fail(failureForMessage(failed));
    if (events.length === 0) return fail(code === 0 ? "invalid_json" : "unavailable");
    const parsed = parseJsonAnswer(text ?? "");
    return parsed.ok ? { ok: true, value: parsed.value, usage } : fail("invalid_json");
  },
};
