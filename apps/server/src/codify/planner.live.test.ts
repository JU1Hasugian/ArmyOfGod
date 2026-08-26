/**
 * How well the planner actually splits, against a real Ark endpoint.
 *
 * Skipped unless `ARK_API_KEY` and `ARK_MODEL` are both present, like
 * `semantic.live.test.ts`: `npm run check` stays green on a reviewer's machine,
 * and a reviewer who supplies credentials gets the claim verified rather than
 * asserted.
 *
 * This is the one number in the project that rests on a model call whose output
 * is not otherwise checked against ground truth. Two things are measured, and
 * the second matters more than the first:
 *
 * 1. **Recall** — does a genuinely compound request get split, and does each
 *    fragment carry the task it came from?
 * 2. **False splits** — does an ordinary single-task request survive intact?
 *    A planner that shreds normal prompts is worse than no planner, because
 *    every fragment costs a container start and a model turn.
 *
 * Ground truth is constructed rather than judged: each compound probe is built
 * by concatenating two task descriptions this file wrote, so the correct split
 * is known before the model sees it, and a fragment is attributed by which of
 * the two it lexically overlaps more.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { canonicalize } from "./fingerprint.js";
import { planSteps } from "./planner.js";
import { containment } from "./semantic.js";

const LIVE = Boolean(process.env.ARK_API_KEY && process.env.ARK_MODEL);

function config() {
  return loadConfig({
    NODE_ENV: "development",
    ARK_API_KEY: process.env.ARK_API_KEY,
    ARK_MODEL: process.env.ARK_MODEL,
    ...(process.env.ARK_BASE_URL ? { ARK_BASE_URL: process.env.ARK_BASE_URL } : {}),
    CODIFY_PLANNER: "true",
    APP_DATA_DIR: process.env.APP_DATA_DIR ?? ".data-planner-live",
    RUNTIME_PROVIDER: "local-process",
  });
}

/** Workplace tasks that would plausibly belong to different specialists. */
const TASKS = {
  signups:
    "pull last month's signup numbers from the analytics warehouse and write them to ./out/signups.md as a markdown table",
  status:
    "write the weekly status update for the platform team from the notes in ./notes and save it to ./out/status.md",
  audit:
    "audit the dependencies in ./repo for known advisories and write the findings to ./reports/audit.md",
  release:
    "generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/RELEASE.md",
  email: "email the finished report to the board with a one-paragraph summary",
  invoice:
    "reconcile last month's invoice ledger in ./finance against the payment export and flag any mismatch",
} as const;

type TaskKey = keyof typeof TASKS;

/**
 * Compound probes, with the pair each was built from and whether the second
 * half genuinely needs the first. Two joiners are used, because "and" and
 * "then" are the two ways people actually write this and they carry different
 * dependency hints.
 */
const COMPOUND: { parts: [TaskKey, TaskKey]; text: string; sequential: boolean }[] = [
  { parts: ["signups", "email"], text: TASKS.signups + ", then " + TASKS.email, sequential: true },
  { parts: ["status", "email"], text: TASKS.status + " and then " + TASKS.email, sequential: true },
  { parts: ["release", "email"], text: TASKS.release + ", then " + TASKS.email, sequential: true },
  { parts: ["audit", "status"], text: TASKS.audit + " and " + TASKS.status, sequential: false },
  { parts: ["signups", "audit"], text: TASKS.signups + " and " + TASKS.audit, sequential: false },
  { parts: ["invoice", "status"], text: TASKS.invoice + " and " + TASKS.status, sequential: false },
  { parts: ["release", "audit"], text: TASKS.release + " and also " + TASKS.audit, sequential: false },
  { parts: ["signups", "status"], text: TASKS.signups + "; " + TASKS.status, sequential: false },
];

/** Single-task probes, including several written to look compound. */
const SINGLE: string[] = [
  TASKS.signups,
  TASKS.status,
  TASKS.audit,
  TASKS.release,
  TASKS.invoice,
  // Conjunctions inside one job. Each is one deliverable, however many clauses.
  "pull last month's signups broken down by acquisition channel and by region and write the result to ./out/signups.md",
  "review ./src/auth for missing input validation and inconsistent error handling and leave inline comments",
  "update the README so the install steps, the environment variables and the troubleshooting section all match the current config schema",
];

/** Which of two tasks a fragment came from, by lexical overlap. */
function attribute(fragment: string, parts: [TaskKey, TaskKey]): TaskKey | null {
  const canonicalFragment = canonicalize(fragment);
  const scores = parts.map((key) => containment(canonicalize(TASKS[key]), canonicalFragment));
  const [first, second] = scores as [number, number];
  if (Math.max(first, second) < 0.25) return null;
  return first === second ? null : parts[first > second ? 0 : 1];
}

describe.skipIf(!LIVE)("splitting a compound request, against a live Ark endpoint", () => {
  it("splits compound requests and keeps both halves", async () => {
    const settings = config();
    const results = await Promise.all(
      COMPOUND.map(async (probe) => ({ probe, steps: await planSteps(settings, probe.text) })),
    );

    const rows: string[] = [];
    let split = 0;
    let bothHalves = 0;
    let orderedCorrectly = 0;
    for (const { probe, steps } of results) {
      const didSplit = steps.length > 1;
      if (didSplit) split += 1;
      const attributed = steps.map((step) => attribute(step.text, probe.parts));
      const covered = new Set(attributed.filter(Boolean));
      const both = covered.size === 2;
      if (both) bothHalves += 1;
      // A sequential probe should produce at least one dependency; a parallel
      // one should produce none. This is the half a flat list cannot express.
      const dependencies = steps.reduce((total, step) => total + step.dependsOn.length, 0);
      const ordered = probe.sequential ? dependencies > 0 : dependencies === 0;
      if (ordered) orderedCorrectly += 1;
      rows.push(
        probe.parts.join("+").padEnd(18) +
          " steps=" +
          steps.length +
          " halves=" +
          (both ? "both" : [...covered].join(",") || "none") +
          " deps=" +
          dependencies +
          (ordered ? "" : "  <- ordering wrong"),
      );
    }
    console.log("\ncompound probes (" + COMPOUND.length + ")\n" + rows.join("\n"));
    console.log(
      "  split " + split + "/" + COMPOUND.length +
        " · both halves kept " + bothHalves + "/" + COMPOUND.length +
        " · ordering right " + orderedCorrectly + "/" + COMPOUND.length,
    );

    // A planner that splits fewer than most compound requests is not earning
    // its model call. These are floors, not targets — the printed table is the
    // measurement, and it belongs in docs/SEMANTIC-ROUTING.md §4d.
    expect(split).toBeGreaterThanOrEqual(Math.ceil(COMPOUND.length * 0.75));
    expect(bothHalves).toBeGreaterThanOrEqual(Math.ceil(COMPOUND.length * 0.75));
  }, 180_000);

  it("leaves a single task alone", async () => {
    const settings = config();
    const results = await Promise.all(
      SINGLE.map(async (text) => ({ text, steps: await planSteps(settings, text) })),
    );
    const falseSplits = results.filter((entry) => entry.steps.length > 1);
    for (const entry of falseSplits) {
      console.log(
        "false split: " + entry.text.slice(0, 70) + "…\n  -> " +
          entry.steps.map((step) => step.text).join("\n  -> "),
      );
    }
    console.log(
      "\nsingle-task probes (" + SINGLE.length + ") · false splits " +
        falseSplits.length + "/" + SINGLE.length,
    );

    // The asymmetry is deliberate. A missed split costs the second half its own
    // specialist; a false split costs a container start, a model turn, and a
    // request the user did not make.
    expect(falseSplits.length).toBeLessThanOrEqual(1);
  }, 180_000);
});
