// Network guard, as in Graft's own tests: a fetch to anything but localhost fails the test.
const realFetch = globalThis.fetch;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const host = new URL(raw).hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`network access in tests: ${host}`);
  return realFetch(input, init);
}) as typeof fetch;
