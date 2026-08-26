/**
 * Mechanism ⑧ — cost and budget control.
 *
 * The Starter Kit's threat table names runaway execution and cost, with
 * timeouts, quotas, max steps and an administrative stop as the controls to
 * demonstrate. The baseline already records `RunUsage` on every Run and then
 * does nothing with it, which makes token spend observable but not bounded.
 *
 * This turns that record into a decision. A contract may carry a `TaskBudget`;
 * usage is recomputed from the Run history of its whole version lineage, and a
 * Run that would start over the ceiling is refused at the request boundary with
 * a `DenialEvent`, the same evidence an egress refusal produces.
 *
 * ## Where this binds, and where it does not
 *
 * Admission only. The control plane cannot interrupt a Codex turn part-way
 * without forking Codex, so a Run that is allowed to start is allowed to
 * finish — a single turn can overshoot `maxTokensPerRun` and still complete.
 * What the budget guarantees is that the *next* Run does not start. That bounds
 * a runaway loop, which is the failure mode this exists for, and it is stated
 * here rather than implied.
 *
 * Usage is derived, never accumulated in a counter: a counter and a history can
 * disagree, and when they do the counter is the one that silently keeps letting
 * runs through.
 */
import type { AgentRun } from "../types.js";
import type { BudgetDecision, BudgetUsage, TaskBudget, TaskContract } from "./types.js";

const EMPTY_USAGE: BudgetUsage = { totalTokens: 0, runs: 0, maxRunTokens: 0 };

/**
 * Tokens one Run reported. Zero when the Runtime gave no usage.
 *
 * `cachedInputTokens` is a subset of `inputTokens`, not an addition to it, so
 * adding it would double-count the cheapest part of the turn.
 */
export function runTokens(run: AgentRun): number {
  const usage = run.usage;
  if (!usage) return 0;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  return count(usage.inputTokens) + count(usage.outputTokens);
}

/**
 * Every contract id in a lineage, walking `supersedes` backwards.
 *
 * A budget follows the task, not the version. Otherwise revoking a domain —
 * which supersedes the contract with a narrower v2 — would silently reset the
 * spend to zero, and narrowing a scope would become the cheapest way to buy
 * more budget.
 */
export function contractLineage(contract: TaskContract, all: TaskContract[]): string[] {
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const lineage = new Set<string>([contract.id]);

  // Backwards, through the chain this contract superseded.
  let cursor: TaskContract | undefined = contract;
  while (cursor?.supersedes) {
    const previous: TaskContract | undefined = byId.get(cursor.supersedes);
    if (!previous || lineage.has(previous.id)) break;
    lineage.add(previous.id);
    cursor = previous;
  }
  // Forwards, in case the caller holds an older version than the active one.
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of all) {
      if (entry.supersedes && lineage.has(entry.supersedes) && !lineage.has(entry.id)) {
        lineage.add(entry.id);
        grew = true;
      }
    }
  }
  return [...lineage];
}

/** What a contract lineage has consumed, recomputed from Run history. */
export function usageForContract(
  contract: TaskContract,
  contracts: TaskContract[],
  runs: AgentRun[],
): BudgetUsage {
  const lineage = new Set(contractLineage(contract, contracts));
  let usage = { ...EMPTY_USAGE };
  for (const run of runs) {
    const contractId = run.codify?.contractId;
    if (!contractId || !lineage.has(contractId)) continue;
    // A queued or running Run counts towards `runs` the moment it is admitted,
    // so concurrent starts cannot both slip under a run ceiling.
    usage.runs += 1;
    const tokens = runTokens(run);
    usage.totalTokens += tokens;
    if (tokens > usage.maxRunTokens) usage.maxRunTokens = tokens;
  }
  return usage;
}

const format = (value: number): string => value.toLocaleString("en-US");

/**
 * Decide whether one more Run may start under this contract.
 *
 * Refusals name the limit and the observed value, because "budget exceeded" is
 * not something an operator can act on and "42,100 of 40,000 tokens" is.
 */
export function checkBudget(
  contract: TaskContract,
  contracts: TaskContract[],
  runs: AgentRun[],
): BudgetDecision {
  const usage = usageForContract(contract, contracts, runs);
  const budget: TaskBudget | undefined = contract.budget;
  if (!budget) return { allowed: true, usage };

  if (typeof budget.maxRuns === "number" && usage.runs >= budget.maxRuns) {
    return {
      allowed: false,
      usage,
      budget,
      reason:
        "Run limit reached: " +
        format(usage.runs) +
        " of " +
        format(budget.maxRuns) +
        " runs already admitted under this contract.",
    };
  }
  if (typeof budget.maxTotalTokens === "number" && usage.totalTokens >= budget.maxTotalTokens) {
    return {
      allowed: false,
      usage,
      budget,
      reason:
        "Token budget exhausted: " +
        format(usage.totalTokens) +
        " of " +
        format(budget.maxTotalTokens) +
        " tokens spent under this contract.",
    };
  }
  if (
    typeof budget.maxTokensPerRun === "number" &&
    usage.maxRunTokens > budget.maxTokensPerRun
  ) {
    return {
      allowed: false,
      usage,
      budget,
      reason:
        "A previous run spent " +
        format(usage.maxRunTokens) +
        " tokens against a per-run ceiling of " +
        format(budget.maxTokensPerRun) +
        ". Raise the ceiling or investigate the run before continuing.",
    };
  }
  return { allowed: true, usage, budget };
}

/**
 * Normalise a budget submitted by a reviewer.
 *
 * Returns `undefined` for an empty budget so "no limits" is stored as absence
 * rather than as an object full of nothing, which keeps the "absent means
 * unlimited" rule true in one place instead of at every read.
 */
export function normalizeBudget(budget: TaskBudget | undefined): TaskBudget | undefined {
  if (!budget) return undefined;
  const positive = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : undefined;
  const normalised: TaskBudget = {};
  const total = positive(budget.maxTotalTokens);
  const runs = positive(budget.maxRuns);
  const perRun = positive(budget.maxTokensPerRun);
  if (total !== undefined) normalised.maxTotalTokens = total;
  if (runs !== undefined) normalised.maxRuns = runs;
  if (perRun !== undefined) normalised.maxTokensPerRun = perRun;
  return Object.keys(normalised).length > 0 ? normalised : undefined;
}
