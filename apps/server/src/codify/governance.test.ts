/**
 * The three mechanisms added after the router review: scope bound to the
 * principal, cost bounded by a budget, and a Run readable as one trace.
 *
 * Each is tested against the behaviour it is supposed to replace, because the
 * point of all three is that the platform used to do something worse and it is
 * easy to regress to.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { Agent, AgentRun } from "../types.js";
import { CodifyService } from "./service.js";
import {
  checkBudget,
  contractLineage,
  normalizeBudget,
  runTokens,
  usageForContract,
} from "./budget.js";
import { RunTracer, traceForRun } from "./trace.js";
import type { PromptObservation, TaskContract } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );
});

const SPECIALIST_ID = "11111111-1111-4111-8111-111111111111";
const PROMPT =
  "Generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/RELEASE.md";

async function makeService() {
  const root = await mkdtemp(path.join(tmpdir(), "codify-gov-"));
  directories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  return { service: new CodifyService(config, store), store, config };
}

const fakeAgent = async (input: { name: string }): Promise<Agent> => ({
  id: SPECIALIST_ID,
  name: input.name,
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: "/tmp/workspaces/agent",
  codexThreadId: null,
  lastError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

type Context = Awaited<ReturnType<typeof makeService>>;

async function seedRun(
  { service, store }: Context,
  options: { userId: string; index: number },
): Promise<PromptObservation> {
  const runId = "00000000-0000-4000-8000-" + String(options.index).padStart(12, "0");
  const observation = await service.recordPromptObservation({
    runId,
    agentId: "agent-adhoc",
    userId: options.userId,
    redactedText: PROMPT,
    redactionHits: [],
    promotionEligible: true,
  });
  await store.mutate((database) => {
    database.capabilityObservations.push({
      runId,
      agentId: "agent-adhoc",
      domainsReached: ["github.com"],
      pathsRead: ["repo/CHANGELOG.md"],
      pathsWritten: ["out/RELEASE.md"],
      secretsRead: ["GITHUB_TOKEN"],
      createdAt: new Date().toISOString(),
    });
  });
  return observation;
}

async function withContract(): Promise<{ context: Context; contract: TaskContract }> {
  const context = await makeService();
  for (const [index, userId] of ["user-a", "user-b", "user-c", "user-a", "user-b"].entries()) {
    await seedRun(context, { userId, index });
  }
  const [candidate] = await context.service.refreshCandidates();
  const { contract } = await context.service.approveCandidate(
    candidate!.id,
    { userId: "operator" },
    fakeAgent,
  );
  return { context, contract };
}

async function observe(context: Context, text: string, suffix: number) {
  return context.service.recordPromptObservation({
    runId: "00000000-0000-4000-8000-" + String(700 + suffix).padStart(12, "0"),
    agentId: "agent-x",
    userId: "user-z",
    redactedText: text,
    redactionHits: [],
    promotionEligible: true,
  });
}

// ---------------------------------------------------------------- principal

describe("scope bound to the principal, not the prompt", () => {
  /** A prompt that shares nothing with the contract: the matcher must miss it. */
  const UNRELATED = "Book a meeting room for Thursday afternoon and invite the team";

  it("still enforces the specialist's scope when nothing matches", async () => {
    const { context, contract } = await withContract();
    const observation = await observe(context, UNRELATED, 1);

    const result = context.service.route({
      runId: "00000000-0000-4000-8000-000000000901",
      agentId: SPECIALIST_ID,
      observation,
      forceAdHoc: false,
    });

    // The old behaviour: unmatched, observe mode, full capability. That is the
    // hole this closes, so assert the new outcome exactly.
    expect(result.decision.decision).toBe("principal_bound");
    expect(result.decision.brokerMode).toBe("enforce");
    expect(result.binding?.scope).toEqual(contract.scope);
    expect(result.decision.contractId).toBe(contract.id);
  });

  it("does not delegate or apply a brief on a principal-bound turn", async () => {
    const { context } = await withContract();
    const observation = await observe(context, UNRELATED, 2);
    const result = context.service.route({
      runId: "00000000-0000-4000-8000-000000000902",
      agentId: SPECIALIST_ID,
      observation,
      forceAdHoc: false,
    });
    // The turn was not recognised as the task, so pretending it was would be
    // worse than useless. It gets the capability envelope and nothing else.
    expect(result.delegateToAgentId).toBeUndefined();
  });

  it("records how close the prompt came, so the miss is diagnosable", async () => {
    const { context } = await withContract();
    const observation = await observe(context, UNRELATED, 3);
    const result = context.service.route({
      runId: "00000000-0000-4000-8000-000000000903",
      agentId: SPECIALIST_ID,
      observation,
      forceAdHoc: false,
    });
    expect(result.decision.matchScores).toBeDefined();
    expect(result.decision.matchScores?.fingerprint).toBeLessThan(0.65);
  });

  it("refuses to let an ad-hoc request lift a specialist's scope", async () => {
    const { context, contract } = await withContract();
    const observation = await observe(context, UNRELATED, 4);
    const result = context.service.route({
      runId: "00000000-0000-4000-8000-000000000904",
      agentId: SPECIALIST_ID,
      observation,
      // A request flag must never be able to switch enforcement off, or the
      // whole story is opt-out.
      forceAdHoc: true,
    });
    expect(result.decision.decision).toBe("principal_bound");
    expect(result.binding?.scope).toEqual(contract.scope);
  });

  it("leaves a generic Agent failing open, which is the usability half", async () => {
    const { context } = await withContract();
    const observation = await observe(context, UNRELATED, 5);
    const result = context.service.route({
      runId: "00000000-0000-4000-8000-000000000905",
      agentId: "some-generic-agent",
      observation,
      forceAdHoc: false,
    });
    // A generic Agent has no contract of its own, so there is no scope to bind
    // and the Playground keeps working while the platform is still learning.
    expect(result.decision.decision).toBe("unmatched");
    expect(result.decision.brokerMode).toBe("observe");
  });

  it("prefers a real match over the principal binding", async () => {
    const { context, contract } = await withContract();
    const observation = await observe(
      context,
      "Please generate release notes from the commits in ./repo since v9.9.9 and write them to ./out/NOTES.md",
      6,
    );
    const result = context.service.route({
      runId: "00000000-0000-4000-8000-000000000906",
      agentId: SPECIALIST_ID,
      observation,
      forceAdHoc: false,
    });
    expect(result.decision.decision).toBe("routed");
    expect(result.decision.contractId).toBe(contract.id);
  });
});

// ------------------------------------------------------------------- budget

describe("budget", () => {
  const run = (contractId: string, input: number, output: number): AgentRun =>
    ({
      id: "run-" + Math.random().toString(36).slice(2),
      agentId: SPECIALIST_ID,
      status: "completed",
      prompt: "",
      output: "",
      error: null,
      usage: { inputTokens: input, outputTokens: output },
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
      codify: {
        decision: "routed",
        brokerMode: "enforce",
        contractId,
        denials: 0,
        domainsReached: [],
      },
    }) as AgentRun;

  it("counts input and output but never double-counts the cached part", () => {
    const entry = run("c1", 1_000, 200);
    entry.usage = { inputTokens: 1_000, cachedInputTokens: 900, outputTokens: 200 };
    // cachedInputTokens is a subset of inputTokens, not an addition to it.
    expect(runTokens(entry)).toBe(1_200);
  });

  it("treats a missing usage record as zero rather than as an error", () => {
    const entry = run("c1", 0, 0);
    entry.usage = null;
    expect(runTokens(entry)).toBe(0);
  });

  it("allows everything when a contract carries no budget", () => {
    const contract = { id: "c1", budget: undefined } as TaskContract;
    const decision = checkBudget(contract, [contract], [run("c1", 10_000, 5_000)]);
    expect(decision.allowed).toBe(true);
    expect(decision.usage.totalTokens).toBe(15_000);
  });

  it("refuses the next run once the token ceiling is reached", () => {
    const contract = { id: "c1", budget: { maxTotalTokens: 10_000 } } as TaskContract;
    const under = checkBudget(contract, [contract], [run("c1", 4_000, 1_000)]);
    expect(under.allowed).toBe(true);
    const over = checkBudget(
      contract,
      [contract],
      [run("c1", 4_000, 1_000), run("c1", 4_000, 1_500)],
    );
    expect(over.allowed).toBe(false);
    // A refusal an operator can act on names the limit and the observed value.
    expect(over.reason).toContain("10,000");
    expect(over.reason).toContain("10,500");
  });

  it("refuses once the run ceiling is reached", () => {
    const contract = { id: "c1", budget: { maxRuns: 2 } } as TaskContract;
    expect(checkBudget(contract, [contract], [run("c1", 1, 1)]).allowed).toBe(true);
    expect(
      checkBudget(contract, [contract], [run("c1", 1, 1), run("c1", 1, 1)]).allowed,
    ).toBe(false);
  });

  it("refuses after a single run overshoots the per-run ceiling", () => {
    const contract = { id: "c1", budget: { maxTokensPerRun: 1_000 } } as TaskContract;
    // The overshooting run itself completed — admission is the only boundary
    // the control plane owns. What it buys is that the next one does not start.
    const decision = checkBudget(contract, [contract], [run("c1", 4_000, 100)]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("4,100");
  });

  it("ignores runs governed by an unrelated contract", () => {
    const contract = { id: "c1", budget: { maxTotalTokens: 1_000 } } as TaskContract;
    const other = { id: "c2" } as TaskContract;
    const decision = checkBudget(contract, [contract, other], [run("c2", 50_000, 50_000)]);
    expect(decision.allowed).toBe(true);
    expect(decision.usage.totalTokens).toBe(0);
  });

  it("follows the whole version lineage, so narrowing a scope cannot reset spend", () => {
    // v1 spent the budget; revoking a domain supersedes it with v2. If the
    // budget followed the version rather than the task, narrowing a scope would
    // be the cheapest way to buy more budget.
    const v1 = { id: "c1", budget: { maxTotalTokens: 1_000 } } as TaskContract;
    const v2 = { id: "c2", supersedes: "c1", budget: { maxTotalTokens: 1_000 } } as TaskContract;
    expect(contractLineage(v2, [v1, v2]).sort()).toEqual(["c1", "c2"]);
    const decision = checkBudget(v2, [v1, v2], [run("c1", 900, 200)]);
    expect(decision.allowed).toBe(false);
  });

  it("counts a run that has not finished yet", () => {
    const contract = { id: "c1", budget: { maxRuns: 1 } } as TaskContract;
    const inFlight = run("c1", 0, 0);
    inFlight.status = "running";
    // Otherwise two concurrent starts both slip under a run ceiling of one.
    expect(checkBudget(contract, [contract], [inFlight]).allowed).toBe(false);
  });

  it("stores no limits as absence rather than as an empty object", () => {
    expect(normalizeBudget({})).toBeUndefined();
    expect(normalizeBudget({ maxRuns: 0 })).toBeUndefined();
    expect(normalizeBudget({ maxRuns: -5 })).toBeUndefined();
    expect(normalizeBudget({ maxRuns: 3.7 })).toEqual({ maxRuns: 3 });
  });

  it("refuses a governed turn at admission and records the denial", async () => {
    const { context, contract } = await withContract();
    const bounded = await context.service.reviseContract(
      contract.id,
      { budget: { maxTotalTokens: 100 } },
      "operator",
    );
    await context.store.mutate((database) => {
      database.runs.push(run(bounded.id, 500, 100));
    });

    await expect(
      context.service.enforceBudget({
        runId: "00000000-0000-4000-8000-000000000950",
        agentId: SPECIALIST_ID,
        contract: context.service.getContract(bounded.id),
      }),
    ).rejects.toMatchObject({ statusCode: 429 });

    // A budget refusal lands in the same evidence stream as an egress block.
    const denials = context.service.listDenials();
    expect(denials.some((denial) => denial.kind === "budget")).toBe(true);
    expect(denials.find((denial) => denial.kind === "budget")?.outcome).toBe("blocked");
  });

  it("lets a reviewer raise a budget, unlike a scope", async () => {
    const { context, contract } = await withContract();
    const bounded = await context.service.reviseContract(
      contract.id,
      { budget: { maxTotalTokens: 100 } },
      "operator",
    );
    const raised = await context.service.reviseContract(
      bounded.id,
      { budget: { maxTotalTokens: 100_000 } },
      "operator",
    );
    // Spend is a decision an operator revisits with new information; a
    // permission is not, and widening one still needs a recorded denial.
    expect(raised.budget?.maxTotalTokens).toBe(100_000);
    expect(raised.version).toBe(3);
  });

  it("distinguishes clearing a budget from leaving it alone", async () => {
    const { context, contract } = await withContract();
    const bounded = await context.service.reviseContract(
      contract.id,
      { budget: { maxRuns: 5 } },
      "operator",
    );
    const untouched = await context.service.reviseContract(
      bounded.id,
      { scope: { ...bounded.scope, domains: [] } },
      "operator",
    );
    expect(untouched.budget?.maxRuns).toBe(5);

    const cleared = await context.service.reviseContract(
      untouched.id,
      { budget: null },
      "operator",
    );
    expect(cleared.budget).toBeUndefined();
  });

  it("rejects a revision that changes nothing", async () => {
    const { context, contract } = await withContract();
    await expect(context.service.reviseContract(contract.id, {}, "operator")).rejects.toThrow(
      /must change/i,
    );
  });

  it("reports spend without a contract having a budget at all", async () => {
    const { context, contract } = await withContract();
    const status = context.service.budgetStatus(contract.id);
    expect(status.allowed).toBe(true);
    expect(status.usage).toEqual({ totalTokens: 0, runs: 0, maxRunTokens: 0 });
  });
});

// -------------------------------------------------------------------- trace

describe("trace", () => {
  it("gives one Run's spans a shared trace id and a parent", async () => {
    const { store } = await makeService();
    const tracer = new RunTracer(store, "trace-1", "run-1", "agent-1");
    const turn = tracer.open({ name: "turn", category: "orchestration" });
    tracer.event({ name: "route: routed", category: "policy_decision", parentId: turn.id });
    const runtime = tracer.open({
      name: "runtime turn",
      category: "sandbox_execution",
      parentId: turn.id,
    });
    runtime.end();
    turn.end();
    await tracer.flush();

    const trace = traceForRun(store, "run-1");
    expect(trace?.traceId).toBe("trace-1");
    expect(trace?.spanCount).toBe(3);
    expect(trace?.spans.every((span) => span.traceId === "trace-1")).toBe(true);
    expect(trace?.spans.filter((span) => span.parentId === turn.id)).toHaveLength(2);
  });

  it("rolls up denials, which is what makes anyone open a trace", async () => {
    const { store } = await makeService();
    const tracer = new RunTracer(store, "trace-2", "run-2", "agent-1");
    const turn = tracer.open({ name: "turn", category: "orchestration" });
    tracer.event({
      name: "denied ab.chatgpt.com",
      category: "egress",
      parentId: turn.id,
      status: "denied",
    });
    turn.end();
    await tracer.flush();

    const trace = traceForRun(store, "run-2");
    expect(trace?.denied).toBe(1);
    expect(trace?.errored).toBe(0);
  });

  it("closes a span left open by a crash, as an error", async () => {
    const { store } = await makeService();
    const tracer = new RunTracer(store, "trace-3", "run-3", "agent-1");
    tracer.open({ name: "runtime turn", category: "sandbox_execution" });
    await tracer.flush();

    const trace = traceForRun(store, "run-3");
    // An unterminated span is exactly the shape of a crash, so it must not be
    // left dangling and reported as fine.
    expect(trace?.spans[0]?.status).toBe("error");
    expect(trace?.spans[0]?.endedAt).toBeDefined();
  });

  it("is idempotent, so a finally block can flush twice", async () => {
    const { store } = await makeService();
    const tracer = new RunTracer(store, "trace-4", "run-4", "agent-1");
    tracer.open({ name: "turn", category: "orchestration" }).end();
    await tracer.flush();
    await tracer.flush();
    expect(traceForRun(store, "run-4")?.spanCount).toBe(1);
  });

  it("ignores a repeated end, so the first outcome recorded is the one kept", async () => {
    const { store } = await makeService();
    const tracer = new RunTracer(store, "trace-5", "run-5", "agent-1");
    const span = tracer.open({ name: "turn", category: "orchestration" });
    span.end({ status: "denied" });
    span.end({ status: "ok" });
    await tracer.flush();
    expect(traceForRun(store, "run-5")?.spans[0]?.status).toBe("denied");
  });

  it("returns null for a Run recorded before tracing existed", async () => {
    const { store } = await makeService();
    expect(traceForRun(store, "run-that-never-ran")).toBeNull();
  });

  it("never lets a failed write change the Run's outcome", async () => {
    const { store } = await makeService();
    const tracer = new RunTracer(store, "trace-6", "run-6", "agent-1");
    tracer.open({ name: "turn", category: "orchestration" }).end();
    const broken = {
      ...store,
      mutate: async () => {
        throw new Error("store is down");
      },
    } as unknown as JsonStore;
    const failing = new RunTracer(broken, "trace-7", "run-7", "agent-1");
    failing.open({ name: "turn", category: "orchestration" }).end();
    // A Run that succeeded must not be reported as failed because its trace
    // could not be stored.
    await expect(failing.flush()).resolves.toBeUndefined();
    await tracer.flush();
  });
});
