/**
 * The environment of a child process (`git`, `gh`, `pnpm exec vitest`). The runner's own secrets
 * stay in the runner: no child inherits `GRAFT_E2E_*`. A `git` child also starts without any
 * `GIT_*` variable (`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, `GIT_ASKPASS`, `GIT_TRACE_CURL`,
 * ...), so only what the pusher sets explicitly applies.
 */
export function childEnv(
  parent: Record<string, string | undefined>,
  command: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (k.startsWith("GRAFT_E2E_")) continue;
    if (command === "git" && k.startsWith("GIT_")) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}
