import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { seedObservations } from "./codify/seed.js";
import { CodifyService } from "./codify/service.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const codify = new CodifyService(config, store);
const service = new AgentService(config, store, workspaces, runner, codify);
await service.initialize();

// Detection needs history. On an empty store, seed a corpus of observed runs so
// the review queue is populated at t=0 and the flow is reproducible.
if (config.codifyEnabled && config.codifySeedFixtures) {
  const seed = await seedObservations(store);
  if (seed.seeded) {
    const candidates = await codify.refreshCandidates();
    console.error(
      "[codify] Seeded " +
        seed.promptObservations +
        " observed runs; " +
        candidates.length +
        " task candidates awaiting review.",
    );
  }
}

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
