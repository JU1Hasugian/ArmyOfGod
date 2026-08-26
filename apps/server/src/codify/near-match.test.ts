/**
 * Partial recognition.
 *
 * The measured fail-open this closes: a prompt that combines a governed task
 * with a second one scores *below* every threshold, because compounding weakens
 * containment and the embedding at the same time — 0.22 and 0.66 against lines
 * of 0.60 and 0.72 — and an unmatched turn runs ad hoc with an unrestricted
 * network. So the less recognisable a request is, the more capability it gets.
 *
 * Recording the contracts that came close is what makes that visible. Everything
 * here uses the lexical channel only, so the assertions are exact rather than
 * dependent on a live embedding model.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { CodifyService } from "./service.js";
import { canonicalize, fingerprint } from "./fingerprint.js";
import { containment, NEAR_MATCH_FRACTION } from "./semantic.js";
import type { CapabilityScope, TaskContract } from "./types.js";

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

const scope: CapabilityScope = {
  paths: [{ path: "out", mode: "rw" }],
  domains: ["warehouse.internal"],
  secrets: [],
};

const EXEMPLAR =
  "Pull last month's signup numbers from the analytics warehouse, break them down by " +
  "acquisition channel and by region, and write the result to ./out/signups.md as a " +
  "markdown table with a total row at the bottom";

const contract = (): TaskContract => {
  const canonicalForm = canonicalize(EXEMPLAR);
  return {
    id: "c-sql",
    version: 1,
    name: "Signups report",
    agentId: "agent-sql",
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

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "codify-near-"));
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
  await store.mutate((database) => {
    database.contracts.push(contract());
  });
  return { service: new CodifyService(config, store), store, config };
}

async function decide(service: CodifyService, text: string) {
  const observation = await service.recordPromptObservation({
    runId: "00000000-0000-4000-8000-00000000000" + (counter++ % 10),
    agentId: "generic",
    userId: "user-a",
    redactedText: text,
    redactionHits: [],
    promotionEligible: true,
  });
  return service.route({
    runId: observation.runId,
    agentId: "generic",
    observation,
    forceAdHoc: false,
  }).decision;
}
let counter = 0;

/** Keep the first `fraction` of the exemplar's words, then add a second task. */
function partial(fraction: number, tail: string): string {
  const words = EXEMPLAR.split(" ");
  return words.slice(0, Math.round(words.length * fraction)).join(" ") + " " + tail;
}

describe("a partly recognised request is not an unrecognised one", () => {
  it("names the contracts that came close when nothing cleared", async () => {
    const { service } = await harness();
    const text = partial(0.55, "and then email the result to the board");
    // Confirm the probe really does sit in the band, so the test is not passing
    // for some other reason.
    const score = containment(canonicalize(EXEMPLAR), canonicalize(text));
    expect(score).toBeLessThan(0.6);
    expect(score).toBeGreaterThanOrEqual(0.6 * NEAR_MATCH_FRACTION);

    const decision = await decide(service, text);
    expect(decision.decision).toBe("unmatched");
    expect(decision.nearMatches?.map((entry) => entry.name)).toEqual(["Signups report"]);
    expect(decision.reason).toContain("more than one request");
  });

  it("says nothing about near matches for genuinely unrelated work", async () => {
    const { service } = await harness();
    const decision = await decide(
      service,
      "Refactor the payment retry logic in ./billing so a declined card is retried twice",
    );
    expect(decision.decision).toBe("unmatched");
    // 2,000 unrelated prompts peaked at 0.383 — nowhere near the band. If this
    // fires on ordinary background traffic, the band is set wrong.
    expect(decision.nearMatches).toBeUndefined();
  });

  it("says nothing about near matches when a contract actually matched", async () => {
    const { service } = await harness();
    const decision = await decide(service, EXEMPLAR);
    expect(decision.decision).toBe("routed");
    expect(decision.nearMatches).toBeUndefined();
  });
});
