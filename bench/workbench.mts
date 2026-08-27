/**
 * Detection and routing, measured on WorkBench.
 *
 * 690 workplace tasks, 69 ground-truth families of exactly 10, all in the same
 * office vocabulary (email, calendar, CRM, analytics, project management). The
 * seeded corpus has 12 families that are easy to tell apart; this has 69 that
 * are not, and none of them were written by anyone on this project.
 *
 * Two numbers matter and they fail in opposite directions:
 *
 *   MERGE   two different families landing in one cluster. This is the one that
 *           matters: a merged cluster is one contract governing two tasks, and
 *           its scope is the union of what both needed. It is the exact thing
 *           "no contract ended up holding two families' egress" claims.
 *   MISROUTE a held-out phrasing reaching the wrong family's contract. Costs a
 *           wrong brief inside a narrower-than-ungoverned scope.
 *
 * Unmatched is not an error here. Routing fails open by design.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REPO = process.env.REPO ?? path.resolve(import.meta.dirname, "..");
const WB = process.env.WB ?? "./WorkBench/data/processed/tasks_and_outcomes";
// Clone once:  git clone --depth 1 https://github.com/olly-styles/WorkBench.git
const SEMANTIC = process.env.SEMANTIC !== "false";
const TRAIN = Number(process.env.TRAIN ?? 6);

const src = (f: string) => pathToFileURL(path.join(REPO, "apps/server/src", f)).href;
const { loadConfig } = await import(src("config.ts"));
const { JsonStore } = await import(src("store.ts"));
const { CodifyService } = await import(src("codify/service.ts"));

// ----------------------------------------------------------------- the corpus
interface Row { task: string; template: string; domains: string; file: string }

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}

const corpus: Row[] = [];
for (const file of readdirSync(WB).filter((f) => f.endsWith(".csv"))) {
  for (const r of parseCsv(readFileSync(path.join(WB, file), "utf8"))) {
    if (r.task && r.base_template) {
      corpus.push({ task: r.task, template: r.base_template, domains: r.domains ?? "", file });
    }
  }
}

const families = new Map<string, Row[]>();
for (const r of corpus) {
  if (!families.has(r.template)) families.set(r.template, []);
  families.get(r.template)!.push(r);
}
console.log(`corpus: ${corpus.length} tasks in ${families.size} families`);
console.log(`semantic channel: ${SEMANTIC ? "on" : "off"} · train ${TRAIN}/family\n`);

// ------------------------------------------------------------------- the run
const root = await mkdtemp(path.join(tmpdir(), "wb-"));
await mkdir(path.join(root, "data"), { recursive: true });
const config = loadConfig({
  NODE_ENV: "test",
  APP_DATA_DIR: path.join(root, "data"),
  AGENT_WORKSPACE_ROOT: path.join(root, "ws"),
  CODEX_HOME: path.join(root, "codex"),
  ARK_API_KEY: process.env.ARK_API_KEY,
  ARK_MODEL: process.env.ARK_MODEL,
  ARK_BASE_URL: process.env.ARK_BASE_URL,
  ...(SEMANTIC ? { CODIFY_SEMANTIC: "true", ARK_EMBED_MODEL: process.env.ARK_EMBED_MODEL } : {}),
  ...(process.env.CODIFY_SEMANTIC_THRESHOLD ? { CODIFY_SEMANTIC_THRESHOLD: process.env.CODIFY_SEMANTIC_THRESHOLD } : {}),
  ...(process.env.CODIFY_MATCH_THRESHOLD ? { CODIFY_MATCH_THRESHOLD: process.env.CODIFY_MATCH_THRESHOLD } : {}),
  ...(process.env.CODIFY_TIE_MARGIN ? { CODIFY_TIE_MARGIN: process.env.CODIFY_TIE_MARGIN } : {}),
  ...(process.env.CODIFY_CLUSTER_LINKAGE ? { CODIFY_CLUSTER_LINKAGE: process.env.CODIFY_CLUSTER_LINKAGE } : {}),
  CODIFY_LLM_DRAFTING: "false",   // deterministic briefs: this measures matching, not prose
  CODIFY_SEED_FIXTURES: "false",  // the seeded corpus would contaminate the families
});
const store = new JsonStore(path.join(root, "data", "db.json"));
const codify = new CodifyService(config, store);

const templateOfRun = new Map<string, string>();
let n = 0;
for (const [template, rows] of families) {
  for (const [i, row] of rows.slice(0, TRAIN).entries()) {
    const runId = "run-" + (n += 1);
    templateOfRun.set(runId, template);
    const red = codify.redactPrompt(row.task);
    await codify.recordPromptObservation({
      runId,
      agentId: "agent-general",
      // Round-robin over three people so every family clears the distinct-user
      // floor. Detection must not be able to fire on one person repeating.
      userId: "user-" + "abc"[i % 3],
      redactedText: red.redactedText ?? red.text ?? row.task,
      redactionHits: red.hits ?? [],
      promotionEligible: true,
    });
    const doms: string[] = JSON.parse((row.domains || "[]").replace(/'/g, '"'));
    await store.mutate((db: any) => {
      db.capabilityObservations.push({
        runId, agentId: "agent-general",
        domainsReached: doms.map((d) => d + ".internal"),
        pathsRead: doms.map((d) => d + "/data"),
        pathsWritten: doms.map((d) => d + "/out"),
        secretsRead: [], createdAt: new Date().toISOString(),
      });
    });
    if (n % 100 === 0) process.stdout.write(`  observed ${n}\r`);
  }
}
console.log(`observed ${n} prompts from ${families.size} families`);

const candidates = await codify.refreshCandidates();
console.log(`candidates: ${candidates.length}\n`);

// ------------------------------------------------------- clustering, measured
let pure = 0, merged = 0;
const mergedDetail: string[] = [];
const familyOfCandidate = new Map<string, string>();
// A merged cluster is derived from several families. Crediting only the first
// would score a probe as misrouted for reaching a contract built from its own
// runs, which is a flaw in the measurement rather than in the router.
const familiesOfCandidate = new Map<string, Set<string>>();
for (const c of candidates) {
  const templates = new Set(
    (c.exemplarRunIds ?? []).map((id: string) => templateOfRun.get(id)).filter(Boolean),
  );
  const [first] = [...templates];
  familyOfCandidate.set(c.id, first as string);
  familiesOfCandidate.set(c.id, templates as Set<string>);
  if (templates.size === 1) pure += 1;
  else {
    merged += 1;
    mergedDetail.push([...templates].map((t) => String(t).slice(0, 58)).join("\n      + "));
  }
}
console.log("CLUSTERING");
console.log(`  pure clusters (one family)   : ${pure}/${candidates.length}`);
console.log(`  MERGED (two or more families): ${merged}`);
for (const d of mergedDetail.slice(0, 6)) console.log("      " + d + "\n");

// ------------------------------------------------------- routing the held-out
const contractFamily = new Map<string, string>();
const contractFamilies = new Map<string, Set<string>>();
let promoted = 0;
for (const c of candidates) {
  try {
    const { contract } = await codify.approveCandidate(
      c.id, { userId: "operator" },
      async (a: { name: string }) => ({ id: "agent-" + (promoted += 1), name: a.name }),
    );
    contractFamily.set(contract.id, familyOfCandidate.get(c.id) ?? "?");
    contractFamilies.set(contract.id, familiesOfCandidate.get(c.id) ?? new Set());
  } catch { /* name collision or already decided */ }
}
console.log(`\ncontracts promoted: ${contractFamily.size}`);

let right = 0, wrong = 0, unmatched = 0, probes = 0, blended = 0;
const wrongDetail: string[] = [];
for (const [template, rows] of families) {
  for (const row of rows.slice(TRAIN)) {
    probes += 1;
    const red = codify.redactPrompt(row.task);
    const obs = await codify.recordPromptObservation({
      runId: "probe-" + probes, agentId: "agent-general", userId: "user-probe",
      redactedText: red.redactedText ?? red.text ?? row.task,
      redactionHits: red.hits ?? [], promotionEligible: false,
    });
    const result = codify.route({
      runId: "probe-" + probes, agentId: "agent-general", observation: obs, forceAdHoc: false,
    });
    const cid = result.decision?.contractId ?? result.contract?.id;
    if (!cid) unmatched += 1;
    else if (contractFamilies.get(cid)?.has(template)) {
      right += 1;
      // Reached a contract derived from its own family, but that contract also
      // covers others: the scope is sound, the brief is a blend.
      if ((contractFamilies.get(cid)?.size ?? 1) > 1) blended += 1;
    }
    else {
      wrong += 1;
      if (wrongDetail.length < 5) {
        wrongDetail.push(`  "${row.task.slice(0, 66)}"\n    → ${String(contractFamily.get(cid)).slice(0, 66)}`);
      }
    }
  }
}
// ------------------------------------------------- the containment claim
const domainsOfFamily = new Map<string, Set<string>>();
for (const [tpl, rows] of families) {
  const d = new Set<string>();
  for (const r of rows) for (const x of JSON.parse((r.domains || "[]").replace(/'/g, '"'))) d.add(x as string);
  domainsOfFamily.set(tpl, d);
}
let wider = 0;
const widerDetail: string[] = [];
for (const c of (store.snapshot() as any).contracts) {
  const fam = contractFamily.get(c.id);
  if (!fam) continue;
  const expected = domainsOfFamily.get(fam) ?? new Set<string>();
  const got = new Set((c.scope?.domains ?? []).map((h: string) => h.replace(".internal", "")));
  const extra = [...got].filter((h) => !expected.has(h as string));
  if (extra.length) {
    wider += 1;
    if (widerDetail.length < 8) {
      widerDetail.push("  " + String(fam).slice(0, 54) + " :: expected [" + [...expected] + "] got [" + [...got] + "]");
    }
  }
}
console.log("");
console.log("CONTAINMENT - does a contract hold capability its family never used?");
console.log("  contracts with a wider-than-observed scope: " + wider + "/" + contractFamily.size);
for (const d of widerDetail) console.log(d);

const governed = right + wrong;
console.log("\nROUTING (held-out phrasings)");
console.log(`  probes            : ${probes}`);
console.log(`  routed correctly  : ${right}`);
console.log(`  MISROUTED         : ${wrong}${governed ? "  (" + ((wrong / governed) * 100).toFixed(1) + "% of governed)" : ""}`);
console.log(`  unmatched (fails open, not an error): ${unmatched}`);
console.log(`  of the correct ones, on a BLENDED contract (right scope, mixed brief): ${blended}`);
for (const d of wrongDetail) console.log(d);

await rm(root, { recursive: true, force: true });
