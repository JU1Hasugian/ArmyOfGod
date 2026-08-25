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
}

export interface CapabilityScope {
  paths: { path: string; mode: "ro" | "rw" }[];
  domains: string[];
  secrets: string[];
}

export type RouteOutcome = "routed" | "unmatched" | "user_override";

export interface RunCodifySummary {
  decision: RouteOutcome;
  brokerMode: "observe" | "enforce";
  contractId?: string;
  contractVersion?: number;
  contractName?: string;
  score?: number;
  scope?: CapabilityScope;
  denials: number;
  domainsReached: string[];
  delegatedFromAgentId?: string;
  delegatedFromAgentName?: string;
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
  systemPrompt: string;
  refinements: string[];
  scope: CapabilityScope;
  status: "active" | "deprecated";
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
}
