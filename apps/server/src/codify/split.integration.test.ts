/**
 * The split path, from a prompt to a running plan.
 *
 * `planSteps` is stubbed here because what needs testing is the wiring, not the
 * model: that a compound prompt becomes a plan-backed session, that a single
 * task does not, and that a step is never split again once it is a step. How
 * *well* the model splits is a separate, measured question — see
 * docs/SEMANTIC-ROUTING.md.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { AgentService } from "../agent-service.js";
import { canonicalize, fingerprint } from "./fingerprint.js";
import type { CapabilityScope, TaskContract } from "./types.js";
import { WorkspaceManager } from "../workspace.js";
import { CodifyService } from "./service.js";
import type { Agent, AgentRun } from "../types.js";
import type { AgentRunner, RunnerResult } from "../runner.js";

const planSteps = vi.hoisted(() => vi.fn());
vi.mock("./planner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./planner.js")>();
  return { ...actual, planSteps };
});

const directories: string[] = [];
afterEach(async () => {
  planSteps.mockReset();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );
});

const AGENT_GENERAL = "00000000-0000-4000-8000-000000000000";
const AGENT_SQL = "11111111-1111-4111-8111-111111111111";

const SQL_TASK =
  "Pull last month's signup numbers from the analytics warehouse and write them to ./out/signups.md";
const EMAIL_STEP =
  "Email the signups report at ./out/signups.md to the board with a short note on the month-over-month change";
const COMPOUND =
  SQL_TASK + ", then email it to the board with a short note on the month-over-month change";

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: path.join(tmpdir(), "ws", id),
  codexThreadId: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const scope: CapabilityScope = {
  paths: [{ path: "out", mode: "rw" }],
  domains: ["warehouse.internal"],
  secrets: [],
};

const contract = (): TaskContract => {
  const canonicalForm = canonicalize(SQL_TASK);
  return {
    id: "c-sql",
    version: 1,
    name: "Signups report",
    agentId: AGENT_SQL,
    matchFingerprints: [fingerprint(canonicalForm)],
    matchCanonicalForms: [canonicalForm],
    matchThreshold: 0.65,
    systemPrompt: "",
    refinements: [],
    scope,
    status: "active",
    createdBy: "operator",
    createdAt: new Date().toISOString(),
  };
};

/** A runner that completes instantly, so a turn settles without a container. */
class StubRunner implements AgentRunner {
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async run(): Promise<RunnerResult> {
    return { output: "done", threadId: null, usage: { inputTokens: 10, outputTokens: 5 } };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
}

/**
 * Wait for the session the split started in the background to settle.
 *
 * Driving it a second time would race the driver `splitIntoSession` already
 * launched, and two drivers on one session is exactly what `claimTurn` is there
 * to make harmless — but it makes for a confusing test.
 */
async function settleSession(service: AgentService, sessionId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const session = service.codify.getSession(sessionId);
    if (session.status !== "active") return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("session did not settle");
}

async function makeService() {
  const root = await mkdtemp(path.join(tmpdir(), "codify-split-"));
  directories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "ws"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "local-process",
    // The planner is off under test by default, for the same reason every other
    // model call is: the suite must never reach the network. This suite stubs
    // the call itself, so the switch can be on.
    CODIFY_PLANNER: "true",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.agents.push(agent(AGENT_GENERAL, "Playground"), agent(AGENT_SQL, "Signups report"));
    database.contracts.push(contract());
  });
  const workspaces = new WorkspaceManager(config.workspaceRoot);
  await workspaces.initialize();
  const service = new AgentService(
    config,
    store,
    workspaces,
    new StubRunner(),
    new CodifyService(config, store),
  );
  return { service, store, config };
}

describe("a compound prompt becomes a plan", () => {
  it("splits, and routes the recognised half to its specialist", async () => {
    planSteps.mockResolvedValue([
      { text: SQL_TASK, dependsOn: [] },
      { text: EMAIL_STEP, dependsOn: [0] },
    ]);
    const { service } = await makeService();
    const result = await service.sendMessage(AGENT_GENERAL, COMPOUND, { userId: "user-a" });

    expect(result.session).toBeDefined();
    expect(result.session?.plan).toHaveLength(2);
    // The first step is the one the contract recognised, so it runs on the
    // specialist rather than on the Agent the request was addressed to.
    expect(result.run.agentId).toBe(AGENT_SQL);
    const first = result.session?.turns.find((turn) => turn.stepIndex === 0);
    expect(first?.contractName).toBe("Signups report");
  });

  it("finishes the plan, sending the unrecognised half to the general Agent", async () => {
    planSteps.mockResolvedValue([
      { text: SQL_TASK, dependsOn: [] },
      { text: EMAIL_STEP, dependsOn: [0] },
    ]);
    const { service } = await makeService();
    const result = await service.sendMessage(AGENT_GENERAL, COMPOUND, { userId: "user-a" });
    const session = await settleSession(service, result.session!.id);

    expect(session.status).toBe("completed");
    expect(session.turns).toHaveLength(2);
    const second = session.turns.find((turn) => turn.stepIndex === 1);
    // Nothing governs "email the report" yet, so it runs where novel work runs.
    expect(second?.agentId).toBe(AGENT_GENERAL);
    expect(second?.contractId).toBeUndefined();
  });

  it("leaves an observation for the half nothing recognised", async () => {
    planSteps.mockResolvedValue([
      { text: SQL_TASK, dependsOn: [] },
      { text: EMAIL_STEP, dependsOn: [0] },
    ]);
    const { service, store } = await makeService();
    const result = await service.sendMessage(AGENT_GENERAL, COMPOUND, { userId: "user-a" });
    await settleSession(service, result.session!.id);

    // This is how the missing specialist eventually gets built: the leftover
    // fragment is observed as a task in its own right, so once enough people
    // ask for it, detection promotes it.
    const observed = store
      .snapshot()
      .promptObservations.map((observation) => observation.redactedText);
    // The step carries the earlier step's output as context, so what was
    // observed starts with the fragment rather than equalling it.
    expect(observed.some((text) => text.startsWith(EMAIL_STEP))).toBe(true);
  });

  it("does not split a request that asks for one thing", async () => {
    planSteps.mockResolvedValue([{ text: SQL_TASK, dependsOn: [] }]);
    const { service } = await makeService();
    const result = await service.sendMessage(AGENT_GENERAL, "something else entirely", {
      userId: "user-a",
    });
    expect(result.session).toBeUndefined();
  });

  it("does not split a step that is already a step", async () => {
    planSteps.mockResolvedValue([
      { text: SQL_TASK, dependsOn: [] },
      { text: EMAIL_STEP, dependsOn: [0] },
    ]);
    const { service } = await makeService();
    await service.sendMessage(AGENT_GENERAL, COMPOUND, { userId: "user-a" });
    const callsAfterFirstWave = planSteps.mock.calls.length;
    // One call for the compound prompt. If the fragments were re-planned, this
    // would climb with every step and could recurse without bound.
    expect(callsAfterFirstWave).toBe(1);
  });

  it("falls back to a single run when there is no specialist to split to", async () => {
    planSteps.mockResolvedValue([
      { text: SQL_TASK, dependsOn: [] },
      { text: EMAIL_STEP, dependsOn: [0] },
    ]);
    const { service, store } = await makeService();
    await store.mutate((database) => {
      database.contracts.length = 0;
    });
    const result = await service.sendMessage(AGENT_GENERAL, COMPOUND, { userId: "user-a" });
    // Splitting a request between one Agent and itself buys nothing.
    expect(result.session).toBeUndefined();
    expect(result.run.agentId).toBe(AGENT_GENERAL);
  });
});

describe("splitting only ever narrows", () => {
  it("runs each step under its own contract's scope, never the union", async () => {
    planSteps.mockResolvedValue([
      { text: SQL_TASK, dependsOn: [] },
      { text: EMAIL_STEP, dependsOn: [0] },
    ]);
    const { service, store } = await makeService();
    const result = await service.sendMessage(AGENT_GENERAL, COMPOUND, { userId: "user-a" });
    await settleSession(service, result.session!.id);

    const runs: AgentRun[] = store.snapshot().runs;
    const governed = runs.filter((run) => run.codify?.contractId);
    // Exactly one step was recognised, so exactly one run is governed by a
    // contract — and it is the specialist's.
    expect(governed).toHaveLength(1);
    expect(governed[0]?.agentId).toBe(AGENT_SQL);
  });
});
