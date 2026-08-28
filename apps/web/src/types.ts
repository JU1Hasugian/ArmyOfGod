export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  userId?: string;
  /** The specialist that ran this turn, when the conversation did not. */
  executedByAgentId?: string;
}

export interface CapabilityScope {
  paths: { path: string; mode: "ro" | "rw" }[];
  domains: string[];
  secrets: string[];
}

export type RouteOutcome =
  | "routed"
  | "principal_bound"
  | "unmatched"
  | "user_override";

/**
 * Which of the three match channels carried a routing decision. Shown in the
 * Playground because "matched at 0.71" is not reviewable on its own — a lexical
 * overlap and a semantic one mean different things.
 */
export type MatchChannel = "fingerprint" | "containment" | "semantic";

export interface RunCodifySummary {
  decision: RouteOutcome;
  brokerMode: "observe" | "enforce";
  contractId?: string;
  contractVersion?: number;
  contractName?: string;
  score?: number;
  matchChannel?: MatchChannel;
  scope?: CapabilityScope;
  denials: number;
  /** What was refused. Absent on runs recorded before it was captured. */
  deniedTargets?: { kind: string; target: string }[];
  domainsReached: string[];
  delegatedFromAgentId?: string;
  delegatedFromAgentName?: string;
  delegatedToAgentId?: string;
  delegatedToAgentName?: string;
}

export interface TaskCandidate {
  id: string;
  clusterKey: string;
  exemplarRunIds: string[];
  occurrences: number;
  distinctUsers: number;
  status: "pending" | "approved" | "rejected";
  proposedName: string;
  proposedPrompt: string;
  proposedScope: CapabilityScope;
  createdAt: string;
  updatedAt: string;
}

export interface RefinementProposal {
  id: string;
  contractId: string;
  contractVersion: number;
  exemplars: string[];
  exemplarRunIds: string[];
  occurrences: number;
  distinctUsers: number;
  proposedRule: string;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface TaskContract {
  id: string;
  version: number;
  name: string;
  agentId: string;
  matchFingerprints: string[];
  matchThreshold: number;
  containmentThreshold?: number;
  semanticThreshold?: number;
  systemPrompt: string;
  refinements: string[];
  scope: CapabilityScope;
  budget?: TaskBudget;
  status: "active" | "deprecated";
  reviewNote?: string;
  createdBy: string;
  createdAt: string;
  supersedes?: string;
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

export interface RouteDecision {
  id: string;
  runId: string;
  agentId: string;
  decision: RouteOutcome;
  contractId?: string;
  contractVersion?: number;
  score?: number;
  matchChannel?: MatchChannel;
  matchScores?: { fingerprint: number; containment: number; semantic: number };
  nearMatches?: { contractId: string; name: string; score: number; channel: string }[];
  brokerMode: "observe" | "enforce";
  reason: string;
  createdAt: string;
}

export interface EscalationProposal {
  contract: TaskContract;
  proposedScope: CapabilityScope;
  evidence: { target: string; kind: DenialEvent["kind"]; occurrences: number }[];
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
  codify?: RunCodifySummary;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  codifyEnabled?: boolean;
  codifyEnforcing?: boolean;
  codifyMatchThreshold?: number;
  codifyManagedSecrets?: string[];
  /** Who the backend resolved this request to, and whether they may decide. */
  principal?: string;
  isOperator?: boolean;
  operators?: string[];
}

/** A ceiling a reviewer set on one governed task. Absent fields are unlimited. */
export interface TaskBudget {
  maxTotalTokens?: number;
  maxRuns?: number;
  maxTokensPerRun?: number;
}

export interface BudgetUsage {
  totalTokens: number;
  runs: number;
  maxRunTokens: number;
}

export interface BudgetStatus {
  allowed: boolean;
  reason?: string;
  usage: BudgetUsage;
  budget?: TaskBudget;
}

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
  attributes?: Record<string, string | number | boolean>;
}

export interface RunTrace {
  traceId: string;
  runId: string;
  agentId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  spanCount: number;
  denied: number;
  errored: number;
  spans: TraceSpan[];
}

/** One fragment of a split request, when the session came from one. */
export interface PlannedStep {
  text: string;
  /** Indices of earlier steps whose output this one needs. */
  dependsOn: number[];
}

/** One step of a shared session, and who took it. */
export interface SessionTurn {
  index: number;
  /** Which step of the plan this turn executes, on a plan-backed session. */
  stepIndex?: number;
  claimedAt: string;
  agentId: string;
  agentName: string;
  contractId?: string;
  contractName?: string;
  selection: string;
  instruction: string;
  runId?: string;
  output?: string;
  error?: string;
  status: "claimed" | "completed" | "failed";
  completedAt?: string;
}

export interface CoordinationSession {
  id: string;
  topic: string;
  goal: string;
  createdBy: string;
  participantAgentIds: string[];
  /** Fixed steps, when the session came from splitting one compound request. */
  plan?: PlannedStep[];
  /** Where a step goes when nothing recognises it: the general Agent. */
  fallbackAgentId?: string;
  turns: SessionTurn[];
  state: Record<string, string>;
  maxTurns: number;
  status: "active" | "completed" | "stopped" | "failed";
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
}
