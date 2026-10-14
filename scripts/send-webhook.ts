/**
 * Signs a fixture and POSTs it to the local server.
 * Usage: pnpm webhook:send <fixture> [--delivery <id>] [--url <url>]
 * Example: pnpm webhook:send installation.created --delivery smoke-1
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    delivery: { type: "string" },
    url: { type: "string" },
  },
});

const name = positionals[0];
if (!name) {
  console.error("usage: webhook:send <fixture> [--delivery <id>] [--url <url>]");
  process.exit(2);
}
const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is not set (copy .env.example to .env)");
  process.exit(2);
}

const body = readFileSync(
  new URL(`../test/fixtures/webhooks/${name.replace(/\.json$/, "")}.json`, import.meta.url),
  "utf8",
);
const event = name.split(".")[0] as string;
const url = values.url ?? `http://localhost:${process.env.PORT ?? "3000"}/webhooks/github`;
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": values.delivery ?? randomUUID(),
    "x-hub-signature-256": signature,
  },
  body,
});
console.log(res.status, await res.text());
