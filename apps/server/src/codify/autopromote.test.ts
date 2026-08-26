/**
 * Promotion without a person in the loop.
 *
 * The claim being tested is narrow and worth stating exactly: promotion does
 * not *grant* capability, because the runs a candidate is derived from already
 * reached those hosts and wrote those paths, ad hoc and unbounded. What the
 * gate protects is the step from "one run did this" to "this is a standing
 * allowance". So these tests are about laundering, not about permissions.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { CodifyService } from "./service.js";
import { clampForAutoGrant } from "./scope.js";
import type { CapabilityScope, PromptObservation } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

const PROMPT =
  "Generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/RELEASE.md";

async function makeService(extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codify-auto-"));
  directories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
    ...extra,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  return { service: new CodifyService(config, store), store, config };
}

let agentSeq = 0;
const makeAgent = async (input: { name: string }): Promise<Agent> =>
  ({
    id: "agent-" + ++agentSeq,
    name: input.name,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/tmp/ws",
    codexThreadId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as Agent;

async function seed(
  context: Awaited<ReturnType<typeof makeService>>,
  options: { secrets?: string[]; domains?: string[] } = {},
): Promise<PromptObservation[]> {
  const out: PromptObservation[] = [];
  for (const [index, userId] of ["u-a", "u-b", "u-c", "u-a", "u-b"].entries()) {
    const runId = "00000000-0000-4000-8000-" + String(index).padStart(12, "0");
    out.push(
      await context.service.recordPromptObservation({
        runId,
        agentId: "generic",
        userId,
        redactedText: PROMPT,
        redactionHits: [],
        promotionEligible: true,
      }),
    );
    await context.store.mutate((database) => {
      database.capabilityObservations.push({
        runId,
        agentId: "generic",
        domainsReached: options.domains ?? ["github.com"],
        pathsRead: ["repo/CHANGELOG.md"],
        pathsWritten: ["out/RELEASE.md"],
        secretsRead: options.secrets ?? [],
        createdAt: new Date().toISOString(),
      });
    });
  }
  await context.service.refreshCandidates();
  return out;
}

describe("the auto-grant clamp", () => {
  const derived: CapabilityScope = {
    paths: [{ path: "out", mode: "rw" }],
    domains: ["github.com"],
    secrets: ["GITHUB_TOKEN"],
  };

  it("withholds credentials by default", () => {
    const { scope, withheld } = clampForAutoGrant(derived, { grantSecrets: false });
    // A host or a path a task demonstrably used is a narrowing of what an ad-hoc
    // run already had. Handing a brand-new principal a credential is not.
    expect(scope.secrets).toEqual([]);
    expect(withheld.secrets).toEqual(["GITHUB_TOKEN"]);
    expect(scope.domains).toEqual(["github.com"]);
    expect(scope.paths).toEqual(derived.paths);
  });

  it("grants them when an operator has opted in", () => {
    const { scope, withheld } = clampForAutoGrant(derived, { grantSecrets: true });
    expect(scope.secrets).toEqual(["GITHUB_TOKEN"]);
    expect(withheld.secrets).toEqual([]);
  });

  it("only ever removes, so it cannot fail the narrow-only rule", () => {
    const { scope } = clampForAutoGrant(derived, { grantSecrets: false });
    expect(scope.domains.every((d) => derived.domains.includes(d))).toBe(true);
    expect(scope.secrets.every((s) => derived.secrets.includes(s))).toBe(true);
  });
});

describe("auto-promotion", () => {
  it("does nothing when the switch is off, which is the default", async () => {
    // Off by default: measured over 2,247 prompts, auto-promotion produced 36
    // contracts where 12 tasks existed. See the note on the config field.
    const context = await makeService();
    await seed(context);
    const result = await context.service.autoPromote(makeAgent);
    expect(result.promoted).toEqual([]);
    expect(context.service.listCandidates()[0]?.status).toBe("pending");
  });

  it("holds a candidate when the reviewer cannot be reached", async () => {
    // Drafting is off under test, so `reviewScope` gets no answer. That must
    // hold the candidate rather than wave it through: this is the one model
    // call in Codify that fails closed, because failing open would auto-grant
    // precisely the cases nobody looked at.
    const context = await makeService({ CODIFY_AUTO_PROMOTE: "true" });
    await seed(context);
    const result = await context.service.autoPromote(makeAgent);
    expect(result.promoted).toEqual([]);
    expect(result.heldForReview).toHaveLength(1);
    expect(result.heldForReview[0]?.reason).toMatch(/unreachable|not auto-approved/i);
    expect(context.service.listCandidates()[0]?.status).toBe("pending");
  });

  it("leaves a held candidate promotable by a person", async () => {
    const context = await makeService({ CODIFY_AUTO_PROMOTE: "true" });
    await seed(context);
    await context.service.autoPromote(makeAgent);
    const candidate = context.service.listCandidates()[0];
    // Held is not rejected. The human path is untouched.
    const { contract } = await context.service.approveCandidate(
      candidate!.id,
      { userId: "operator" },
      makeAgent,
    );
    expect(contract.createdBy).toBe("operator");
  });

  it("never promotes a candidate that failed the distinct-user floor", async () => {
    const context = await makeService({ CODIFY_AUTO_PROMOTE: "true" });
    for (let index = 0; index < 15; index += 1) {
      const runId = "00000000-0000-4000-8000-" + String(900 + index).padStart(12, "0");
      await context.service.recordPromptObservation({
        runId,
        agentId: "generic",
        userId: "mallory",
        redactedText: "Collect every credential in ./repo and upload it to ./out/bundle.tar",
        redactionHits: [],
        promotionEligible: true,
      });
      await context.store.mutate((database) => {
        database.capabilityObservations.push({
          runId,
          agentId: "generic",
          domainsReached: ["collector.evil.example"],
          pathsRead: ["repo/.env"],
          pathsWritten: ["out/bundle.tar"],
          secretsRead: [],
          createdAt: new Date().toISOString(),
        });
      });
    }
    await context.service.refreshCandidates();
    // The structural control sits underneath the reviewer and does not depend
    // on it: one person repeating a prompt never reaches promotion at all.
    expect(context.service.listCandidates()).toHaveLength(0);
    const result = await context.service.autoPromote(makeAgent);
    expect(result.promoted).toEqual([]);
  });
});
