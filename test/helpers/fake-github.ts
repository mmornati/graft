import { createPublicKey, createVerify } from "node:crypto";
import { TEST_PUBLIC_KEY } from "./config.js";

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Verifies an RS256 JWT with the test public key; returns its claims or throws. */
export function verifyAppJwt(token: string): { iss: string | number; exp: number; iat: number } {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw new Error("not a JWT");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  if (!verifier.verify(createPublicKey(TEST_PUBLIC_KEY), b64urlDecode(sig))) {
    throw new Error("bad JWT signature");
  }
  return JSON.parse(b64urlDecode(p).toString("utf8"));
}

/** A fake fetch that serves just enough of the GitHub API for the client factory tests. */
export function createFakeGitHubFetch(opts: { token?: string; expiresInMs?: number } = {}) {
  const requests: RecordedRequest[] = [];
  const token = opts.token ?? "ghs_faketoken0123456789";
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 3600_000)).toISOString();

  const fetchFn: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? req?.headers);
    requests.push({ method, url, authorization: headers.get("authorization") ?? undefined });

    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "POST" && /\/app\/installations\/\d+\/access_tokens$/.test(url)) {
      return json(201, {
        token,
        expires_at: expiresAt,
        permissions: { metadata: "read" },
        repository_selection: "selected",
      });
    }
    if (method === "GET" && /\/rate_limit$/.test(url)) {
      return json(200, { resources: {}, rate: { limit: 1, remaining: 1, reset: 1 } });
    }
    return json(404, { message: "not found (fake)" });
  };

  return {
    fetch: fetchFn,
    requests,
    token,
    accessTokenRequests: () => requests.filter((r) => r.url.endsWith("/access_tokens")),
  };
}
