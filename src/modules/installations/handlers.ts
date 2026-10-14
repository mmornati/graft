import type { JobContext } from "../../core/context.js";
import { defineWebhookHandler } from "../../webhooks/handler.js";
import {
  type InstallationInput,
  markAllRepositoriesRemoved,
  markRepositoriesRemoved,
  type RepositoryInput,
  setInstallationDeleted,
  setInstallationSuspended,
  setRepositorySelection,
  upsertInstallation,
  upsertRepositories,
} from "./store.js";

/** The subset of installation payloads we read (both events share this shape). */
interface InstallationLike {
  id: number;
  account: {
    id: number;
    login?: string;
    slug?: string;
    type?: string;
  } | null;
  repository_selection: string;
}

interface RepoLike {
  id: number;
  full_name: string;
  private: boolean;
}

interface InstallationEventPayload {
  action: string;
  installation: InstallationLike;
  repositories?: RepoLike[];
  repositories_added?: RepoLike[];
  repositories_removed?: RepoLike[];
}

function toInstallation(i: InstallationLike): InstallationInput {
  if (!i.account) throw new Error("installation payload has no account");
  const type = i.account.type;
  return {
    id: i.id,
    accountId: i.account.id,
    accountLogin: i.account.login ?? i.account.slug ?? "",
    accountType: type === "Organization" || type === "Enterprise" ? type : "User",
    repositorySelection: i.repository_selection === "all" ? "all" : "selected",
  };
}

const toRepos = (rs: readonly RepoLike[] | undefined): RepositoryInput[] =>
  (rs ?? []).map((r) => ({ id: r.id, fullName: r.full_name, private: r.private }));

export const trackInstallations = defineWebhookHandler({
  name: "installations.track",
  on: ["installation", "installation_repositories"] as const,
  async handle(event, ctx: JobContext) {
    const payload = event.payload as unknown as InstallationEventPayload;
    const now = ctx.clock.now();
    const inst = toInstallation(payload.installation);

    await ctx.db.transaction().execute(async (tx) => {
      if (event.name === "installation") {
        switch (payload.action) {
          case "created":
            await upsertInstallation(tx, inst, now, { reactivate: true });
            await upsertRepositories(tx, inst.id, toRepos(payload.repositories), now);
            break;
          case "deleted":
            await upsertInstallation(tx, inst, now, { reactivate: false });
            await setInstallationDeleted(tx, inst.id, now);
            await markAllRepositoriesRemoved(tx, inst.id, now);
            break;
          case "suspend":
            await upsertInstallation(tx, inst, now, { reactivate: false });
            await setInstallationSuspended(tx, inst.id, now, now);
            break;
          case "unsuspend":
            await upsertInstallation(tx, inst, now, { reactivate: false });
            await setInstallationSuspended(tx, inst.id, null, now);
            break;
          case "new_permissions_accepted":
            await upsertInstallation(tx, inst, now, { reactivate: false });
            break;
          default:
            ctx.log.debug({ action: payload.action }, "installation action not tracked");
        }
        return;
      }

      // installation_repositories
      await upsertInstallation(tx, inst, now, { reactivate: false });
      if (payload.action === "added") {
        await upsertRepositories(tx, inst.id, toRepos(payload.repositories_added), now);
      } else if (payload.action === "removed") {
        const ids = (payload.repositories_removed ?? []).map((r) => r.id);
        await markRepositoriesRemoved(tx, inst.id, ids, now);
      }
      await setRepositorySelection(tx, inst.id, inst.repositorySelection, now);
    });
  },
});
