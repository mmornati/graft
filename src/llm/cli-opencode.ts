/**
 * opencode in run mode (`opencode run`), checked against opencode 1.19.3:
 *
 *   opencode run --pure --agent graft --format json -m <provider/model> [--variant <effort>]
 *
 * opencode has no flag to switch tools off, so the call carries its own config in
 * `OPENCODE_CONFIG_CONTENT`: one agent, `graft`, whose prompt is Graft's system prompt, with every
 * tool turned off by name (`"*": false` alone still offered `bash` in testing) and every
 * permission denied, no MCP server, plugin or instruction file. Project config, Claude Code
 * files, default plugins, external skills, LSP downloads and updates are switched off by their
 * `OPENCODE_DISABLE_*` variables, and its config and data directories point into the call's
 * scratch directory, so the user's global config is not loaded and no session stays on disk.
 *
 * That also hides `auth.json`: pass the login with `OPENCODE_AUTH_CONTENT` or a provider's own
 * key variable (`OPENROUTER_API_KEY`, ...) in the entry's `passEnv`.
 *
 * There is no schema flag: Graft puts the schema in the prompt and validates the answer.
 */
import path from "node:path";
import { type CliAdapter, type CliParsed, failureForMessage, failureForStatus } from "./cli.js";
import { parseJsonAnswer } from "./openai-compatible.js";
import { type LlmFailure, type LlmUsage, ZERO_USAGE } from "./types.js";

/** Every tool opencode 1.19.3 knows, off by name; `"*"` catches what a later version adds. */
const TOOLS_OFF = [
  "*",
  "bash",
  "edit",
  "write",
  "read",
  "list",
  "glob",
  "grep",
  "patch",
  "webfetch",
  "websearch",
  "codesearch",
  "task",
  "todowrite",
  "todoread",
  "skill",
  "lsp",
  "question",
] as const;

export function opencodeConfig(system: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    mcp: {},
    plugin: [],
    instructions: [],
    agent: {
      graft: {
        mode: "primary",
        prompt: system,
        tools: Object.fromEntries(TOOLS_OFF.map((t) => [t, false])),
        permission: { "*": "deny" },
      },
    },
  });
}

interface Event {
  type?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    reason?: string;
    state?: { status?: string };
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  error?: { name?: string; data?: { statusCode?: number; message?: string } };
}

export const opencodeCliAdapter: CliAdapter = {
  name: "opencode",
  build(req, caps, ctx) {
    return {
      args: [
        "run",
        "--pure",
        "--agent",
        "graft",
        "--format",
        "json",
        "-m",
        req.model,
        ...(caps.effort ? ["--variant", req.effort] : []),
      ],
      stdin: req.user,
      env: {
        OPENCODE_CONFIG_CONTENT: opencodeConfig(req.system),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(req.maxOutputTokens),
        XDG_CONFIG_HOME: path.join(ctx.scratchDir, "config"),
        XDG_DATA_HOME: path.join(ctx.scratchDir, "data"),
        XDG_STATE_HOME: path.join(ctx.scratchDir, "state"),
      },
    };
  },
  parse({ stdout, code }): CliParsed {
    const events: Event[] = [];
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as Event);
      } catch {
        // Not an event: opencode prints nothing else on stdout in json format.
      }
    }
    const usage: LlmUsage = { ...ZERO_USAGE };
    let text = "";
    let reason: string | undefined;
    let error: Event["error"] | undefined;
    let toolRan = false;
    for (const e of events) {
      if (e.type === "step_start") text = ""; // only the last step's text is the answer
      if (e.type === "text") text += e.part?.text ?? "";
      if (e.type === "tool_use" && e.part?.state?.status === "completed") toolRan = true;
      if (e.type === "error") error = e.error;
      if (e.type === "step_finish") {
        const t = e.part?.tokens;
        usage.inputTokens += t?.input ?? 0;
        usage.outputTokens += (t?.output ?? 0) + (t?.reasoning ?? 0);
        usage.cacheReadTokens += t?.cache?.read ?? 0;
        usage.cacheWriteTokens += t?.cache?.write ?? 0;
        reason = e.part?.reason;
      }
    }
    const fail = (failure: LlmFailure): CliParsed => ({ ok: false, failure, usage });

    // Every tool is off: a tool that ran means the isolation failed, so nothing it produced is used.
    if (toolRan) return fail("bad_request");
    if (error) {
      const status = error.data?.statusCode;
      return fail(
        typeof status === "number"
          ? failureForStatus(status)
          : failureForMessage(error.data?.message ?? ""),
      );
    }
    if (events.length === 0) return fail(code === 0 ? "invalid_json" : "unavailable");
    if (reason === "length") return fail("max_tokens");
    if (reason === "content-filter") return fail("refusal");
    const parsed = parseJsonAnswer(text);
    return parsed.ok ? { ok: true, value: parsed.value, usage } : fail("invalid_json");
  },
};
