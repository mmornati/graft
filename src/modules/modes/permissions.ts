/**
 * `installations.refresh_permissions` (Phase 1 step 1, D5, T5): an installation's permissions
 * come from `GET /app/installations/{id}` with the App JWT, never from a webhook payload.
 */
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import { toJobError } from "../../github/errors.js";
import type { PermissionLevel } from "../../modes/index.js";
import { PermanentJobError } from "../../queue/errors.js";
import { defineJob } from "../../queue/job.js";

const REFRESH_STEP_SECONDS = 2;
const MAX_PERMISSIONS = 100;
const PERMISSION_NAME = /^[a-z_]{1,64}$/;
const LEVELS = new Set<string>(["read", "write", "admin"]);

export const REFRESH_PERMISSIONS_JOB = "installations.refresh_permissions";
export const REFRESH_ALL_PERMISSIONS_JOB = "installations.refresh_permissions_all";

export const refreshSchema = z.object({ installationId: z.number().int().positive() });
export type RefreshData = z.infer<typeof refreshSchema>;

/** Only known-shaped names with `read`, `write` or `admin`, at most 100 of them. */
export function sanitizePermissions(raw: unknown): Record<string, PermissionLevel> {
  const out: Record<string, PermissionLevel> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [name, level] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_PERMISSIONS) break;
    if (PERMISSION_NAME.test(name) && typeof level === "string" && LEVELS.has(level)) {
      out[name] = level as PermissionLevel;
    }
  }
  return out;
}

/**
 * `GET /app/installations/{id}` with the App JWT: the API's answer, never the webhook payload,
 * says what the installation may do. A 404 changes nothing (the installation handler deals with
 * deletion). Returns the stored permissions, or null when nothing was stored.
 */
export async function refreshPermissions(
  data: RefreshData,
  ctx: JobContext,
): Promise<Record<string, PermissionLevel> | null> {
  let permissions: Record<string, PermissionLevel>;
  try {
    const res = await ctx.github.asApp().rest.apps.getInstallation({
      installation_id: data.installationId,
    });
    permissions = sanitizePermissions(res.data.permissions);
  } catch (err) {
    const safe = toJobError(err, "apps.getInstallation");
    if (safe instanceof PermanentJobError && safe.reason === "not_found") {
      ctx.log.info({ installationId: data.installationId }, "installation_not_found");
      return null;
    }
    throw safe;
  }
  const now = ctx.clock.now();
  await ctx.db
    .updateTable("installations")
    .set({ permissions: JSON.stringify(permissions), permissions_read_at: now, updated_at: now })
    .where("id", "=", data.installationId)
    .execute();
  return permissions;
}

export const refreshPermissionsJob = defineJob<RefreshData>({
  name: REFRESH_PERMISSIONS_JOB,
  schema: refreshSchema,
  async handle(data, ctx) {
    const stored = await refreshPermissions(data, ctx);
    ctx.log.info(
      { installationId: data.installationId, stored: stored !== null },
      "permissions refresh done",
    );
  },
});

/** The daily cron's entry: one refresh per active installation, two seconds apart. */
export async function refreshAllPermissions(ctx: JobContext): Promise<number> {
  const rows = await ctx.db
    .selectFrom("installations")
    .select("id")
    .where("deleted_at", "is", null)
    .where("suspended_at", "is", null)
    .orderBy("id")
    .execute();
  const minute = Math.floor(ctx.clock.now().getTime() / 60_000);
  for (const [i, row] of rows.entries()) {
    await ctx.queue.send(
      refreshPermissionsJob,
      { installationId: row.id },
      {
        singletonKey: `permissions:${row.id}:${minute}`,
        startAfterSeconds: i * REFRESH_STEP_SECONDS,
      },
    );
  }
  return rows.length;
}

export const refreshAllPermissionsJob = defineJob<Record<string, never>>({
  name: REFRESH_ALL_PERMISSIONS_JOB,
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  options: { retryLimit: 1 },
  async handle(_data, ctx) {
    const count = await refreshAllPermissions(ctx);
    ctx.log.info({ count }, "permissions refresh fanout done");
  },
});
