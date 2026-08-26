/**
 * A workplace, simulated end to end.
 *
 * Everything measured so far tested a component. This runs the whole platform
 * the way an office would use it: 500 employees, prompts arriving one at a time
 * against an empty store, nobody configuring anything, promotion firing on its
 * own. It uses the real `CodifyService` — real clustering, real scope
 * derivation, real routing — so what it measures is the shipped code path.
 *
 * The corpus is built to have the shape real traffic has, which is the part
 * every earlier experiment got wrong in one direction or another:
 *
 *   recurring    12 task families, 30 wordings each, spread across many people.
 *                These SHOULD promote — they are the product's whole premise.
 *   long tail    788 genuinely distinct engineering requests from BigCodeBench
 *                and SWE-bench. These should NEVER promote: each is asked once.
 *                Benchmarks are built not to repeat, which makes them a perfect
 *                stand-in for the one-off work that fills a real week.
 *   chatter      ordinary assistant requests, some of which genuinely recur.
 *
 * Employee activity is Zipf-shaped rather than uniform, because "5 runs from 3
 * distinct users" behaves very differently when a handful of power users
 * generate most of the volume.
 *
 * Four questions:
 *   1. what gets promoted, and is it right?
 *   2. does the long tail ever produce a contract?
 *   3. after promotion, do later requests for that task land on the specialist?
 *   4. how much of the office's traffic ends up governed, and how fast?
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "./src/config.js";
import { JsonStore } from "./src/store.js";
import { CodifyService } from "./src/codify/service.js";
import type { Agent } from "./src/types.js";

const SCRATCH = process.env.SCRATCH ?? ".";
const EMPLOYEES = 500;
const read = (f: string) => JSON.parse(readFileSync(SCRATCH + "/" + f, "utf8"));

const generated = read("probes_generated.json").tasks as Record<
  string,
  { positives: string[]; negatives: string[] }
>;
const FAMILIES = Object.keys(generated);

const clean = (t: unknown) =>
  String(t ?? "").replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();

const longTail: string[] = [
  ...read("ds_bigcodebench.json")
    .map((r: { instruct_prompt?: string }) => clean(r.instruct_prompt))
    .filter((t: string) => t.length > 40 && t.length < 900),
  ...read("ds_swebench.json")
    .map((r: { problem_statement?: string }) => clean(r.problem_statement))
    .filter((t: string) => t.length > 40)
    .map((t: string) => t.slice(0, 900)),
];

const chatter: string[] = [];
{
  const seen = new Set<string>();
  for (const row of read("ds_wildchat_big.json") as {
    conversations?: { role?: string; from?: string; content?: string; value?: string }[];
  }[]) {
    const first = row.conversations?.find((m) => m.role === "user" || m.from === "human");
    const text = (first?.content ?? first?.value ?? "").trim();
    if (text.length < 30 || text.length > 600 || seen.has(text)) continue;
    seen.add(text);
    chatter.push(text);
    if (chatter.length >= 600) break;
  }
}

/**
 * Zipf-ish staff: employee 1 is far busier than employee 500. Sampled with a
 * fixed seed so a surprising number can be re-run.
 */
let seed = 20260826;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const staff = Array.from({ length: EMPLOYEES }, (_, i) => "emp-" + String(i + 1).padStart(3, "0"));
const pickEmployee = () => staff[Math.floor(EMPLOYEES * rand() * rand())] as string;

type Source = "recurring" | "long-tail" | "chatter";
interface Arrival { text: string; family: string | null; source: Source }

/** Interleave so recurring work is a minority of a busy week, as it is. */
function buildStream(): Arrival[] {
  const queues = FAMILIES.map((id) => [...(generated[id]?.positives ?? [])]);
  const tail = [...longTail];
  const chat = [...chatter];
  const stream: Arrival[] = [];
  while (queues.some((q) => q.length) || tail.length || chat.length) {
    for (const [slot, queue] of queues.entries()) {
      const next = queue.shift();
      if (next) stream.push({ text: next, family: FAMILIES[slot] as string, source: "recurring" });
    }
    for (let n = 0; n < 2; n += 1) {
      const one = tail.shift();
      if (one) stream.push({ text: one, family: null, source: "long-tail" });
    }
    const c = chat.shift();
    if (c) stream.push({ text: c, family: null, source: "chatter" });
  }
  return stream;
}

/** What a run of each family actually touches, so scope derivation has input. */
const TOUCHES: Record<string, { domains: string[]; read: string[]; write: string[] }> = {
  "release-notes": { domains: ["github.com"], read: ["repo/CHANGELOG.md"], write: ["out/RELEASE.md"] },
  postmortem: { domains: [], read: ["incidents/log.md"], write: ["out/postmortem.md"] },
  "dep-audit": { domains: ["registry.npmjs.org"], read: ["repo/package-lock.json"], write: ["reports/audit.md"] },
  "weekly-status": { domains: [], read: ["notes/week.md"], write: ["out/status.md"] },
  "slide-deck": { domains: [], read: ["notes/deck.md"], write: ["out/deck.md"] },
  "api-docs": { domains: [], read: ["src/api/routes.ts"], write: ["docs/api.md"] },
  "test-coverage": { domains: [], read: ["repo/package.json"], write: ["reports/coverage.md"] },
  "onboarding-doc": { domains: [], read: ["docs/setup.md"], write: ["out/onboarding.md"] },
  "sql-report": { domains: ["warehouse.internal"], read: ["queries/signups.sql"], write: ["out/signups.md"] },
  "i18n-extract": { domains: [], read: ["src/ui.tsx"], write: ["locales/en.json"] },
  "perf-profile": { domains: [], read: ["repo/server.ts"], write: ["reports/perf.md"] },
  "migration-plan": { domains: [], read: ["repo/schema.sql"], write: ["out/migration.md"] },
};

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "codify-office-"));
  const config = loadConfig({
    NODE_ENV: "development",
    APP_DATA_DIR: root,
    AGENT_WORKSPACE_ROOT: path.join(root, "ws"),
    ARK_API_KEY: process.env.ARK_API_KEY,
    ARK_MODEL: process.env.ARK_MODEL ?? "ep-20260826090551-mg6j8",
    ARK_EMBED_MODEL: process.env.ARK_EMBED_MODEL,
    ARK_BASE_URL: process.env.ARK_BASE_URL ?? "https://ark.ap-southeast.volces.com/api/v3",
    CODIFY_SEMANTIC: "true",
    CODIFY_LLM_DRAFTING: "false",   // measuring routing, not prose; one call per prompt
    CODIFY_AUTO_PROMOTE: "true",
    CODIFY_SEED_FIXTURES: "false",
    RUNTIME_PROVIDER: "local-process",
  });
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const service = new CodifyService(config, store);

  const stream = buildStream();
  console.log(
    "office stream: " + stream.length + " prompts, " + EMPLOYEES + " employees\n" +
    "  recurring " + stream.filter((a) => a.source === "recurring").length +
    " across " + FAMILIES.length + " families | long tail " +
    stream.filter((a) => a.source === "long-tail").length +
    " | chatter " + stream.filter((a) => a.source === "chatter").length + "\n",
  );

  const contractFamily = new Map<string, string | null>();   // contractId -> family it was built from
  const promotedAt = new Map<string, number>();
  const outcomes: { index: number; source: Source; family: string | null; governed: boolean; correct: boolean }[] = [];
  let agentSeq = 0;

  const createAgent = async (input: { name: string }): Promise<Agent> =>
    ({
      id: "agent-" + ++agentSeq, name: input.name, description: "", instructions: "",
      status: "ready", workspacePath: path.join(root, "ws", String(agentSeq)),
      codexThreadId: null, lastError: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }) as Agent;

  for (const [index, arrival] of stream.entries()) {
    const userId = pickEmployee();
    const runId = "00000000-0000-4000-8000-" + String(index).padStart(12, "0");

    const observation = await service.recordPromptObservation({
      runId, agentId: "generic", userId,
      redactedText: arrival.text, redactionHits: [], promotionEligible: true,
    });
    const decision = service.route({ runId, agentId: "generic", observation, forceAdHoc: false }).decision;
    const governed = decision.decision === "routed";
    outcomes.push({
      index, source: arrival.source, family: arrival.family, governed,
      correct: governed && contractFamily.get(decision.contractId ?? "") === arrival.family,
    });

    // An ungoverned run still yields the capability evidence derivation feeds on.
    const touches = arrival.family ? TOUCHES[arrival.family] : null;
    if (touches && !governed) {
      await store.mutate((database) => {
        database.capabilityObservations.push({
          runId, agentId: "generic",
          domainsReached: touches.domains, pathsRead: touches.read,
          pathsWritten: touches.write, secretsRead: [],
          createdAt: new Date().toISOString(),
        });
      });
    }

    // A background detection pass, as the platform runs one — not every turn.
    if (index % 25 !== 0) continue;
    await service.refreshCandidates();
    const { promoted } = await service.autoPromote(createAgent);
    for (const contract of promoted) {
      const exemplarTexts = new Set(
        store.snapshot().promptObservations
          .filter((o) => contract.matchCanonicalForms?.includes(o.canonicalForm))
          .map((o) => o.redactedText),
      );
      const family = FAMILIES.find((id) =>
        (generated[id]?.positives ?? []).some((t) => exemplarTexts.has(t)),
      ) ?? null;
      contractFamily.set(contract.id, family);
      if (family && !promotedAt.has(family)) promotedAt.set(family, index);
      console.log(
        "  [" + String(index).padStart(4) + "] promoted " +
        (family ?? "*** NOT a recurring family ***").padEnd(16) +
        " scope=" + JSON.stringify(contract.scope.domains) +
        " secrets=" + JSON.stringify(contract.scope.secrets),
      );
    }
  }

  // ------------------------------------------------------------------ report

  const contracts = store.snapshot().contracts;
  const fromFamily = [...contractFamily.values()].filter(Boolean).length;
  const fromElsewhere = [...contractFamily.values()].filter((f) => !f).length;

  console.log("\n### 1. what got promoted");
  console.log("  contracts created            : " + contracts.length);
  console.log("  ...from a real recurring task: " + fromFamily + " of " + FAMILIES.length + " families");
  console.log("  ...from anything else        : " + fromElsewhere);

  console.log("\n### 2. did the long tail ever promote?");
  const tailGoverned = outcomes.filter((o) => o.source === "long-tail" && o.governed).length;
  const tailTotal = outcomes.filter((o) => o.source === "long-tail").length;
  console.log("  long-tail prompts            : " + tailTotal);
  console.log("  ...routed to some specialist : " + tailGoverned +
    "  (" + ((tailGoverned / Math.max(1, tailTotal)) * 100).toFixed(2) + "%)");

  console.log("\n### 3. after promotion, do later requests land on the specialist?");
  console.log("  family            promoted@   later   routed   correct");
  let laterTotal = 0, laterCorrect = 0;
  for (const family of FAMILIES) {
    const at = promotedAt.get(family);
    const later = outcomes.filter((o) => o.family === family && at !== undefined && o.index > at);
    const routed = later.filter((o) => o.governed).length;
    const correct = later.filter((o) => o.correct).length;
    laterTotal += later.length; laterCorrect += correct;
    console.log(
      "  " + family.padEnd(16) +
      (at === undefined ? "never" : String(at)).padStart(10) +
      String(later.length).padStart(8) + String(routed).padStart(9) + String(correct).padStart(10),
    );
  }
  console.log("  " + "".padEnd(16) + "".padStart(10) +
    String(laterTotal).padStart(8) + "".padStart(9) + String(laterCorrect).padStart(10) +
    "   = " + ((laterCorrect / Math.max(1, laterTotal)) * 100).toFixed(1) + "% carryover");

  console.log("\n### 4. how much of the office's work ends up governed");
  const bucket = Math.ceil(stream.length / 6);
  console.log("  prompts        recurring work governed");
  for (let start = 0; start < stream.length; start += bucket) {
    const slice = outcomes.filter((o) => o.index >= start && o.index < start + bucket && o.source === "recurring");
    const share = slice.length ? (slice.filter((o) => o.governed).length / slice.length) * 100 : 0;
    const bar = "#".repeat(Math.round(share / 4));
    console.log("  " + (start + "-" + Math.min(stream.length, start + bucket)).padEnd(15) +
      share.toFixed(0).padStart(3) + "%  " + bar);
  }

  const misrouted = outcomes.filter((o) => o.governed && !o.correct && o.family).length;
  console.log("\n  misrouted (recurring work sent to the wrong contract): " + misrouted);

  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

await main();
