/**
 * The quality counterpart to scope derivation.
 *
 * One person asking for "more colour" is a preference. Several people asking
 * for it is a defect in the brief — the specialist is making everyone ask for
 * the same thing twice. Codify harvests that and folds it in, behind the same
 * human gate and the same versioning that a permission change goes through.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { composeBrief } from "./service.js";
import { CodifyService } from "./service.js";

class InstantRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return { output: "done", threadId: request.threadId ?? "thread-1", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

const TASK =
  "Make me a presentation slide deck for the mid term meeting and write it to ./out/deck.md";

async function makeService(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codify-refine-"));
  directories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...overrides,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const codify = new CodifyService(config, store);
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new InstantRunner(),
    codify,
  );
  await service.initialize();
  return { service, codify, store, config };
}

async function settle(service: AgentService, runId: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const status = service.getRun(runId).status;
    if (status !== "queued" && status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not settle");
}

async function promote(context: Awaited<ReturnType<typeof makeService>>) {
  for (const [index, userId] of ["user-a", "user-b", "user-c", "user-a", "user-b"].entries()) {
    const runId = "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
    await context.codify.recordPromptObservation({
      runId,
      agentId: "seed",
      userId,
      redactedText: TASK,
      redactionHits: [],
      promotionEligible: true,
    });
    await context.store.mutate((database) => {
      database.capabilityObservations.push({
        runId,
        agentId: "seed",
        domainsReached: [],
        pathsRead: [],
        pathsWritten: ["out/deck.md"],
        secretsRead: [],
        createdAt: new Date().toISOString(),
      });
    });
  }
  const [candidate] = await context.codify.refreshCandidates();
  return context.service.approveCandidate(candidate!.id, { userId: "operator" });
}

/** One person asks for the task, then follows up with a correction. */
async function taskThenCorrection(
  context: Awaited<ReturnType<typeof makeService>>,
  agentId: string,
  userId: string,
  correction: string,
): Promise<void> {
  const first = await context.service.sendMessage(agentId, TASK, { userId });
  await settle(context.service, first.run.id);
  const second = await context.service.sendMessage(agentId, correction, { userId });
  await settle(context.service, second.run.id);
}

describe("Codify refinement from repeated corrections", () => {
  it("ignores a correction only one person ever made", async () => {
    const context = await makeService();
    const { agent } = await promote(context);
    await taskThenCorrection(context, agent.id, "user-a", "Please use more colour in the slides");

    expect(await context.codify.refreshRefinements()).toHaveLength(0);
  });

  it("proposes a standing rule once several people ask for the same thing", async () => {
    const context = await makeService();
    const { agent } = await promote(context);
    await taskThenCorrection(context, agent.id, "user-a", "Please use more colour in the slides");
    await taskThenCorrection(context, agent.id, "user-b", "please use more colour in the slides");

    const proposals = await context.codify.refreshRefinements();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.distinctUsers).toBe(2);
    expect(proposals[0]?.status).toBe("pending");
    expect(proposals[0]?.proposedRule.toLowerCase()).toContain("colour");
  });

  it("writes an approved rule into the contract and into the Agent's brief", async () => {
    const context = await makeService();
    const { agent, contract } = await promote(context);
    await taskThenCorrection(context, agent.id, "user-a", "Please use more colour in the slides");
    await taskThenCorrection(context, agent.id, "user-b", "please use more colour in the slides");

    const [proposal] = await context.codify.refreshRefinements();
    const applied = await context.service.applyRefinement(
      proposal!.id,
      "operator",
      "Always use a colourful palette with accent colours on headings.",
    );

    // The contract is versioned, not edited in place.
    expect(applied.contract.version).toBe(contract.version + 1);
    expect(applied.contract.supersedes).toBe(contract.id);
    expect(applied.contract.refinements).toEqual([
      "Always use a colourful palette with accent colours on headings.",
    ]);
    expect(context.codify.getContract(contract.id).status).toBe("deprecated");

    // And the specialist actually runs with it: AGENTS.md is what the Runtime reads.
    const brief = await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8");
    expect(brief).toContain("Learned from repeated user corrections");
    expect(brief).toContain("colourful palette");
  });

  it("routes later turns to the refined version of the contract", async () => {
    const context = await makeService();
    const { agent } = await promote(context);
    await taskThenCorrection(context, agent.id, "user-a", "Please use more colour in the slides");
    await taskThenCorrection(context, agent.id, "user-b", "please use more colour in the slides");
    const [proposal] = await context.codify.refreshRefinements();
    await context.service.applyRefinement(proposal!.id, "operator", "Use a colourful palette.");

    const generic = await context.service.createAgent({ name: "General assistant" });
    const result = await context.service.sendMessage(generic.id, TASK, { userId: "user-z" });
    expect(result.run.codify?.contractVersion).toBe(2);
    expect(result.delegatedTo?.id).toBe(agent.id);
  });

  it("lets a reviewer reject a proposed rule", async () => {
    const context = await makeService();
    const { agent, contract } = await promote(context);
    await taskThenCorrection(context, agent.id, "user-a", "Please use more colour in the slides");
    await taskThenCorrection(context, agent.id, "user-b", "please use more colour in the slides");

    const [proposal] = await context.codify.refreshRefinements();
    const rejected = await context.codify.rejectRefinement(proposal!.id);
    expect(rejected.status).toBe("rejected");
    // The contract is untouched.
    expect(context.codify.getContract(contract.id).status).toBe("active");
    expect(context.codify.getContract(contract.id).refinements).toEqual([]);
  });

  it("never mistakes a repeat of the task for a correction of it", async () => {
    const context = await makeService();
    const { agent } = await promote(context);

    // Two different people simply doing the task twice. Nobody complained, so
    // there is nothing to learn — an earlier version read the second person's
    // request as feedback on the first person's output and proposed a "rule"
    // that was just the task restated.
    for (const userId of ["user-a", "user-b", "user-c"]) {
      const run = await context.service.sendMessage(agent.id, TASK, { userId });
      await settle(context.service, run.run.id);
    }

    expect(await context.codify.refreshRefinements()).toHaveLength(0);
    expect(context.store.snapshot().feedbackObservations).toHaveLength(0);
  });

  it("does not treat two different corrections as the same rule", async () => {
    const context = await makeService();
    const { agent } = await promote(context);
    await taskThenCorrection(context, agent.id, "user-a", "Please use more colour in the slides");
    await taskThenCorrection(context, agent.id, "user-b", "Add the quarterly revenue table please");

    expect(await context.codify.refreshRefinements()).toHaveLength(0);
  });
});

describe("Codify brief composition", () => {
  it("keeps the promoted brief and the learned rules distinguishable", () => {
    const composed = composeBrief("ORIGINAL BRIEF", ["Rule one.", "Rule two."]);
    expect(composed).toContain("ORIGINAL BRIEF");
    expect(composed).toContain("## Learned from repeated user corrections");
    expect(composed).toContain("- Rule one.");
    expect(composed).toContain("- Rule two.");
  });

  it("adds nothing when there is nothing learned yet", () => {
    expect(composeBrief("ORIGINAL BRIEF", [])).toBe("ORIGINAL BRIEF");
  });
});
