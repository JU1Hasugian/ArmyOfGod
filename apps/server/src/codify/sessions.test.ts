/**
 * Session isolation on a shared specialist.
 *
 * A promoted specialist is one Agent that everybody routed to it executes on.
 * That was one Codex thread for all of them, and the consequence was measured
 * on the running platform rather than imagined: a specialist carrying 26 turns
 * on a single thread answered "Done, `./out/RELEASE.md` has the release notes"
 * and produced no file, while the same task under the same scope on a fresh
 * thread ran correctly. It was answering from the memory of having done it.
 *
 * `resumeThread` is not exported — it is an implementation detail of the run
 * path — so these tests exercise the rule through the shape it produces on the
 * Agent record, which is the thing that has to stay correct.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { AgentService } from "../agent-service.js";
import { WorkspaceManager } from "../workspace.js";
import { CodifyService } from "./service.js";
import type { Agent, AgentRunner, RunnerRequest, RunnerResult } from "../types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

/** Records the threadId each run was handed, and mints a new one per run. */
class RecordingRunner implements AgentRunner {
  readonly seen: (string | null)[] = [];
  private counter = 0;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.seen.push(request.threadId ?? null);
    this.counter += 1;
    return {
      output: "done",
      threadId: "thread-" + this.counter,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
}

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "codify-session-"));
  directories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "ws"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "local-process",
    CODIFY_SEED_FIXTURES: "false",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  const runner = new RecordingRunner();
  const workspaces = new WorkspaceManager(config.workspaceRoot);
  await workspaces.initialize();
  const codify = new CodifyService(config, store);
  const service = new AgentService(config, store, workspaces, runner, codify);
  return { service, store, runner };
}

/** Wait for the asynchronous run to settle. */
async function settle(service: AgentService, runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = service.getRun(runId);
    if (run.status === "completed" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not settle");
}

describe("one specialist, many people", () => {
  it("gives each principal their own thread", async () => {
    const { service, runner } = await harness();
    const agent = await service.createAgent({ name: "Shared specialist" });

    const first = await service.sendMessage(agent.id, "do the thing", { userId: "ana" });
    await settle(service, first.run.id);
    const second = await service.sendMessage(agent.id, "and again", { userId: "ana" });
    await settle(service, second.run.id);
    // Ana's second turn continues Ana's conversation.
    expect(runner.seen[1]).toBe("thread-1");

    const other = await service.sendMessage(agent.id, "my own question", { userId: "ben" });
    await settle(service, other.run.id);
    // Ben starts his own rather than resuming Ana's.
    expect(runner.seen[2]).toBeNull();

    const stored = service.getAgent(agent.id);
    expect(stored.codexThreads?.ana).toBeDefined();
    expect(stored.codexThreads?.ben).toBeDefined();
    expect(stored.codexThreads?.ana).not.toBe(stored.codexThreads?.ben);
  });

  it("does not leak one principal's thread to another", async () => {
    const { service, runner } = await harness();
    const agent = await service.createAgent({ name: "Shared specialist" });
    for (const userId of ["ana", "ben", "cass"]) {
      const sent = await service.sendMessage(agent.id, "hello", { userId });
      await settle(service, sent.run.id);
    }
    // Three principals, three cold starts: nobody resumed anybody.
    expect(runner.seen).toEqual([null, null, null]);
  });

  it("adopts a pre-existing shared thread once, for whoever arrives first", async () => {
    const { service, store, runner } = await harness();
    const agent = await service.createAgent({ name: "Legacy" });
    // A store written before threads were per-principal.
    await store.mutate((database) => {
      const stored = database.agents.find((entry) => entry.id === agent.id) as Agent;
      stored.codexThreadId = "legacy-thread";
      delete stored.codexThreads;
    });

    const first = await service.sendMessage(agent.id, "continue please", { userId: "ana" });
    await settle(service, first.run.id);
    // The existing conversation is honoured rather than discarded...
    expect(runner.seen[0]).toBe("legacy-thread");

    const other = await service.sendMessage(agent.id, "hello", { userId: "ben" });
    await settle(service, other.run.id);
    // ...and it does not become everybody's.
    expect(runner.seen[1]).toBeNull();
  });
});
