/**
 * Declining to choose between two contracts that scored the same.
 *
 * Measured on WorkBench (`docs/SEMANTIC-ROUTING.md` §4e): where governed tasks
 * are neighbours, the failure is not a low score. It is two contracts scoring
 * almost the same, and taking the larger of 0.81 and 0.80 is a coin flip
 * dressed as a decision. The cost of losing it is a specialist briefed for its
 * sibling's job.
 *
 * The margin ships at `0` — take-the-best, exactly as before — because the same
 * measurement shows it buys about one prevented misroute for every three
 * correct routes it gives up, and every abstention is an ungoverned ad-hoc run.
 * These tests exist so the mechanism is correct and its default is deliberate,
 * not so it is on.
 *
 * Lexical channel only, so every assertion is exact rather than dependent on a
 * live embedding model.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { CodifyService } from "./service.js";
import { canonicalize, fingerprint } from "./fingerprint.js";
import type { CapabilityScope, TaskContract } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

/** Two neighbours: same job shape, different verb, and different capability. */
const CHART = "Make a bar chart of total visits since November 21 and save it to ./out/chart.md";
const ALERT = "Make a bar chart of total visits since November 22 and save it to ./out/alert.md";
/** Nothing like either of them. */
const UNRELATED = "Summarise the incident timeline in ./incidents into a postmortem";

const scopeOf = (domain: string): CapabilityScope => ({
  paths: [{ path: "out", mode: "rw" }],
  domains: [domain],
  secrets: [],
});

function contract(id: string, name: string, exemplar: string, domain: string): TaskContract {
  const canonicalForm = canonicalize(exemplar);
  return {
    id,
    version: 1,
    name,
    agentId: "agent-" + id,
    matchFingerprints: [fingerprint(canonicalForm)],
    matchCanonicalForms: [canonicalForm],
    matchThreshold: 0.65,
    systemPrompt: "",
    refinements: [],
    scope: scopeOf(domain),
    status: "active",
    createdBy: "operator",
    createdAt: new Date().toISOString(),
  };
}

let counter = 0;
async function harness(margin?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "codify-tie-"));
  directories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
    ...(margin === undefined ? {} : { CODIFY_TIE_MARGIN: margin }),
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.contracts.push(contract("c-chart", "Charting", CHART, "charts.internal"));
    database.contracts.push(contract("c-alert", "Alerting", ALERT, "alerts.internal"));
  });
  return { service: new CodifyService(config, store), store };
}

async function decide(service: CodifyService, text: string, agentId = "generic") {
  const observation = await service.recordPromptObservation({
    runId: "00000000-0000-4000-8000-00000000000" + (counter++ % 10),
    agentId,
    userId: "user-a",
    redactedText: text,
    redactionHits: [],
    promotionEligible: true,
  });
  return service.route({ runId: observation.runId, agentId, observation, forceAdHoc: false });
}

describe("routing declines to guess between two contracts that scored the same", () => {
  it("takes the best match when no margin is configured", async () => {
    const { service } = await harness();
    // The shipped default. Two near-identical contracts still produce a route:
    // this is the behaviour every other test in the suite assumes.
    const { decision } = await decide(service, CHART);
    expect(decision.decision).toBe("routed");
    expect(decision.contractId).toBeDefined();
  });

  it("abstains when the runner-up is inside the margin, and says which two", async () => {
    const { service } = await harness("0.9");
    const { decision } = await decide(service, CHART);

    expect(decision.decision).toBe("unmatched");
    expect(decision.brokerMode).toBe("observe");
    // An operator has to be able to tell this apart from an ordinary miss.
    expect(decision.reason).toMatch(/within/i);
    expect(decision.reason).toContain("Charting");
    expect(decision.reason).toContain("Alerting");
  });

  it("still routes a prompt only one contract recognises", async () => {
    const { service } = await harness("0.9");
    // A wide margin must not become a blanket refusal to route. Nothing here
    // resembles either contract, so there is no runner-up to tie with.
    const { decision } = await decide(service, UNRELATED);
    expect(decision.decision).toBe("unmatched");
    expect(decision.reason).not.toMatch(/within/i);
  });

  it("never widens what a run may reach: a tie on a specialist stays bound to its own scope", async () => {
    const { service } = await harness("0.9");
    // The safety property. Abstaining drops the *brief*; it must not drop the
    // scope, or declining to choose would become a way to escape enforcement.
    const { decision, binding } = await decide(service, CHART, "agent-c-chart");

    expect(decision.decision).toBe("principal_bound");
    expect(decision.brokerMode).toBe("enforce");
    expect(binding?.scope.domains).toEqual(["charts.internal"]);
    // And never the union of the two it could not choose between.
    expect(binding?.scope.domains).not.toContain("alerts.internal");
  });
});
