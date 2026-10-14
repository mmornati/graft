import * as changes from "../modules/changes/index.js";
import * as installations from "../modules/installations/index.js";
import * as provenance from "../modules/provenance/index.js";
import { createRegistry, type Registry } from "../webhooks/registry.js";

/** THE list of modules. Later steps add one line each here. */
export function buildAppRegistry(): Registry {
  const modules = [installations, changes, provenance];
  return createRegistry({
    webhookHandlers: modules.flatMap((m) => [...m.webhookHandlers]),
    jobs: modules.flatMap((m) => [...m.jobs]),
  });
}
