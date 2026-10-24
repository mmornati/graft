/**
 * `/mcp` on the existing Fastify server (D2–D5, D9 a and b, D10). Stateless streamable HTTP through
 * the SDK's `createMcpHandler`, wrapped once with `toNodeHandler`. Before the SDK sees a request:
 * the Origin check (D4), the bearer token (D5, D7, with the failed-auth limit per IP, D9 b) and the
 * per-token limit (D9 a). Every request is authenticated on its own; nothing is cached.
 */
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseBearer } from "../../mcp/tokens.js";
import { authorizeToken, type McpAuthInfo, touchLastUsed } from "./auth.js";
import { createFailureCounter, createTokenBucket } from "./rate-limit.js";
import { createMcpServer, safeMcpError } from "./server.js";
import type { ToolDeps } from "./tools/common.js";

export const MCP_PATH = "/mcp";
export const MCP_BODY_LIMIT = 65_536;

const UNAUTHORIZED = { error: "unauthorized" } as const;

declare module "fastify" {
  interface FastifyRequest {
    mcpAuth?: McpAuthInfo;
  }
}

export function mcpRoutes(deps: ToolDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    const now = () => deps.clock.now().getTime();
    const perToken = createTokenBucket({ perMinute: deps.config.mcpRateLimitPerMinute, now });
    const failures = createFailureCounter({
      perMinute: deps.config.mcpAuthFailuresPerMinute,
      now,
    });
    const allowedOrigins = new Set(deps.config.mcpAllowedOrigins);
    const onerror = (err: Error) => deps.log.warn({ err: safeMcpError(err) }, "mcp sdk error");

    const handler = createMcpHandler(
      ({ authInfo }) => {
        const principal = (authInfo as McpAuthInfo | undefined)?.extra;
        if (!principal) throw new Error("mcp request without a verified principal");
        return createMcpServer(deps, principal);
      },
      { legacy: "stateless", responseMode: "json", maxRequestBodySize: MCP_BODY_LIMIT, onerror },
    );
    const nodeHandler = toNodeHandler(handler, { onerror, maxRequestBodySize: MCP_BODY_LIMIT });
    app.addHook("onClose", async () => {
      await handler.close();
    });

    // Only JSON (Fastify's own parser): any other media type is answered 415 in this scope.
    app.removeContentTypeParser("text/plain");

    // D5: one response for every authentication failure, whatever the cause: same status, header
    // and bytes.
    const unauthorized = (reply: FastifyReply) =>
      reply.code(401).header("www-authenticate", 'Bearer realm="graft"').send(UNAUTHORIZED);

    const tooMany = (reply: FastifyReply, seconds: number) =>
      reply.code(429).header("retry-after", String(seconds)).send({ error: "rate_limited" });

    const originCheck = async (req: FastifyRequest, reply: FastifyReply) => {
      const origin = req.headers.origin;
      if (origin === undefined) return;
      if (typeof origin === "string" && allowedOrigins.has(origin.toLowerCase())) return;
      return reply.code(403).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "origin not allowed" },
        id: null,
      });
    };

    const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = req.ip;
      const blocked = failures.check(ip);
      if (!blocked.ok) return tooMany(reply, blocked.retryAfterSeconds);
      const token = parseBearer(req.headers.authorization);
      const auth = token === null ? null : await authorizeToken(deps.db, token);
      if (auth === null) {
        failures.fail(ip);
        return unauthorized(reply);
      }
      req.mcpAuth = auth;
      await touchLastUsed(deps.db, auth.extra.tokenId);
    };

    const rateLimit = async (req: FastifyRequest, reply: FastifyReply) => {
      const tokenId = req.mcpAuth?.extra.tokenId;
      // Unreachable while `authenticate` runs first; the same D5 answer if that ever changes.
      if (tokenId === undefined) return unauthorized(reply);
      const verdict = perToken.take(tokenId);
      if (!verdict.ok) return tooMany(reply, verdict.retryAfterSeconds);
    };

    const serve = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      const raw = req.raw as typeof req.raw & { auth?: McpAuthInfo };
      raw.auth = req.mcpAuth;
      try {
        await nodeHandler(raw, reply.raw, req.body);
      } catch (err) {
        onerror(err as Error);
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "content-type": "application/json" });
          reply.raw.end(JSON.stringify({ error: "internal error" }));
        }
      }
    };

    app.route({
      method: ["POST", "GET", "DELETE"],
      url: MCP_PATH,
      bodyLimit: MCP_BODY_LIMIT,
      // Phase 1 step 7 (D5): the Origin check and the token read headers only, so they run in
      // `onRequest`, before Fastify parses or bounds the body: an unauthenticated request costs a
      // header read (401, or 403 for a foreign origin, never 413 or 415). The per-token bucket
      // stays after parsing.
      onRequest: [originCheck, authenticate],
      preHandler: [rateLimit],
      handler: serve,
    });
  };
}
