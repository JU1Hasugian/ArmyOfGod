import type {
  BrokerEvent,
  BrokerMode,
  CapabilityObservation,
  CapabilityScope,
  DenialEvent,
  FeedbackObservation,
  PromptObservation,
  RefinementProposal,
  RouteDecision,
  RouteOutcome,
  TaskCandidate,
  TaskContract,
  TraceSpan,
} from "./codify/types.js";
import type { CoordinationSession } from "./codify/coordination.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  /**
   * The Codex thread the *last* run used. Kept so a store written by an earlier
   * build still opens, and so `/api/agents` keeps its existing shape.
   */
  codexThreadId: string | null;
  /**
   * One Codex thread per principal, rather than one per Agent.
   *
   * A promoted specialist is shared by everyone routed to it, so a single
   * thread means one person's turn resumes another's conversation — and after
   * enough turns the Agent answers from that accumulated memory instead of
   * doing the work. That was measured, not theorised: a specialist with 26 runs
   * on one thread replied "Done, ./out/RELEASE.md has the release notes" and
   * wrote nothing, while a specialist with a fresh thread performed the
   * identical task correctly under the identical scope.
   */
  codexThreads?: Record<string, string>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

/** Codify evidence attached to a Run, denormalised so the UI needs one fetch. */
export interface RunCodifySummary {
  decision: RouteOutcome;
  brokerMode: BrokerMode;
  contractId?: string;
  contractVersion?: number;
  contractName?: string;
  score?: number;
  /** Which match channel carried the routing decision. */
  matchChannel?: "fingerprint" | "containment" | "semantic";
  scope?: CapabilityScope;
  denials: number;
  domainsReached: string[];
  /** Set when the turn was handed to a promoted specialist Agent. */
  delegatedFromAgentId?: string;
  delegatedFromAgentName?: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  /** Redacted at the request boundary. The raw prompt is never persisted. */
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  codify?: RunCodifySummary;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  promptObservations: PromptObservation[];
  capabilityObservations: CapabilityObservation[];
  candidates: TaskCandidate[];
  contracts: TaskContract[];
  routeDecisions: RouteDecision[];
  denialEvents: DenialEvent[];
  feedbackObservations: FeedbackObservation[];
  refinementProposals: RefinementProposal[];
  traceSpans: TraceSpan[];
  coordinationSessions: CoordinationSession[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

/** What the control plane hands the Runtime so it can enforce a scope. */
export interface RunnerScopeBinding {
  runId: string;
  mode: BrokerMode;
  scope: CapabilityScope;
  contractId?: string | undefined;
  contractVersion?: number | undefined;
}

/** Raw material for a CapabilityObservation, collected around one turn. */
export interface RunEvidence {
  brokerEvents: BrokerEvent[];
  pathsWritten: string[];
  pathsRead: string[];
  secretsGranted: string[];
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  /** The raw prompt. Only the redacted form is ever persisted. */
  prompt: string;
  threadId: string | null;
  codify?: RunnerScopeBinding | undefined;
  /**
   * Invoked once per turn, on success and on failure alike: a denied run is
   * exactly the one whose evidence matters most.
   */
  onEvidence?: ((evidence: RunEvidence) => void) | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
