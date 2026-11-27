import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import type { AppDeps } from "../core/context.js";
import {
  archiveBillingTeam,
  BillingStatementError,
  BillingTeamError,
  createBillingAdjustment,
  createBillingTeam,
  getBillingStatement,
  listBillingTeams,
  renameBillingTeam,
  setBillingTeamRepository,
} from "../modules/billing/index.js";
import { upsertRepositories } from "../modules/installations/store.js";
import { sanitizeError } from "../queue/errors.js";

const login = z.string().regex(/^[A-Za-z0-9-]{1,39}$/);
const userSchema = z.object({ login, id: z.number().int().positive().safe() });
const repositoryName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/);
type User = z.infer<typeof userSchema>;

class ConsoleError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof err.status === "number"
    ? err.status
    : undefined;
}

export const consoleRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const secret = deps.config.consoleSecret;
    if (!secret) return;
    app.addHook("onRequest", async (req, reply) => {
      // This is a server-to-server API, never a browser endpoint.
      if (req.headers.origin) return reply.code(403).send({ error: "browser access refused" });
    });
    app.addHook("preValidation", async (req, reply) => {
      const timestamp = req.headers["x-graft-console-time"];
      const signature = req.headers["x-graft-console-signature"];
      if (
        typeof timestamp !== "string" ||
        !/^\d{13}$/.test(timestamp) ||
        typeof signature !== "string" ||
        !/^[a-f0-9]{64}$/.test(signature) ||
        Math.abs(deps.clock.now().getTime() - Number(timestamp)) > 30_000
      ) {
        return reply.code(401).send({ error: "invalid console authentication" });
      }
      const expected = createHmac("sha256", secret)
        .update(`${timestamp}\n${req.method}\n${req.url}\n${JSON.stringify(req.body)}`)
        .digest("hex");
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return reply.code(401).send({ error: "invalid console authentication" });
      }
    });
    app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
      if (err instanceof ConsoleError)
        return reply.code(err.statusCode).send({ message: err.message });
      if (err instanceof BillingTeamError || err instanceof BillingStatementError)
        return reply.code(err.statusCode).send({ message: err.message });
      if (err instanceof z.ZodError)
        return reply.code(400).send({ message: "Invalid console request." });
      req.log.error({ err: sanitizeError(err) }, "console administration failed");
      return reply
        .code(503)
        .send({ message: "Graft could not verify access or update the repository. Try again." });
    });

    const installations = async () => {
      let query = deps.db
        .selectFrom("installations")
        .select(["id", "account_login", "account_type"])
        .where("deleted_at", "is", null)
        .where("suspended_at", "is", null);
      if (deps.config.allowedAccounts.length) {
        query = query.where(sql<string>`lower(account_login)`, "in", [
          ...deps.config.allowedAccounts,
        ]);
      }
      return query.orderBy("account_login").execute();
    };
    const verifyIdentity = async (user: User) => {
      const first = (await installations())[0];
      const gh = first ? await deps.github.forInstallation(Number(first.id)) : deps.github.asApp();
      const { data } = await gh.request("GET /users/{username}", { username: user.login });
      if (data.id !== user.id)
        throw new ConsoleError(403, "Your GitHub identity changed. Sign in again.");
    };
    const permissionCache = new Map<string, { canAdmin: boolean; expiresAt: number }>();
    const canAdmin = async (
      installationId: number,
      fullName: string,
      user: User,
      useCache = true,
    ) => {
      const cacheKey = `${installationId}:${user.id}:${fullName.toLowerCase()}`;
      const cached = permissionCache.get(cacheKey);
      if (useCache && cached && cached.expiresAt > deps.clock.now().getTime())
        return cached.canAdmin;
      if (!useCache) permissionCache.delete(cacheKey);
      const [owner = "", repo = ""] = fullName.split("/");
      const gh = await deps.github.forInstallation(installationId);
      try {
        const { data } = await gh.request(
          "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
          { owner, repo, username: user.login },
        );
        const allowed = data.user?.id === user.id && data.permission === "admin";
        if (useCache)
          permissionCache.set(cacheKey, {
            canAdmin: allowed,
            expiresAt: deps.clock.now().getTime() + 30_000,
          });
        return allowed;
      } catch (err) {
        if (statusOf(err) === 404) {
          if (useCache)
            permissionCache.set(cacheKey, {
              canAdmin: false,
              expiresAt: deps.clock.now().getTime() + 30_000,
            });
          return false;
        }
        throw err;
      }
    };
    const mapBounded = async <T, R>(
      values: readonly T[],
      concurrency: number,
      fn: (value: T) => Promise<R>,
    ): Promise<R[]> => {
      const result = new Array<R>(values.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, async () => {
          while (next < values.length) {
            const index = next++;
            const value = values[index];
            if (value === undefined) continue;
            result[index] = await fn(value);
          }
        }),
      );
      return result;
    };
    const resolveRepository = async (fullName: string) => {
      const [owner = "", repo = ""] = fullName.split("/");
      let installationId: number;
      try {
        const { data } = await deps.github
          .asApp()
          .request("GET /repos/{owner}/{repo}/installation", { owner, repo });
        installationId = data.id;
      } catch (err) {
        if (statusOf(err) === 404)
          throw new ConsoleError(404, "Graft is not installed on that repository.");
        throw err;
      }
      const inst = (await installations()).find((i) => Number(i.id) === installationId);
      if (!inst)
        throw new ConsoleError(
          403,
          "That installation is inactive or outside Graft's allowed accounts.",
        );
      const gh = await deps.github.forInstallation(installationId);
      const { data } = await gh.request("GET /repos/{owner}/{repo}", { owner, repo });
      if (data.owner.login.toLowerCase() !== inst.account_login.toLowerCase()) {
        throw new ConsoleError(409, "The repository moved. Refresh and try again.");
      }
      return { installationId, repository: data };
    };

    app.post("/internal/console/access", async (req) => {
      const { user, organizations } = z
        .object({
          user: userSchema,
          organizations: z.array(login).max(100),
        })
        .parse(req.body);
      await verifyIdentity(user);
      const allowed = new Set(organizations.map((o) => o.toLowerCase()));
      for (const inst of await installations()) {
        if (inst.account_type !== "Organization" || !allowed.has(inst.account_login.toLowerCase()))
          continue;
        const gh = await deps.github.forInstallation(Number(inst.id));
        try {
          const { data } = await gh.request("GET /orgs/{org}/memberships/{username}", {
            org: inst.account_login,
            username: user.login,
          });
          if (data.state === "active") return { allowed: true };
        } catch (err) {
          if (statusOf(err) !== 404) throw err;
        }
      }
      return { allowed: false };
    });

    app.post("/internal/console/repositories", async (req) => {
      const { user, after } = z
        .object({
          user: userSchema,
          after: z.number().int().nonnegative().safe().default(0),
        })
        .parse(req.body);
      await verifyIdentity(user);
      const accounts = await installations();
      const ids = accounts.map((i) => Number(i.id));
      const rows = ids.length
        ? await deps.db
            .selectFrom("enabled_repositories as e")
            .innerJoin("repositories as r", "r.id", "e.repository_id")
            .select(["r.id", "r.full_name", "e.enabled_by", "e.created_at", "r.installation_id"])
            .where("r.installation_id", "in", ids)
            .whereRef("e.installation_id", "=", "r.installation_id")
            .where("r.removed_at", "is", null)
            .where("r.id", ">", after)
            .orderBy("r.id")
            .limit(26)
            .execute()
        : [];
      const page = rows.slice(0, 25);
      const repositories = await Promise.all(
        page.map(async (r) => ({
          id: Number(r.id),
          fullName: r.full_name,
          enabledBy: r.enabled_by,
          enabledAt: r.created_at.toISOString(),
          canAdmin: await canAdmin(Number(r.installation_id), r.full_name, user),
        })),
      );
      return {
        filtering: deps.config.repositoryFilter,
        repositories,
        accounts: accounts.map((i) => i.account_login),
        next: rows.length > 25 ? Number(page.at(-1)?.id) : null,
      };
    });

    app.post("/internal/console/search", async (req) => {
      const { user, account, query, page } = z
        .object({
          user: userSchema,
          account: login,
          query: z.string().regex(/^[A-Za-z0-9_.-]{2,100}$/),
          page: z.number().int().min(1).max(100).default(1),
        })
        .parse(req.body);
      await verifyIdentity(user);
      const inst = (await installations()).find(
        (i) => i.account_login.toLowerCase() === account.toLowerCase(),
      );
      if (!inst) throw new ConsoleError(403, "Choose an active Graft installation.");
      const gh = await deps.github.forInstallation(Number(inst.id));
      const { data } = await gh.request("GET /search/repositories", {
        q: `${query} in:name user:${inst.account_login} fork:true`,
        per_page: 10,
        page,
      });
      const repositories = (
        await Promise.all(
          data.items.map(async (r) => {
            // Installation tokens can see public repositories outside their selection too.
            try {
              const resolved = await resolveRepository(r.full_name);
              if (resolved.installationId !== Number(inst.id)) return null;
              const enabled = await deps.db
                .selectFrom("enabled_repositories")
                .select("repository_id")
                .where("repository_id", "=", r.id)
                .where("installation_id", "=", resolved.installationId)
                .executeTakeFirst();
              return {
                id: r.id,
                fullName: r.full_name,
                enabled: Boolean(enabled),
                canAdmin: await canAdmin(resolved.installationId, r.full_name, user),
              };
            } catch (err) {
              if (err instanceof ConsoleError && err.statusCode === 404) return null;
              throw err;
            }
          }),
        )
      ).filter((r) => r !== null);
      return {
        repositories,
        incomplete: data.incomplete_results,
        next: page * 10 < Math.min(data.total_count, 1000) ? page + 1 : null,
      };
    });

    app.post("/internal/console/activation", async (req) => {
      const { user, repository, enabled, confirmation } = z
        .object({
          user: userSchema,
          repository: repositoryName,
          enabled: z.boolean(),
          confirmation: z.string().optional(),
        })
        .parse(req.body);
      if (!enabled && confirmation !== repository) {
        throw new ConsoleError(400, "Confirm the repository name before disabling it.");
      }
      await verifyIdentity(user);
      const resolved = await resolveRepository(repository);
      const repo = resolved.repository;
      const repositoryId = Number(repo.id);
      if (!Number.isSafeInteger(repositoryId))
        throw new ConsoleError(502, "GitHub returned an unsupported repository id.");
      if (!(await canAdmin(resolved.installationId, repo.full_name, user, false))) {
        throw new ConsoleError(403, "Only a repository administrator can change Graft activation.");
      }
      await deps.db.transaction().execute(async (tx) => {
        const inst = await tx
          .selectFrom("installations")
          .select("id")
          .where("id", "=", resolved.installationId)
          .where("deleted_at", "is", null)
          .where("suspended_at", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (!inst)
          throw new ConsoleError(409, "The installation became inactive. Refresh and try again.");
        const existing = await tx
          .selectFrom("repositories")
          .select(["installation_id", "removed_at"])
          .where("id", "=", repositoryId)
          .forUpdate()
          .executeTakeFirst();
        if (
          existing &&
          (Number(existing.installation_id) !== resolved.installationId || existing.removed_at)
        ) {
          throw new ConsoleError(
            409,
            "The repository installation changed. Wait for Graft to synchronize.",
          );
        }
        await upsertRepositories(
          tx,
          resolved.installationId,
          [{ id: repositoryId, fullName: repo.full_name, private: repo.private }],
          deps.clock.now(),
        );
        const changed = enabled
          ? await tx
              .insertInto("enabled_repositories")
              .values({
                repository_id: repositoryId,
                installation_id: resolved.installationId,
                enabled_by: user.login,
                enabled_by_id: user.id,
                created_at: deps.clock.now(),
              })
              .onConflict((oc) => oc.column("repository_id").doNothing())
              .returning("repository_id")
              .executeTakeFirst()
          : await tx
              .deleteFrom("enabled_repositories")
              .where("repository_id", "=", repositoryId)
              .returning("repository_id")
              .executeTakeFirst();
        if (changed) {
          await tx
            .insertInto("repository_filter_changes")
            .values({
              repository_id: repositoryId,
              action: enabled ? "enabled" : "disabled",
              actor: user.login,
              actor_id: user.id,
              created_at: deps.clock.now(),
            })
            .execute();
        }
      });
      deps.log.info(
        { repositoryId: repo.id, actorId: user.id, enabled },
        "repository activation updated",
      );
      return { enabled, filtering: deps.config.repositoryFilter };
    });

    app.post("/internal/console/billing/teams", async (req) => {
      const { user } = z.object({ user: userSchema }).parse(req.body);
      await verifyIdentity(user);
      return listBillingTeams(deps.db);
    });

    app.post("/internal/console/billing/repositories", async (req) => {
      const { user, after } = z
        .object({
          user: userSchema,
          after: z.number().int().nonnegative().safe().default(0),
        })
        .parse(req.body);
      await verifyIdentity(user);
      const activeInstallationIds = (await installations()).map((inst) => Number(inst.id));
      if (!activeInstallationIds.length) return { after, repositories: [], next: null };
      const rows = await deps.db
        .selectFrom("repositories")
        .select(["id", "full_name", "installation_id"])
        .where("installation_id", "in", activeInstallationIds)
        .where("removed_at", "is", null)
        .where("id", ">", after)
        .orderBy("id")
        .limit(50)
        .execute();
      const repositories = await mapBounded(rows, 5, async (repo) => ({
        id: Number(repo.id),
        fullName: repo.full_name,
        canAdmin: await canAdmin(Number(repo.installation_id), repo.full_name, user),
      }));
      const last = rows.at(-1);
      return {
        after,
        repositories,
        next: rows.length === 50 && last ? Number(last.id) : null,
      };
    });

    app.post("/internal/console/billing/statement", async (req) => {
      const { user, month } = z
        .object({ user: userSchema, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
        .parse(req.body);
      await verifyIdentity(user);
      return getBillingStatement(deps.db, month);
    });

    app.post("/internal/console/billing/create", async (req) => {
      const { user, name } = z
        .object({ user: userSchema, name: z.string().min(1).max(100) })
        .parse(req.body);
      await verifyIdentity(user);
      return createBillingTeam(deps.db, { name, actor: user.login, now: deps.clock.now() });
    });

    app.post("/internal/console/billing/rename", async (req) => {
      const { user, id, name } = z
        .object({ user: userSchema, id: z.uuid(), name: z.string().min(1).max(100) })
        .parse(req.body);
      await verifyIdentity(user);
      await renameBillingTeam(deps.db, { id, name });
      return { ok: true };
    });

    app.post("/internal/console/billing/archive", async (req) => {
      const { user, id } = z.object({ user: userSchema, id: z.uuid() }).parse(req.body);
      await verifyIdentity(user);
      await archiveBillingTeam(deps.db, { id, now: deps.clock.now() });
      return { ok: true };
    });

    app.post("/internal/console/billing/repository", async (req) => {
      const { user, teamId, repositoryId, attached } = z
        .object({
          user: userSchema,
          teamId: z.uuid(),
          repositoryId: z.number().int().positive().safe(),
          attached: z.boolean(),
        })
        .parse(req.body);
      await verifyIdentity(user);
      const repo = await deps.db
        .selectFrom("repositories")
        .select(["full_name", "installation_id"])
        .where("id", "=", repositoryId)
        .where("removed_at", "is", null)
        .executeTakeFirst();
      if (!repo) throw new ConsoleError(404, "Active Graft repository not found.");
      if (
        !(await installations()).some(
          (installation) => Number(installation.id) === Number(repo.installation_id),
        )
      ) {
        throw new ConsoleError(403, "That repository's installation is inactive or not allowed.");
      }
      if (!(await canAdmin(Number(repo.installation_id), repo.full_name, user, false))) {
        throw new ConsoleError(
          403,
          "Only a repository administrator can change billing membership.",
        );
      }
      await setBillingTeamRepository(deps.db, {
        teamId,
        repositoryId,
        actor: user.login,
        now: deps.clock.now(),
        attached,
      });
      return { ok: true };
    });

    app.post("/internal/console/billing/adjustment", async (req) => {
      const { user, sourcePeriod, sourceLineId, operationId, amountUsd, reason } = z
        .object({
          user: userSchema,
          sourcePeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
          sourceLineId: z.uuid(),
          operationId: z.uuid(),
          amountUsd: z.string().regex(/^-?\d{1,12}(?:\.\d{1,2})?$/),
          reason: z.string().min(1).max(500),
        })
        .parse(req.body);
      await verifyIdentity(user);
      return createBillingAdjustment(deps.db, {
        sourcePeriod,
        sourceLineId,
        operationId,
        amountUsd,
        reason,
        actor: user.login,
        now: deps.clock.now(),
      });
    });
  };
