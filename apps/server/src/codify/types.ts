/**
 * Codify record types.
 *
 * These are the contracts between Codify's five mechanisms. They are additive:
 * nothing here replaces an existing Starter Kit type, and every one of them is
 * persisted in the same `JsonStore` the baseline already uses.
 */

/** What a governed task is permitted to touch. The extensible core contract. */
export interface CapabilityScope {
  /** Workspace-relative subpaths and their mount mode. */
  paths: { path: string; mode: "ro" | "rw" }[];
  /** CONNECT-host allowlist. Supports `example.com` and `*.example.com`. */
  domains: string[];
  /** Names of environment variables the Runtime may receive. Never values. */
  secrets: string[];
}

export type BrokerMode = "observe" | "enforce";

export interface PromptObservation {
  id: string;
  runId: string;
  agentId: string;
  userId: string;
  /** Redacted at the request boundary. Raw prompt text is never persisted. */
  redactedText: string;
  canonicalForm: string;
  fingerprint: string;
  /**
   * Packed embedding of the canonical form, when the semantic channel was
   * available. Optional throughout: an observation recorded while the embedding
   * endpoint was unset or unreachable simply has no semantic channel, and every
   * consumer falls back to the lexical ones.
   */
  embedding?: string;
  /** Names of the redaction rules that fired. Never the matched values. */
  redactionHits: string[];
  promotionEligible: boolean;
  createdAt: string;
}

export interface CapabilityObservation {
  runId: string;
  agentId: string;
  domainsReached: string[];
  pathsRead: string[];
  pathsWritten: string[];
  secretsRead: string[];
  createdAt: string;
}

export type CandidateStatus = "pending" | "approved" | "rejected";

export interface TaskCandidate {
  id: string;
  clusterKey: string;
  exemplarRunIds: string[];
  occurrences: number;
  distinctUsers: number;
  status: CandidateStatus;
  proposedName: string;
  proposedPrompt: string;
  proposedScope: CapabilityScope;
  createdAt: string;
  updatedAt: string;
}

/**
 * A follow-up correction a user made after seeing a governed Agent's output.
 *
 * "make it more colourful", "use bullet points", "add the metrics table" — a
 * single one of these is a preference. The same one from several people is a
 * defect in the brief, and that is what Codify harvests.
 */
export interface FeedbackObservation {
  id: string;
  runId: string;
  agentId: string;
  contractId: string;
  contractVersion: number;
  userId: string;
  /** Redacted at the request boundary like any other prompt. */
  redactedText: string;
  canonicalForm: string;
  fingerprint: string;
  embedding?: string;
  createdAt: string;
}

/**
 * A proposed amendment to a contract's brief, raised once enough distinct
 * people have asked for the same thing. Approved by a human, never applied
 * automatically — the same gate promotion goes through.
 */
export interface RefinementProposal {
  id: string;
  contractId: string;
  contractVersion: number;
  /** Redacted exemplars of the correction, for the reviewer to read. */
  exemplars: string[];
  exemplarRunIds: string[];
  occurrences: number;
  distinctUsers: number;
  /** The instruction this would add to the brief. */
  proposedRule: string;
  /**
   * What the guard said, when the rule was applied without a person.
   *
   * Mirrors `TaskContract.reviewNote` and exists for the same reason:
   * "applied automatically" is not something an operator can check, and the
   * reasoning is. Absent on a proposal a human decided.
   */
  reviewNote?: string;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  updatedAt: string;
}

/**
 * A ceiling on what one governed task may consume.
 *
 * Enforced at *admission*, not mid-turn: the control plane cannot interrupt a
 * Codex turn part-way without forking Codex, so a run that is allowed to start
 * is allowed to finish. What the budget guarantees is that the run after the
 * one that broke the ceiling does not start. That is enough to bound a runaway
 * loop, which is the failure this exists for, and the limitation is stated
 * rather than papered over.
 *
 * Every field is optional; an absent field is not a limit of zero, it is no
 * limit at all.
 */
export interface TaskBudget {
  // `| undefined` is explicit because the project runs with
  // `exactOptionalPropertyTypes`, and these arrive from a Zod schema whose
  // `.optional()` produces the key with an undefined value rather than omitting
  // it. `normalizeBudget` strips those before anything is stored.
  /** Cumulative tokens across every run governed by this contract lineage. */
  maxTotalTokens?: number | undefined;
  /** Runs admitted under this contract lineage. */
  maxRuns?: number | undefined;
  /**
   * Tokens one run may report before the *next* run is refused. A single turn
   * that blows past this still completes; it just spends the budget.
   */
  maxTokensPerRun?: number | undefined;
}

/** What a contract has actually consumed, recomputed from run history. */
export interface BudgetUsage {
  totalTokens: number;
  runs: number;
  maxRunTokens: number;
}

export interface BudgetDecision {
  allowed: boolean;
  /** Populated only when refused; names the limit and the observed value. */
  reason?: string;
  usage: BudgetUsage;
  budget?: TaskBudget;
}

/**
 * One node of a Run's trace.
 *
 * Spans are the same records the platform already produced — a routing
 * decision, a broker start, an egress refusal — given a shared `traceId`, a
 * parent, and a duration, so a Run reads as a connected sequence rather than
 * unrelated logs. Nothing here is a second source of truth: a span carries the
 * id of the record it describes.
 */
export type SpanCategory =
  | "orchestration"
  | "policy_decision"
  | "budget_check"
  | "delegation"
  | "sandbox_execution"
  | "model_call"
  | "egress"
  | "workspace";

export interface TraceSpan {
  id: string;
  traceId: string;
  runId: string;
  agentId: string;
  parentId?: string;
  name: string;
  category: SpanCategory;
  status: "ok" | "denied" | "error";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /**
   * Small, already-redacted key/values. Never a payload: the trace is stored
   * and displayed, so anything that could carry a secret stays out of it.
   */
  attributes?: Record<string, string | number | boolean>;
}

export interface TaskContract {
  id: string;
  version: number;
  name: string;
  /** The canonical Agent created at promotion time, for provenance. */
  agentId: string;
  matchFingerprints: string[];
  /**
   * Canonical forms of the exemplars, positionally aligned with
   * `matchFingerprints`. The containment channel needs the shingles themselves,
   * which a MinHash signature cannot give back.
   */
  matchCanonicalForms?: string[];
  /** Packed exemplar embeddings, positionally aligned. Absent entries are skipped. */
  matchEmbeddings?: (string | undefined)[];
  matchThreshold: number;
  /** Per-channel thresholds this contract was promoted under. */
  containmentThreshold?: number;
  semanticThreshold?: number;
  systemPrompt: string;
  /**
   * Rules folded in from repeated user corrections, newest last. Kept separate
   * from `systemPrompt` so the reviewer can see what the task was promoted with
   * and what usage has since taught it.
   */
  refinements: string[];
  scope: CapabilityScope;
  /** Absent means unlimited, which is the behaviour every earlier contract has. */
  budget?: TaskBudget;
  status: "active" | "deprecated";
  /**
   * What the reviewer said when this was promoted without a person. Stored so
   * oversight is exercisable rather than nominal: "promoted automatically" is
   * not something an operator can check, and the reviewer's actual reasoning is.
   * Absent on contracts a human approved.
   */
  reviewNote?: string;
  createdBy: string;
  createdAt: string;
  supersedes?: string;
}

/**
 * `principal_bound` is the outcome that closes the fail-open hole.
 *
 * `routed` binds a scope because the *prompt* matched, and the prompt is
 * written by the caller. `principal_bound` binds one because of *who is
 * executing* — a promoted specialist carries its contract's scope whatever it
 * is asked, and the platform assigns the Agent, not the caller. Evading the
 * matcher no longer buys capability, only the loss of the brief.
 */
export type RouteOutcome =
  | "routed"
  | "principal_bound"
  | "unmatched"
  | "user_override";

export interface RouteDecision {
  id: string;
  runId: string;
  agentId: string;
  decision: RouteOutcome;
  contractId?: string;
  contractVersion?: number;
  score?: number;
  /**
   * Which channel carried the decision. Recorded because "matched at 0.71" is
   * not reviewable on its own — a reviewer needs to know whether that was a
   * lexical overlap or a semantic one.
   */
  matchChannel?: "fingerprint" | "containment" | "semantic";
  /** Every channel's score, so a near miss is visible in the audit record. */
  matchScores?: { fingerprint: number; containment: number; semantic: number };
  /**
   * Contracts that scored close to their threshold without clearing it.
   *
   * The distinction this exists to draw is between "nothing here is familiar"
   * and "parts of this are familiar" — currently both land as `unmatched` and
   * both run ungoverned, which is backwards. A prompt combining a governed task
   * with a second one scores below every line, because compounding weakens both
   * channels at once: containment collapses (the exemplar's shingles are not
   * present verbatim in a reworded half) and the embedding dilutes (the prompt
   * sits between two contracts). Measured at containment 0.22 / semantic 0.66
   * against lines of 0.60 and 0.72.
   *
   * The consequence is perverse and is the reason this is recorded: the *less*
   * recognisable a request, the *more* capability it receives.
   */
  nearMatches?: { contractId: string; name: string; score: number; channel: string }[];
  /**
   * The plan-backed session this turn became, when the request asked for
   * several things. The turn itself produces no run: each step does.
   */
  splitSessionId?: string;
  brokerMode: BrokerMode;
  reason: string;
  createdAt: string;
}

export interface DenialEvent {
  id: string;
  runId: string;
  agentId: string;
  contractId?: string;
  contractVersion?: number;
  kind: "egress" | "path" | "secret" | "budget";
  target: string;
  reason: string;
  outcome: "blocked";
  at: string;
}

/** One line of the broker's append-only JSONL evidence file. */
export interface BrokerEvent {
  runId: string;
  at: string;
  type: "broker_started" | "egress" | "denial" | "model_call";
  host?: string;
  port?: number;
  decision?: string;
  kind?: DenialEvent["kind"];
  target?: string;
  reason?: string;
  status?: number;
  mode?: BrokerMode;
  allowlist?: string[];
  error?: string;
}
