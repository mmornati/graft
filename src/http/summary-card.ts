import type { FastifyPluginAsync } from "fastify";
import { CARD_PATH, decodeCard, renderCardSvg } from "../modules/policy/card.js";

/**
 * `GET /summary-card/<token>.svg?theme=light|dark`: the review summary's status card. The token is
 * the signed card itself, so the route reads nothing and the image never changes for a URL.
 */
export const summaryCardRoutes =
  (deps: { key: Buffer }): FastifyPluginAsync =>
  async (app) => {
    // A wildcard, not `:file`: a named parameter is capped at 100 characters, a token is longer.
    app.get<{ Params: { "*": string }; Querystring: { theme?: string } }>(
      `${CARD_PATH}/*`,
      async (req, reply) => {
        const file = req.params["*"];
        const model = file.endsWith(".svg") ? decodeCard(file.slice(0, -4), deps.key) : null;
        if (model === null) return reply.code(404).send({ error: "not found" });
        const theme = req.query.theme === "dark" ? "dark" : "light";
        return reply
          .header("content-type", "image/svg+xml; charset=utf-8")
          .header("cache-control", "public, max-age=31536000, immutable")
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
          .send(renderCardSvg(model, theme));
      },
    );
  };
