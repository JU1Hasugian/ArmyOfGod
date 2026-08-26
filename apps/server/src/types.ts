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
  /**
   * The human principal this turn belongs to.
   *
   * A specialist is one Agent that everybody routes to, so a transcript keyed
   * by Agent alone shows every principal's conversation to every principal.
   * Optional because a store written before this field existed has none, and
   * those records stay visible to everyone rather than disappearing.
   */
  userId?: string;
  /**
   * The Agent that actually ran this turn, when it is not the one the message
   * is filed under.
   *
   * `agentId` is the *conversation* — where the person typed. This is the
   * *execution* — the specialist the platform routed the work to. They were the
   * same field once, which meant a delegated turn was filed in the specialist's
   * transcript and vanished from the conversation it was typed into. Absent
   * when the conversation agent ran the turn itself.
   */
  executedByAgentId?: string;
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
  /**
   * Set when the turn was handed to a promoted specialist Agent.
   *
   * Both ends are recorded because the conversation no longer moves: the
   * reader stays in the Agent they typed at, so a message naming only the
   * origin cannot say where the work went.
   */
  delegatedFromAgentId?: string;
  delegatedFromAgentName?: string;
  delegatedToAgentId?: string;
  delegatedToAgentName?: string;
}

export interface AgentRun {
  id: string;
  /**
   * The conversation this run answers, when it is not the Agent that ran it.
   *
   * `agentId` is the specialist that executed the turn — its workspace, its
   * scope, its budget lineage. But the person typed somewhere else, and the
   * transcript they are reading has to be able to find the evidence for its
   * own turns. Without this, reopening a conversation showed the newest run
   * *that Agent* happened to own, which after a delegation is some older
   * ungoverned turn: a governed answer captioned "no contract matched".
   */
  conversationAgentId?: string;
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
  /**
   * Writes the kernel refused, because the path was outside the contract's
   * writable set.
   *
   * Egress denials arrive from the broker, which is a process that can be asked
   * what it blocked. The filesystem boundary has no such process: the workspace
   * is mounted read-only, a write to it fails with `EROFS`, and the refusal is
   * over before anything in this codebase could observe it. The enforcement was
   * real and the evidence was missing — the governance view showed a task
   * blocked from writing outside its scope as though nothing had happened.
   *
   * So the refusal is read back out of the command output that reported it.
   * That is a weaker signal than the broker's own log and is treated as one:
   * it is evidence *that* a write was refused, never an authority on what the
   * task intended.
   */
  pathsRefused: string[];
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
