/**
 * Capture (`--capture`, §9.4; format only): every API exchange and every webhook delivery of the
 * run, redacted, as files an offline fixture builder could read later.
 */
import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { GitHubClient } from "../github/client-factory.js";
import { writeFileAtomic } from "../pilot/atomic-write.js";
import type { Exchange } from "./clients.js";
import { listDeliveries } from "./hooks.js";
import { REDACTION_RULES, type SecretRegistry } from "./secrets.js";

const KEEP_WEBHOOK_HEADERS = new Set([
  "x-github-event",
  "x-github-delivery",
  "x-github-hook-installation-target-id",
  "x-github-hook-installation-target-type",
]);

/** Emails and avatar fields become neutral values; everything else is kept. */
export function scrubJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "email" && typeof v === "string") out[k] = "user@example.invalid";
      else if ((k === "avatar_url" || k === "gravatar_id") && typeof v === "string") out[k] = "";
      else if (k === "token" && typeof v === "string" && "expires_at" in (value as object)) {
        out[k] = "[REDACTED]";
      } else out[k] = scrubJson(v);
    }
    return out;
  }
  return value;
}

const slug = (route: string): string =>
  route
    .replace(/[{}]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export interface CaptureInfo {
  runId: string;
  graftCommit: string;
  sandbox: string;
  appId: number;
  createdAt: string;
}

export class Capture {
  private seq = 0;
  private readonly seen = new Set<number>();
  private ready = false;

  constructor(
    readonly dir: string,
    private readonly secrets: SecretRegistry,
    private readonly info: CaptureInfo,
  ) {}

  private async mk(sub: string): Promise<string> {
    const d = path.join(this.dir, sub);
    await mkdir(d, { recursive: true, mode: 0o700 });
    await chmod(d, 0o700).catch(() => undefined);
    return d;
  }

  private async write(file: string, value: unknown): Promise<void> {
    const text = this.secrets.redact(JSON.stringify(scrubJson(value), null, 2));
    await writeFileAtomic(file, `${text}\n`);
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await this.mk(".");
    await this.write(path.join(this.dir, "manifest.json"), {
      captureVersion: 1,
      runId: this.info.runId,
      graftCommit: this.info.graftCommit,
      sandbox: this.info.sandbox,
      appId: this.info.appId,
      createdAt: this.info.createdAt,
      redactions: REDACTION_RULES,
    });
    this.ready = true;
  }

  private nextSeq(): string {
    this.seq += 1;
    return String(this.seq).padStart(6, "0");
  }

  private async index(entry: {
    file: string;
    kind: "api" | "webhook";
    scenario: string;
    seq: number;
  }) {
    await appendFile(path.join(this.dir, "index.jsonl"), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  }

  async api(ex: Exchange, scenario: string, at: string): Promise<void> {
    await this.init();
    const seqNum = this.seq + 1;
    const seq = this.nextSeq();
    const dir = await this.mk("api");
    const file = path.join(dir, `${seq}-${ex.method}-${slug(ex.route)}.json`);
    await this.write(file, {
      seq: seqNum,
      at,
      scenario,
      client: ex.client,
      method: ex.method,
      route: ex.route,
      path: ex.path,
      query: ex.query,
      status: ex.status,
      ...(ex.method !== "GET" ? { requestBody: ex.requestBody } : {}),
      responseHeaders: ex.responseHeaders,
      responseBody: ex.responseBody,
    });
    await this.index({ file: path.relative(this.dir, file), kind: "api", scenario, seq: seqNum });
  }

  /** The sandbox's deliveries since `since`, from GitHub's delivery log. */
  async webhooks(
    app: GitHubClient,
    o: { since: Date; scenario: string; installationId: number },
  ): Promise<number> {
    await this.init();
    const list = await listDeliveries(app, 2);
    let n = 0;
    for (const d of list) {
      if (this.seen.has(d.id)) continue;
      if (Date.parse(d.deliveredAt) < o.since.getTime()) continue;
      if (d.installationId !== null && d.installationId !== o.installationId) continue;
      const res = await app.rest.apps.getWebhookDelivery({ delivery_id: d.id });
      const data = res.data as {
        request?: { headers?: Record<string, string>; payload?: unknown };
        repository_id?: number | null;
      };
      const headers = Object.fromEntries(
        Object.entries(data.request?.headers ?? {}).filter(([k]) =>
          KEEP_WEBHOOK_HEADERS.has(k.toLowerCase()),
        ),
      );
      this.seen.add(d.id);
      const seqNum = this.seq + 1;
      const seq = this.nextSeq();
      const dir = await this.mk("webhooks");
      const file = path.join(dir, `${seq}-${d.event}.${d.action ?? "none"}.json`);
      await this.write(file, {
        seq: seqNum,
        guid: d.guid,
        event: d.event,
        action: d.action,
        installationId: d.installationId,
        repositoryId: data.repository_id ?? null,
        deliveredAt: d.deliveredAt,
        redelivery: d.redelivery,
        statusCode: d.statusCode,
        headers,
        payload: data.request?.payload,
      });
      await this.index({
        file: path.relative(this.dir, file),
        kind: "webhook",
        scenario: o.scenario,
        seq: seqNum,
      });
      n++;
    }
    return n;
  }
}
