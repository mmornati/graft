import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { AppServer } from "./server-type.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
  ".json": "application/json",
};

interface File {
  body: Buffer;
  type: string;
  etag: string;
}

export interface WebAssets {
  files: Map<string, File>;
  cssHref: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Reads the built web app once at start; the console never serves a path it did not build. */
export function loadWebAssets(dir: string): WebAssets {
  const files = new Map<string, File>();
  for (const p of walk(dir)) {
    const url = `/${relative(dir, p).split(sep).join("/")}`;
    const body = readFileSync(p);
    files.set(url, {
      body,
      type: TYPES[extname(p)] ?? "application/octet-stream",
      etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`,
    });
  }
  if (!files.has("/index.html")) throw new Error(`no web build in ${dir}: run pnpm build`);
  const manifest = JSON.parse(files.get("/manifest.json")?.body.toString("utf8") ?? "{}") as {
    css?: string;
  };
  return { files, cssHref: manifest.css ?? "/assets/app.css" };
}

export function registerStatic(app: AppServer, web: WebAssets): void {
  const send = (path: string) => web.files.get(path);
  app.get("/*", async (req, reply) => {
    const path = (req.url.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";
    const file = send(path) ?? (extname(path) === "" ? send("/index.html") : undefined);
    if (!file || path === "/manifest.json") {
      return reply.code(404).type("text/plain").send("Not found");
    }
    const hashed = path.startsWith("/assets/");
    reply
      .type(file.type)
      .header("etag", file.etag)
      .header("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
    if (req.headers["if-none-match"] === file.etag) return reply.code(304).send();
    return reply.send(file.body);
  });
}
