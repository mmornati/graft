/**
 * Phase 1 step 6: a real `@modelcontextprotocol/client` over HTTP with a bearer token (the client
 * transport's `requestInit` headers), raw JSON-RPC posts for the HTTP-level cases, and a token
 * inserted through the store the CLI uses.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Db } from "../../src/db/client.js";
import { generateToken, hashToken, tokenPrefix } from "../../src/mcp/tokens.js";
import { createTokenRow } from "../../src/modules/mcp/store.js";

export const LEGACY_PROTOCOL = "2025-11-25";
export const MODERN_PROTOCOL = "2026-07-28";

export interface McpClientHandle {
  client: Client;
  /** Every HTTP status the transport saw, in order. */
  statuses: number[];
  close(): Promise<void>;
}

/**
 * A connected client. `era: "legacy"` runs the 2025 `initialize` handshake; `"modern"` pins the
 * 2026-07-28 revision (a `server/discover` probe, no `initialize`).
 */
export async function mcpClient(
  url: URL,
  token: string | null,
  o: { era?: "legacy" | "modern"; headers?: Record<string, string> } = {},
): Promise<McpClientHandle> {
  const statuses: number[] = [];
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      statuses.push(res.status);
      return res;
    },
  });
  const client = new Client(
    { name: "graft-test", version: "1.0.0" },
    {
      ...(o.era === "modern"
        ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL } } }
        : { supportedProtocolVersions: [LEGACY_PROTOCOL] }),
    },
  );
  await client.connect(transport);
  return { client, statuses, close: () => client.close() };
}

/** `tools/call` and its structured result (`isError` results included). */
export async function call(
  h: McpClientHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; out: Record<string, unknown>; text: string }> {
  const res = (await h.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: { type: string; text?: string }[];
  };
  return {
    isError: res.isError === true,
    out: res.structuredContent ?? {},
    text: res.content?.find((c) => c.type === "text")?.text ?? "",
  };
}

/** A raw JSON-RPC POST (legacy era: no envelope), for HTTP-level assertions. */
export async function rawPost(
  url: URL,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LEGACY_PROTOCOL,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const LIST_TOOLS = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: LEGACY_PROTOCOL,
    capabilities: {},
    clientInfo: { name: "curl", version: "1" },
  },
};

/** A token for a repository, stored as `mcp-token create` stores it. Returns the token and id. */
export async function createTestToken(
  db: Db,
  o: { repositoryId: number; name?: string; now?: Date; days?: number },
): Promise<{ token: string; id: string }> {
  const token = generateToken();
  const now = o.now ?? new Date();
  const created = await createTokenRow(db, {
    repositoryId: o.repositoryId,
    name: o.name ?? `test-${tokenPrefix(token)}`,
    tokenHash: hashToken(token),
    tokenPrefix: tokenPrefix(token),
    createdBy: "tester",
    now,
    expiresAt: new Date(now.getTime() + (o.days ?? 30) * 86_400_000),
    maxActive: 50,
  });
  if (!created.ok) throw new Error(`token not created: ${created.reason}`);
  return { token, id: created.id };
}
