/**
 * Mechanism ⑩ — splitting one request that contains several tasks.
 *
 * ## The hole this closes
 *
 * *"Pull last month's signups into ./out/signups.md and email it to the board"*
 * is two jobs. `route()` scores the whole prompt against every contract and
 * takes the single best match, so today one specialist receives both halves —
 * or, worse, neither does.
 *
 * Measured: a compound prompt containing a governed task scored **containment
 * 0.22 / semantic 0.66** against lines of 0.60 and 0.72, and ran `unmatched`.
 * Compounding weakens both channels at once, which no other evasion does:
 * containment collapses because a reworded half does not contain the exemplar's
 * shingles verbatim, and the embedding dilutes because the prompt now sits
 * between two contracts. The result is perverse — the *less* recognisable the
 * request, the *more* capability it gets, because an unmatched turn runs ad hoc
 * with an unrestricted network.
 *
 * Splitting fixes the direction of that. The recognised fragment runs under its
 * contract's scope; the unrecognised one runs where any novel work runs, on the
 * general Agent — and is *recorded as an observation*, so once enough people ask
 * for it, it is detected, promoted, and gets a scope of its own. The system
 * learns the missing specialist from its own leftovers.
 *
 * ## Why a dependency graph and not a list
 *
 * "Email **it**" needs the report. "Audit the dependencies" and "write the
 * status update" need nothing from each other. A flat list forces everything to
 * be sequential; a graph lets independent fragments run at once and only orders
 * what genuinely has to be ordered.
 *
 * ## What this deliberately does not do
 *
 * It does not decide capability. Each fragment is routed on its own merits
 * afterwards, so a bad split produces a badly-scoped *fragment*, never a merged
 * scope. The union of two contracts is not reachable through this path.
 */
import type { AppConfig } from "../config.js";
import { complete } from "./ark-client.js";

export interface PlannedStep {
  /** The fragment, as a standalone request. */
  text: string;
  /**
   * Indices of earlier steps whose output this one needs. Empty means it can
   * start immediately, and steps with disjoint dependencies can run together.
   */
  dependsOn: number[];
}

/** The most fragments one prompt may be split into. */
const MAX_STEPS = 5;

const INSTRUCTION = [
  "You split a workplace request into the separate pieces of work it asks for.",
  "",
  "Rules:",
  "- If the request asks for ONE piece of work, return it unchanged as a single",
  "  step. Most requests are one step. Do not invent structure that is not there.",
  "- Split only where the request genuinely asks for distinct jobs that a",
  "  different person or tool would do — producing a document, then sending it",
  "  somewhere, are two.",
  "- Each step must stand alone. Replace pronouns with what they refer to, so",
  '  "email it to the board" becomes "email the signups report to the board".',
  "- Preserve file paths, names, versions and destinations exactly.",
  "- Mark a step as depending on an earlier one ONLY when it needs that step's",
  "  output. Steps that merely happen to be mentioned together do not depend on",
  "  each other, and should be able to run at the same time.",
  "",
  "Reply with one line per step and nothing else, in this exact form:",
  "STEP <n> AFTER <comma-separated earlier step numbers, or NONE>: <the request>",
].join("\n");

const STEP_LINE = /^\s*STEP\s+(\d+)\s+AFTER\s+([^:]+):\s*(.+)$/i;

/**
 * Split a prompt into steps, or return a single step when it is one job.
 *
 * Falls back to one step for anything it cannot parse, an unreachable model, or
 * a result that fails its own consistency checks. That fallback is the current
 * behaviour, so a planner that misbehaves costs the split and nothing else.
 */
export async function planSteps(config: AppConfig, prompt: string): Promise<PlannedStep[]> {
  const raw = await complete(config, INSTRUCTION, prompt, config.codifyPlannerEnabled);
  return parsePlan(raw, prompt);
}

/**
 * Turn the model's reply into a plan, or into the single-step fallback.
 *
 * Separated from the call so every rejection rule below is testable without a
 * network — the rules are the part that has to be right.
 */
export function parsePlan(raw: string | null, prompt: string): PlannedStep[] {
  const single = [{ text: prompt, dependsOn: [] }];
  if (!raw) return single;

  const parsed: { index: number; after: number[]; text: string }[] = [];
  for (const line of raw.split("\n")) {
    const match = STEP_LINE.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    const afterRaw = (match[2] ?? "").trim();
    const text = (match[3] ?? "").trim();
    if (!Number.isInteger(index) || index < 1 || !text) continue;
    const after = /^none$/i.test(afterRaw)
      ? []
      : afterRaw
          .split(",")
          .map((entry) => Number(entry.trim()))
          .filter((value) => Number.isInteger(value) && value >= 1);
    parsed.push({ index, after, text });
  }

  parsed.sort((left, right) => left.index - right.index);
  if (parsed.length === 0 || parsed.length > MAX_STEPS) return single;
  // The numbering has to be 1..n with no gaps, or the dependency indices mean
  // something other than what they appear to.
  if (parsed.some((entry, position) => entry.index !== position + 1)) return single;

  const steps: PlannedStep[] = parsed.map((entry, position) => ({
    text: entry.text,
    // A dependency may only point *backwards*, which makes cycles impossible by
    // construction rather than by checking for them.
    dependsOn: [...new Set(entry.after)]
      .map((value) => value - 1)
      .filter((value) => value >= 0 && value < position),
  }));

  // A "split" that reproduces the original is not a split; treat it as one job
  // so the caller takes the ordinary path.
  if (steps.length === 1) return single;
  // Guard against a plan that dropped most of the request. Fragments should
  // account for the bulk of what was asked, allowing for pronouns being
  // expanded and connectives dropped.
  const planned = steps.reduce((total, step) => total + step.text.length, 0);
  if (planned < prompt.length * 0.5) return single;
  return steps;
}

/**
 * The steps that can start now: everything whose dependencies are all done.
 *
 * Returned as a group rather than one at a time, because independent fragments
 * have no reason to wait for each other. The caller still has to respect the
 * one-active-run-per-Agent rule, so two steps routed to the *same* specialist
 * cannot actually overlap however this answers.
 */
export function readySteps(steps: PlannedStep[], completed: ReadonlySet<number>): number[] {
  const ready: number[] = [];
  for (const [index, step] of steps.entries()) {
    if (completed.has(index)) continue;
    if (step.dependsOn.every((dependency) => completed.has(dependency))) ready.push(index);
  }
  return ready;
}

/**
 * Group the plan into waves — each wave is a set of steps that may run together.
 *
 * Purely a description of the plan's shape, useful for showing someone what is
 * about to happen before it happens, and for asserting in tests that a plan is
 * as parallel as it claims.
 */
export function waves(steps: PlannedStep[]): number[][] {
  const done = new Set<number>();
  const out: number[][] = [];
  while (done.size < steps.length) {
    const wave = readySteps(steps, done);
    // A plan whose dependencies only point backwards can always make progress;
    // this is a guard against a malformed one looping forever.
    if (wave.length === 0) break;
    out.push(wave);
    for (const index of wave) done.add(index);
  }
  return out;
}
