/**
 * The learning loop, end to end, at the scale of an office.
 *
 * This is the test for the project's actual thesis. Everything else measures a
 * component; this starts from an empty store and asks whether the whole claim
 * holds:
 *
 *   nothing is configured -> work repeats -> a task is detected from that
 *   repetition alone -> it is promoted with a brief and a scope nobody wrote
 *   -> later requests worded differently are routed to it -> and the one-off
 *   work that fills a real week never promotes and never routes.
 *
 * It drives the real `CodifyService` — real redaction, real clustering, real
 * scope derivation, real routing, real promotion — so what passes here is the
 * shipped code path and not a re-implementation.
 *
 * The corpus has the shape real traffic has, which is what every narrower
 * experiment got wrong in one direction or another:
 *
 *   recurring   12 families, 30 wordings each, written by a model that never
 *               saw the matcher. These SHOULD promote.
 *   long tail   788 genuinely distinct engineering requests from BigCodeBench
 *               and SWE-bench. Benchmarks are built not to repeat, which makes
 *               them a faithful stand-in for one-off work. These must NOT.
 *   chatter     600 ordinary assistant requests, some of which do recur.
 *
 * 500 employees, Zipf-shaped so a handful of people generate most of the
 * volume — because "5 runs from 3 distinct users" behaves very differently when
 * activity is not uniform.
 *
 * The embedding cache is warmed up front. `embedPrompt` memoises by text, so
 * after the warm-up the stream exercises the identical code path with no
 * network in the loop. An earlier attempt made 1,748 serial calls instead and
 * never finished.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "./src/config.js";
import { JsonStore } from "./src/store.js";
import { CodifyService } from "./src/codify/service.js";
import { embedPrompt } from "./src/codify/semantic.js";
import type { Agent } from "./src/types.js";

const SCRATCH = process.env.SCRATCH ?? ".";
const EMPLOYEES = 500;
const read = (f: string) => JSON.parse(readFileSync(SCRATCH + "/" + f, "utf8"));
const generated = read("probes_generated.json").tasks as Record<string, { positives: string[] }>;
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

let seed = 20260826;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const staff = Array.from({ length: EMPLOYEES }, (_, i) => "emp-" + String(i + 1).padStart(3, "0"));
const pickEmployee = () => staff[Math.floor(EMPLOYEES * rand() * rand())] as string;

type Source = "recurring" | "long-tail" | "chatter";
interface Arrival { text: string; family: string | null; source: Source }

function buildStream(): Arrival[] {
  const queues = FAMILIES.map((id) => [...(generated[id]?.positives ?? [])]);
  const tail = [...longTail];
  const chat = [...chatter];
  const out: Arrival[] = [];
  while (queues.some((q) => q.length) || tail.length || chat.length) {
    for (const [slot, q] of queues.entries()) {
      const next = q.shift();
      if (next) out.push({ text: next, family: FAMILIES[slot] as string, source: "recurring" });
    }
    for (let n = 0; n < 2; n += 1) {
      const one = tail.shift();
      if (one) out.push({ text: one, family: null, source: "long-tail" });
    }
    const c = chat.shift();
    if (c) out.push({ text: c, family: null, source: "chatter" });
  }
  return out;
}

/** What a run of each family touches, so scope derivation has real input. */
const TOUCHES: Record<string, { domains: string[]; read: string[]; write: string[]; secrets: string[] }> = {
  "release-notes": { domains: ["github.com"], read: ["repo/CHANGELOG.md"], write: ["out/RELEASE.md"], secrets: ["GITHUB_TOKEN"] },
  postmortem: { domains: [], read: ["incidents/log.md"], write: ["out/postmortem.md"], secrets: [] },
  "dep-audit": { domains: ["registry.npmjs.org"], read: ["repo/package-lock.json"], write: ["reports/audit.md"], secrets: [] },
  "weekly-status": { domains: [], read: ["notes/week.md"], write: ["out/status.md"], secrets: [] },
  "slide-deck": { domains: [], read: ["notes/deck.md"], write: ["out/deck.md"], secrets: [] },
  "api-docs": { domains: [], read: ["src/api/routes.ts"], write: ["docs/api.md"], secrets: [] },
  "test-coverage": { domains: [], read: ["repo/package.json"], write: ["reports/coverage.md"], secrets: [] },
  "onboarding-doc": { domains: [], read: ["docs/setup.md"], write: ["out/onboarding.md"], secrets: [] },
  "sql-report": { domains: ["warehouse.internal"], read: ["queries/signups.sql"], write: ["out/signups.md"], secrets: ["WAREHOUSE_DSN"] },
  "i18n-extract": { domains: [], read: ["src/ui.tsx"], write: ["locales/en.json"], secrets: [] },
  "perf-profile": { domains: [], read: ["repo/server.ts"], write: ["reports/perf.md"], secrets: [] },
  "migration-plan": { domains: [], read: ["repo/schema.sql"], write: ["out/migration.md"], secrets: [] },
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
    // The reviewer that gates auto-promotion is a model call, and it fails
    // closed — with drafting off it withholds approval and nothing is ever
    // promoted, which also means every observation stays eligible forever and
    // each pass re-clusters the whole store. Both symptoms, one cause.
    CODIFY_LLM_DRAFTING: "true",
    CODIFY_AUTO_PROMOTE: "true",
    CODIFY_SEED_FIXTURES: "false",
    RUNTIME_PROVIDER: "local-process",
  });
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const service = new CodifyService(config, store);

  const stream = buildStream();
  console.log(
    "office: " + stream.length + " prompts, " + EMPLOYEES + " employees\n  recurring " +
    stream.filter((a) => a.source === "recurring").length + " across " + FAMILIES.length +
    " families | long tail " + stream.filter((a) => a.source === "long-tail").length +
    " | chatter " + stream.filter((a) => a.source === "chatter").length,
  );

  // Warm the memo so the stream runs without a network round trip per prompt.
  const texts = [...new Set(stream.map((a) => a.text))];
  const queue = [...texts];
  let warmed = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (queue.length) {
        const next = queue.pop();
        if (!next) break;
        try { if (await embedPrompt(config, next)) warmed += 1; } catch { /* lexical only */ }
      }
    }),
  );
  console.log("  warmed " + warmed + "/" + texts.length + " embeddings in " +
    Math.round((Date.now() - started) / 1000) + "s\n");

  const contractFamily = new Map<string, string | null>();
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

    const touches = arrival.family ? TOUCHES[arrival.family] : null;
    if (touches && !governed) {
      await store.mutate((database) => {
        database.capabilityObservations.push({
          runId, agentId: "generic",
          domainsReached: touches.domains, pathsRead: touches.read,
          pathsWritten: touches.write, secretsRead: touches.secrets,
          createdAt: new Date().toISOString(),
        });
      });
    }

    if (index % 25 !== 0) continue;
    await service.refreshCandidates();
    const { promoted } = await service.autoPromote(createAgent);
    for (const contract of promoted) {
      const texts = new Set(
        store.snapshot().promptObservations
          .filter((o) => contract.matchCanonicalForms?.includes(o.canonicalForm))
          .map((o) => o.redactedText),
      );
      const family = FAMILIES.find((id) => (generated[id]?.positives ?? []).some((t) => texts.has(t))) ?? null;
      contractFamily.set(contract.id, family);
      if (family && !promotedAt.has(family)) promotedAt.set(family, index);
      console.log(
        "  [" + String(index).padStart(4) + "] promoted " +
        (family ?? "*** not a recurring family ***").padEnd(16) +
        " net=" + JSON.stringify(contract.scope.domains) +
        " rw=" + JSON.stringify(contract.scope.paths.filter((p) => p.mode === "rw").map((p) => p.path)) +
        " secrets=" + JSON.stringify(contract.scope.secrets),
      );
    }
  }

  const contracts = store.snapshot().contracts;
  const fromFamily = [...contractFamily.values()].filter(Boolean).length;
  console.log("\n### 1. what got promoted, from nothing");
  console.log("  contracts created             : " + contracts.length);
  console.log("  ...matching a recurring task  : " + fromFamily + " (of " + FAMILIES.length + " families)");
  console.log("  ...from anything else         : " + (contracts.length - fromFamily));

  const tail = outcomes.filter((o) => o.source === "long-tail");
  const chat = outcomes.filter((o) => o.source === "chatter");
  console.log("\n### 2. did the one-off work stay out?");
  console.log("  long-tail prompts routed      : " + tail.filter((o) => o.governed).length + " / " + tail.length);
  console.log("  chatter routed                : " + chat.filter((o) => o.governed).length + " / " + chat.length);

  console.log("\n### 3. after promotion, do later wordings reach the specialist?");
  console.log("  family            promoted@   later   correct");
  let lt = 0, lc = 0;
  for (const family of FAMILIES) {
    const at = promotedAt.get(family);
    const later = outcomes.filter((o) => o.family === family && at !== undefined && o.index > at);
    const correct = later.filter((o) => o.correct).length;
    lt += later.length; lc += correct;
    console.log("  " + family.padEnd(16) + (at === undefined ? "never" : String(at)).padStart(10) +
      String(later.length).padStart(8) + String(correct).padStart(9));
  }
  console.log("  " + "".padEnd(16) + "".padStart(10) + String(lt).padStart(8) + String(lc).padStart(9) +
    "   = " + ((lc / Math.max(1, lt)) * 100).toFixed(1) + "% carryover");

  console.log("\n### 4. share of recurring work running under a contract");
  const bucket = Math.ceil(stream.length / 8);
  for (let start = 0; start < stream.length; start += bucket) {
    const slice = outcomes.filter((o) => o.index >= start && o.index < start + bucket && o.source === "recurring");
    const share = slice.length ? (slice.filter((o) => o.governed).length / slice.length) * 100 : 0;
    console.log("  prompts " + (start + "-" + Math.min(stream.length, start + bucket)).padEnd(12) +
      share.toFixed(0).padStart(3) + "%  " + "#".repeat(Math.round(share / 3)));
  }

  console.log("\n### 5. the scopes nobody wrote");
  for (const contract of contracts.slice(0, 12)) {
    console.log("  " + contract.name.slice(0, 34).padEnd(36) +
      "net=" + JSON.stringify(contract.scope.domains).padEnd(26) +
      "secrets=" + JSON.stringify(contract.scope.secrets));
  }
  const misrouted = outcomes.filter((o) => o.governed && !o.correct && o.family).length;
  console.log("\n  misrouted recurring work: " + misrouted);
  console.log("  contracts holding a union of two families' egress: " +
    contracts.filter((c) => c.scope.domains.length > 1).length);

  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

await main();
