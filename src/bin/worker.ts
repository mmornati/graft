import { startWorker } from "../queue/worker.js";
import { bootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  const deps = await bootstrap({ supervise: true });
  await startWorker(deps.queue, deps.registry, deps, {
    concurrency: deps.config.workerConcurrency,
  });
  deps.log.info({ concurrency: deps.config.workerConcurrency }, "worker started");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    deps.log.info({ signal }, "shutting down");
    try {
      await deps.queue.stop(); // boss.stop({ graceful: true, timeout: 10000 })
      await deps.db.destroy();
      process.exit(0);
    } catch (err) {
      deps.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
