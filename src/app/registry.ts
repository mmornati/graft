import * as installations from "../modules/installations/index.js";
import { createRegistry, type Registry } from "../webhooks/registry.js";

/** THE list of modules. Later steps add one line each here. */
export function buildAppRegistry(): Registry {
  return createRegistry({
    webhookHandlers: [...installations.webhookHandlers],
    jobs: [...installations.jobs],
  });
}
