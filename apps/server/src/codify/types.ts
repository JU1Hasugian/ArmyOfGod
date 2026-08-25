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
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface TaskContract {
  id: string;
  version: number;
  name: string;
  /** The canonical Agent created at promotion time, for provenance. */
  agentId: string;
  matchFingerprints: string[];
  matchThreshold: number;
  systemPrompt: string;
  /**
   * Rules folded in from repeated user corrections, newest last. Kept separate
   * from `systemPrompt` so the reviewer can see what the task was promoted with
   * and what usage has since taught it.
   */
  refinements: string[];
  scope: CapabilityScope;
  status: "active" | "deprecated";
  createdBy: string;
  createdAt: string;
  supersedes?: string;
}

export type RouteOutcome = "routed" | "unmatched" | "user_override";

export interface RouteDecision {
  id: string;
  runId: string;
  agentId: string;
  decision: RouteOutcome;
  contractId?: string;
  contractVersion?: number;
  score?: number;
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
  kind: "egress" | "path" | "secret";
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
