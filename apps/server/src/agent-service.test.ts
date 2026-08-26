import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { CodifyService } from "./codify/service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new CodifyService(config, store),
  );
  await service.initialize();
  return service;
}

/** Same service, with the store handed back so a test can age its records. */
async function makeServiceWithStore(): Promise<{ service: AgentService; store: JsonStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
    new CodifyService(config, store),
  );
  await service.initialize();
  return { service, store };
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  /**
   * A promoted specialist is one Agent that everybody routes to. The Codex
   * session is already keyed by principal; the transcript must agree, or the
   * page shows one principal the conversation of another.
   */
  it("shows each principal only its own transcript on a shared Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Shared specialist" });

    const first = await service.sendMessage(agent.id, "alice private question", {
      userId: "user-a",
    });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const second = await service.sendMessage(agent.id, "bob private question", {
      userId: "user-b",
    });
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");

    const alice = service.getMessages(agent.id, "user-a");
    const bob = service.getMessages(agent.id, "user-b");

    expect(alice).toHaveLength(2);
    expect(bob).toHaveLength(2);
    // The negative case: neither principal's turn appears in the other's view,
    // in the prompt or in the reply that quotes it back.
    expect(alice.every((message) => !message.content.includes("bob"))).toBe(true);
    expect(bob.every((message) => !message.content.includes("alice"))).toBe(true);
    expect(alice.every((message) => message.userId === "user-a")).toBe(true);
    expect(bob.every((message) => message.userId === "user-b")).toBe(true);

    // An operator asking for no particular principal still sees the whole
    // Agent, which is what the governance views rely on.
    expect(service.getMessages(agent.id)).toHaveLength(4);
  });

  it("keeps pre-existing messages visible after userId was introduced", async () => {
    const { service, store } = await makeServiceWithStore();
    const agent = await service.createAgent({ name: "Legacy" });
    const { run } = await service.sendMessage(agent.id, "written before principals");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    // Age the records: a store written before the field existed carries none.
    await store.mutate((database) => {
      for (const message of database.messages) delete message.userId;
    });

    expect(service.getMessages(agent.id, "someone-new")).toHaveLength(2);
  });

  /**
   * The conversation is where the person typed; execution is wherever the
   * platform routed the work. Moving the reader to the specialist fragmented
   * their history and made a correction typed in the "wrong" place vanish.
   */
  it("files a delegated turn in the conversation it was typed into", async () => {
    const { service, store } = await makeServiceWithStore();
    const desk = await service.createAgent({ name: "General assistant" });
    const specialist = await service.createAgent({ name: "Specialist" });

    // Stand in for a promoted specialist without driving the whole promotion
    // path: the transcript behaviour under test is independent of it.
    const { run } = await service.sendMessage(desk.id, "do the thing", { userId: "user-a" });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await store.mutate((database) => {
      for (const message of database.messages) {
        if (message.role === "assistant") message.executedByAgentId = specialist.id;
      }
    });

    // Both turns are filed under the conversation, not the specialist.
    expect(service.getMessages(desk.id, "user-a")).toHaveLength(2);
    expect(service.getMessages(specialist.id, "user-a")).toHaveLength(0);
  });

  it("sends a follow-up to whoever answered last, not to the general Agent", async () => {
    const { service, store } = await makeServiceWithStore();
    const desk = await service.createAgent({ name: "General assistant" });
    const specialist = await service.createAgent({ name: "Specialist" });

    const first = await service.sendMessage(desk.id, "do the thing", { userId: "user-a" });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    await store.mutate((database) => {
      for (const message of database.messages) {
        if (message.role === "assistant") message.executedByAgentId = specialist.id;
      }
    });

    // A correction: short, refers to what was just produced, names no target.
    const second = await service.sendMessage(desk.id, "make it shorter", { userId: "user-a" });
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(service.getRun(second.run.id).agentId).toBe(specialist.id);

    // A self-contained request does not inherit the specialist.
    const third = await service.sendMessage(
      desk.id,
      "Audit the dependencies in ./repo and write findings to ./reports/audit.md",
      { userId: "user-a" },
    );
    await expect.poll(() => service.getRun(third.run.id).status).toBe("completed");
    expect(service.getRun(third.run.id).agentId).toBe(desk.id);
  });

  it("keeps one principal's continuity out of another's", async () => {
    const { service, store } = await makeServiceWithStore();
    const desk = await service.createAgent({ name: "General assistant" });
    const specialist = await service.createAgent({ name: "Specialist" });

    const first = await service.sendMessage(desk.id, "do the thing", { userId: "user-a" });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    await store.mutate((database) => {
      for (const message of database.messages) {
        if (message.role === "assistant") message.executedByAgentId = specialist.id;
      }
    });

    // user-b has no history here, so the same words start fresh on the desk.
    const other = await service.sendMessage(desk.id, "make it shorter", { userId: "user-b" });
    await expect.poll(() => service.getRun(other.run.id).status).toBe("completed");
    expect(service.getRun(other.run.id).agentId).toBe(desk.id);
  });

  /**
   * `flush` closes anything still open as an error, which is right for a crash
   * and wrong for the ordinary path. The root turn span was never closed on
   * success, so every completed Run carried a failed root: the timeline said
   * the Run had crashed while listing its own completion underneath.
   */
  it("traces a successful Run without marking its root span failed", async () => {
    const { service, store } = await makeServiceWithStore();
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "do the thing", { userId: "user-a" });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await expect
      .poll(() => store.snapshot().traceSpans.filter((span) => span.runId === run.id).length)
      .toBeGreaterThan(0);
    const spans = store.snapshot().traceSpans.filter((span) => span.runId === run.id);
    const root = spans.find((span) => span.name === "turn");

    expect(root).toBeDefined();
    expect(root?.status).toBe("ok");
    expect(root?.endedAt).toBeDefined();
    // Every span is closed. An `unmatched` route span is deliberately `error` —
    // routing failing open is worth flagging — so the assertion is about spans
    // being terminated, not about none of them carrying a status.
    expect(spans.every((span) => span.endedAt !== undefined)).toBe(true);
    expect(spans.find((span) => span.name === "completed")?.status).toBe("ok");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
