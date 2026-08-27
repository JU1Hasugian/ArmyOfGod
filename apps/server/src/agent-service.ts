import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { agentCodexHome, isArkConfigured, isCodifyActive } from "./config.js";
import { reapOrphanedBrokers } from "./codify/broker-session.js";
import { RunTracer } from "./codify/trace.js";
import { waves } from "./codify/planner.js";
import { looksLikeFollowUp } from "./codify/continuity.js";
import type { CoordinationSession } from "./codify/coordination.js";
import type { CodifyService } from "./codify/service.js";
import type { CapabilityScope, RouteDecision, TaskContract } from "./codify/types.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunCodifySummary,
  RunEvidence,
  RunnerScopeBinding,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/**
 * Which Codex thread this turn should continue, if any.
 *
 * Two decisions, and the second is the one that fixes a measured bug.
 *
 * **Per principal.** A promoted specialist is shared by everyone routed to it,
 * so a single thread per Agent means one person's turn resumes another's
 * conversation and runs against their context. Threads are keyed by the
 * principal instead.
 *
 * **A recognised task starts fresh.** When routing matches a contract, this
 * turn is a *new instance of the task*, not a continuation of the last one —
 * so it gets a new thread. Resuming there is actively harmful: a specialist
 * carrying 26 turns of history replied "Done, `./out/RELEASE.md` has the
 * release notes" and wrote nothing, answering from memory of having done it
 * before, while the same task under the same scope on a fresh thread ran
 * correctly. Continuity is a liability for a repeated job.
 *
 * Everything else resumes: a follow-up that does *not* match the contract is a
 * correction to what just came back, and that genuinely needs the context.
 * Ordinary chat with a generic Agent is unaffected.
 */
function resumeThread(
  agent: Agent,
  userId: string,
  decision: RouteDecision | undefined,
): string | null {
  if (decision?.decision === "routed") return null;
  const perPrincipal = agent.codexThreads?.[userId];
  if (perPrincipal) return perPrincipal;
  // A store written before threads were per-principal has one shared thread.
  // Honour it for the principal who arrives first rather than discarding the
  // conversation, and it becomes theirs from then on.
  return agent.codexThreads ? null : agent.codexThreadId;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    readonly codify: CodifyService,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    // A crash or a hard stop can leave a broker container and its network
    // behind. Reap them before serving, so a stale allowlist can never govern
    // a new run and orphaned networks do not accumulate.
    if (isCodifyActive(this.config)) {
      await reapOrphanedBrokers(
        this.config.containerEngine,
        this.config.runtimeInstanceId,
        process.env,
      );
    }
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    // The workspace is archived; the Codex home holds session transcripts and
    // is deleted outright. Stating which state survives a delete is the point.
    await rm(agentCodexHome(this.config, id), { recursive: true, force: true }).catch(
      () => undefined,
    );
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      // Codify evidence is retained deliberately: an audit record that
      // disappears when its subject is deleted is not an audit record. It
      // already holds only redacted text.
      database.contracts = database.contracts.map((contract) =>
        contract.agentId === id ? { ...contract, status: "deprecated" as const } : contract,
      );
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  /**
   * The transcript one principal may see on one Agent.
   *
   * Keyed by principal, not by Agent, because a promoted specialist is a single
   * Agent that everybody routes to: filtering on `agentId` alone hands every
   * caller everyone else's conversation. This mirrors `resumeThread`, which
   * already keys the Codex session by principal — the displayed transcript and
   * the session the model actually sees must agree, or the page shows a
   * conversation the model was never part of.
   *
   * A record written before `userId` existed has none, and stays visible to
   * everyone rather than vanishing from the history that already displayed it.
   */
  /**
   * The Agent that answered this principal's most recent turn in this
   * conversation, when it was not the conversation's own Agent.
   *
   * Read from the transcript rather than held as a cursor: a cursor and a
   * history can disagree, and only the history survives a restart.
   */
  private lastResponder(conversationAgentId: string, userId: string): Agent | null {
    const database = this.store.snapshot();
    const previous = [...database.messages]
      .filter(
        (message) =>
          message.agentId === conversationAgentId &&
          message.role === "assistant" &&
          (message.userId === undefined || message.userId === userId) &&
          message.executedByAgentId !== undefined,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!previous?.executedByAgentId) return null;
    return database.agents.find((agent) => agent.id === previous.executedByAgentId) ?? null;
  }

  /**
   * The workspace as it stands, so a reviewer can look at the artefact.
   *
   * Not scoped by principal: a workspace is per-Agent, and everyone routed to a
   * specialist shares it. What is per-principal is the *conversation*, which is
   * why `getMessages` takes a userId and this does not.
   */
  async listWorkspace(agentId: string, userId: string) {
    this.getAgent(agentId);
    // Scoped to the caller, like the transcript. A principal who has not run
    // yet has no workspace, and an empty listing is the honest answer.
    return { files: await this.workspaces.list(this.workspaces.workspacePathFor(agentId, userId)) };
  }

  async readWorkspaceFile(agentId: string, userId: string, relative: string) {
    this.getAgent(agentId);
    try {
      return await this.workspaces.read(
        this.workspaces.workspacePathFor(agentId, userId),
        relative,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A traversal attempt and a typo both end here; neither is a server fault.
      // Neither is told where the workspace lives either: an `ENOENT` carries
      // the absolute path, and handing the caller the server's directory layout
      // is a disclosure this project has no reason to make.
      if (message.includes("outside")) throw new HttpError(400, message);
      throw new HttpError(404, "No such file in this workspace: " + relative);
    }
  }

  getMessages(agentId: string, userId?: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter(
        (message) =>
          message.agentId === agentId &&
          (userId === undefined ||
            message.userId === undefined ||
            message.userId === userId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * Start this principal's conversation over, on one Agent.
   *
   * A long Codex thread degrades in a way that reads as success: a specialist
   * carrying twenty-six turns reported writing a file it had not written, five
   * times running, because it was answering from the memory of having done the
   * task before. Routing already starts a recognised task on a fresh thread for
   * exactly that reason, but an operator sitting in one conversation had no way
   * to say "start over" short of deleting the Agent.
   *
   * What this does NOT touch is the point. Observations, contracts, denials,
   * spans and feedback are records of what *ran*; they are keyed by run, not by
   * thread, and clearing a transcript does not un-run the work behind them. So
   * a reset never changes a promotion decision, and it is not itself a prompt —
   * nothing here writes a `PromptObservation`.
   *
   * The thread and the transcript are cleared together on purpose: leaving the
   * messages would show a conversation the model is no longer in, which is the
   * defect `getMessages` was keyed by principal to fix.
   */
  async resetSession(agentId: string, userId: string): Promise<{ agent: Agent; clearedMessages: number }> {
    const agent = this.getAgent(agentId);
    if (agent.status === "busy") {
      throw new HttpError(409, "This Agent is running; stop or await the run before resetting");
    }

    let clearedMessages = 0;
    const updated = await this.store.mutate((database) => {
      const stored = database.agents.find((entry) => entry.id === agentId);
      if (!stored) throw new HttpError(404, "Agent not found");

      if (stored.codexThreads) {
        delete stored.codexThreads[userId];
      } else {
        // A store written before threads were keyed by principal holds one
        // shared thread, adopted by whoever arrived first. Clearing it here is
        // the only reading available: there is nothing recording whose it was.
        stored.codexThreadId = null;
      }

      const before = database.messages.length;
      // Only messages explicitly stamped with this principal. A legacy record
      // carries no `userId` and is visible to everyone, so deleting it here
      // would be one principal erasing another's history.
      database.messages = database.messages.filter(
        (message) => !(message.agentId === agentId && message.userId === userId),
      );
      clearedMessages = before - database.messages.length;

      return structuredClone(stored);
    });

    return { agent: updated, clearedMessages };
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  /**
   * Runs this Agent executed, plus runs answering this Agent's conversation.
   *
   * Both, because delegation separates the two: the specialist owns the run,
   * the desk owns the thread it belongs to, and each view needs to see it.
   */
  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter(
        (run) =>
          run.agentId === agentId ||
          run.conversationAgentId === agentId ||
          // A run written before `conversationAgentId` existed still records
          // where the turn came from, on the delegation summary. Honour it
          // rather than losing the evidence for conversations already on disk.
          (run.conversationAgentId === undefined &&
            run.codify?.delegatedFromAgentId === agentId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    options: { userId?: string; forceAdHoc?: boolean; skipPlanner?: boolean } = {},
  ): Promise<{
    run: AgentRun;
    message: Message;
    delegatedTo?: Agent;
    session?: CoordinationSession;
  }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    // The addressed Agent must exist and be runnable before anything else, so
    // an unknown or stopped Agent still fails the way it always did.
    const addressed = this.getAgent(agentId);
    if (addressed.status === "stopped") {
      throw new HttpError(409, "Start the Agent before sending a message");
    }

    const timestamp = now();
    const runId = randomUUID();
    const userId = options.userId ?? this.config.codifyDefaultUser;
    // One trace per turn, opened before the first decision so the routing and
    // budget checks are inside it rather than alongside it.
    const tracer = new RunTracer(this.store, randomUUID(), runId, agentId);
    const turn = tracer.open({
      name: "turn",
      category: "orchestration",
      attributes: { addressedAgent: addressed.name, principal: userId },
    });

    // ① The redaction gate. Everything from here down sees the redacted text;
    // only the Runtime receives the raw prompt, and only in memory.
    const redaction = this.codify.enabled
      ? this.codify.redactPrompt(prompt)
      : { redactedText: prompt, hits: [], redactionRatio: 0, promotionEligible: false };
    const storedPrompt = redaction.redactedText;

    let binding: RunnerScopeBinding | undefined;
    let decision: RouteDecision | undefined;
    let summary: RunCodifySummary | undefined;
    let delegatedTo: Agent | undefined;

    // The conversation is where the person typed; execution is wherever the
    // platform routes the work. Keeping them separate is what lets one thread
    // reach every specialist without the reader being moved between cards.
    const conversationAgentId = agentId;

    // A follow-up belongs to whoever answered last. Resolved *before* routing
    // rather than after, so `route()` sees the specialist as the addressed
    // Agent and produces its `principal_bound` scope by the ordinary path — a
    // correction to a governed answer then runs under that contract's
    // permissions instead of ad hoc on the general Agent, unrestricted.
    let routeAgentId = agentId;
    let continuation: { agent: Agent; reason: string } | undefined;
    if (this.codify.enabled) {
      const verdict = looksLikeFollowUp(storedPrompt);
      if (verdict.followUp) {
        const previous = this.lastResponder(conversationAgentId, userId);
        if (previous && previous.id !== agentId && previous.status === "ready") {
          routeAgentId = previous.id;
          continuation = { agent: previous, reason: verdict.reason };
        }
      }
    }
    let executionAgentId = routeAgentId;

    if (this.codify.enabled) {
      if (continuation) {
        tracer.event({
          name: "continues with " + continuation.agent.name,
          category: "delegation",
          parentId: turn.id,
          attributes: {
            agent: continuation.agent.name,
            why: continuation.reason,
          },
        });
      }
      const observation = await this.codify.recordPromptObservation({
        runId,
        agentId: routeAgentId,
        userId,
        redactedText: storedPrompt,
        redactionHits: redaction.hits,
        promotionEligible: redaction.promotionEligible,
      });
      // ⑤a The routing decision: which contract, if any, governs this turn.
      const routing = this.codify.route({
        runId,
        agentId: routeAgentId,
        observation,
        forceAdHoc: options.forceAdHoc === true,
      });
      decision = routing.decision;
      await this.codify.persistRouteDecision(routing.decision);
      tracer.event({
        name: "route: " + routing.decision.decision,
        category: "policy_decision",
        parentId: turn.id,
        status: routing.decision.decision === "unmatched" ? "error" : "ok",
        attributes: {
          decision: routing.decision.decision,
          brokerMode: routing.decision.brokerMode,
          ...(routing.decision.matchChannel ? { channel: routing.decision.matchChannel } : {}),
          ...(routing.decision.score !== undefined ? { score: routing.decision.score } : {}),
          ...(routing.decision.contractId ? { contractId: routing.decision.contractId } : {}),
        },
      });

      // ⑧ Budget. Checked after routing, because the ceiling belongs to the
      // contract that governs the turn, and before the Run exists, because a
      // refused turn must not consume an Agent's one active slot.
      if (routing.contract) {
        const budgetSpan = tracer.open({
          name: "budget check",
          category: "budget_check",
          parentId: turn.id,
          attributes: { contract: routing.contract.name },
        });
        try {
          const budget = await this.codify.enforceBudget({
            runId,
            agentId,
            contract: routing.contract,
          });
          budgetSpan.end({
            attributes: {
              tokensSpent: budget.usage.totalTokens,
              runsAdmitted: budget.usage.runs,
            },
          });
        } catch (error) {
          budgetSpan.end({
            status: "denied",
            attributes: { reason: error instanceof Error ? error.message : "refused" },
          });
          turn.end({ status: "denied" });
          await tracer.flush();
          throw error;
        }
      }
      // ⑩ A request that asks for several things. Nothing cleared a threshold
      // but several contracts came close, which is the measured signature of a
      // compound prompt — and the one case where falling through to an ad-hoc
      // run would hand *more* capability to a *less* recognisable request. Split
      // it, and let each fragment be routed on its own merits.
      const compound = this.codify.looksCompound({
        decision,
        canonicalPrompt: observation.canonicalForm,
        ...(routing.contract ? { contract: routing.contract } : {}),
      });
      if (!options.skipPlanner && compound) {
        const dispatched = await this.splitIntoSession({
          addressedAgentId: agentId,
          prompt: storedPrompt,
          userId,
          tracer,
          turnSpanId: turn.id,
        });
        if (dispatched) {
          await this.codify.noteSplit(
            runId,
            dispatched.session.id,
            dispatched.session.plan?.length ?? 0,
          );
          // The work runs elsewhere, but the person asked *here*. Without this
          // their request vanishes from the conversation they typed it into and
          // only a banner remains, which reads as the message having been lost.
          // It carries this turn's runId — the one the route decision names —
          // even though no Run was created for it, because that is the record
          // that explains where the request went.
          const asked: Message = {
            id: randomUUID(),
            agentId,
            runId,
            role: "user",
            content: storedPrompt,
            createdAt: timestamp,
            userId,
          };
          await this.store.mutate((database) => {
            database.messages.push(asked);
          });
          turn.end({ attributes: { split: dispatched.session.plan?.length ?? 0 } });
          await tracer.flush();
          return { ...dispatched, message: asked };
        }
      }

      // An unmatched run still goes through the broker, permissively, so it
      // yields the CapabilityObservation that scope derivation feeds on.
      binding = routing.binding ?? this.codify.observeBinding(runId);
      summary = routing.summary;

      // ⑤b Delegation. Recognising a task is only worth anything if the work is
      // handed to the Agent built for it: its workspace, its session, and the
      // brief distilled from every past run. Applying the permissions alone
      // would govern the turn without improving it.
      if (routing.delegateToAgentId && routing.delegateToAgentId !== routeAgentId) {
        const specialist = this.store
          .snapshot()
          .agents.find((item) => item.id === routing.delegateToAgentId);
        // Best-effort: a specialist that is missing, stopped or mid-run must
        // not cost the user their turn. Falling back keeps the scope binding,
        // so a declined delegation still runs governed, just not specialised.
        if (specialist && specialist.status === "ready") {
          executionAgentId = specialist.id;
          delegatedTo = specialist;
          summary = {
            ...summary,
            delegatedFromAgentId: agentId,
            delegatedFromAgentName: addressed.name,
            delegatedToAgentId: specialist.id,
            delegatedToAgentName: specialist.name,
          };
          tracer.event({
            name: "delegated to " + specialist.name,
            category: "delegation",
            parentId: turn.id,
            attributes: { from: addressed.name, to: specialist.name },
          });
        }
      }

      // ⑦ A follow-up on a governed conversation is a correction, not a new
      // task. Recording it is how repeated corrections become standing rules.
      // A message that matches the contract is another instance of the task
      // itself, so it is never treated as feedback about the last one.
      if (decision.decision !== "routed") {
        await this.captureFeedback(executionAgentId, runId, userId, storedPrompt);
      }
    }

    const run: AgentRun = {
      id: runId,
      agentId: executionAgentId,
      ...(executionAgentId !== conversationAgentId ? { conversationAgentId } : {}),
      status: "queued",
      prompt: storedPrompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      ...(summary ? { codify: summary } : {}),
    };
    // Filed under the conversation, not the executing Agent. The run still
    // belongs to the specialist; the transcript belongs to the person.
    const message: Message = {
      id: randomUUID(),
      agentId: conversationAgentId,
      runId,
      role: "user",
      content: storedPrompt,
      createdAt: timestamp,
      userId,
      ...(executionAgentId !== conversationAgentId
        ? { executedByAgentId: executionAgentId }
        : {}),
    };

    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === executionAgentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });

    const execution = this.executeRun(agentAtStart, run, {
      rawPrompt: prompt,
      tracer,
      turnSpanId: turn.id,
      userId,
      conversationAgentId,
      threadId: resumeThread(agentAtStart, userId, decision),
      ...(binding ? { binding } : {}),
      ...(decision ? { decision } : {}),
    });
    this.activeExecutions.set(executionAgentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(executionAgentId) === execution) {
          this.activeExecutions.delete(executionAgentId);
        }
      })
      .catch(() => undefined);
    return { run, message, ...(delegatedTo ? { delegatedTo } : {}) };
  }

  /**
   * A message sent into a conversation that already has a governed exchange,
   * and which does not itself match a contract, is a correction to what the
   * Agent just produced rather than a fresh request.
   *
   * The caller enforces the "does not itself match" half: without it, the
   * second person asking for the task reads as a complaint about the first
   * person's output, and the platform proposes a "rule" that is just the task
   * restated.
   *
   * Only the contract that governed the previous turn is credited, so
   * corrections attach to the brief they are actually about.
   */
  private async captureFeedback(
    executionAgentId: string,
    runId: string,
    userId: string,
    redactedText: string,
  ): Promise<void> {
    const database = this.store.snapshot();
    const previous = database.runs
      .filter(
        (item) =>
          item.agentId === executionAgentId &&
          item.id !== runId &&
          item.status === "completed" &&
          item.codify?.contractId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!previous?.codify?.contractId) return;

    await this.codify.recordFeedback({
      runId,
      agentId: executionAgentId,
      contractId: previous.codify.contractId,
      contractVersion: previous.codify.contractVersion ?? 1,
      userId,
      redactedText,
    });
  }

  /**
   * Advance a coordination session by exactly one turn.
   *
   * One turn per call rather than a background loop. That keeps every
   * intermediate state in the store where a reviewer can see it, makes the
   * anti-duplication claim meaningful (a second concurrent call is refused
   * rather than racing), and means an administrative stop always lands between
   * turns instead of having to interrupt one.
   *
   * The turn runs through the ordinary `sendMessage` path, so it is routed,
   * budgeted, scoped, brokered and traced exactly as a Playground turn is.
   * Coordination adds no execution path of its own — which is the property that
   * makes "each participant runs under its own contract's scope" true rather
   * than aspirational.
   */
  /**
   * Advance a session by one wave.
   *
   * A goal-driven session has a wave of exactly one, so this is the sequential
   * behaviour it always had. A plan-backed session advances every step whose
   * dependencies are met, at once — which is the whole point of splitting a
   * compound request into a graph rather than a list. Each step still runs on
   * the Agent its own fragment matched, under that contract's scope.
   */
  async advanceSession(
    sessionId: string,
    onDispatch?: (dispatched: { run: AgentRun; message: Message }) => void,
  ): Promise<CoordinationSession> {
    const wave = await this.codify.planWave(sessionId);
    if (wave.length === 0) return this.codify.getSession(sessionId);
    await Promise.all(wave.map((step) => this.runSessionTurn(sessionId, step, onDispatch)));
    return this.codify.getSession(sessionId);
  }

  /**
   * Advance a plan-backed session until nothing is left to run.
   *
   * The loop is bounded by the plan itself: every wave settles at least one
   * step, and `shouldStop` refuses to continue once the steps are exhausted, a
   * dependency has failed, or the turn ceiling is hit — so the ceiling is a
   * backstop rather than the thing doing the work.
   */
  async runSessionToCompletion(
    sessionId: string,
    onDispatch?: (dispatched: { run: AgentRun; message: Message }) => void,
  ): Promise<CoordinationSession> {
    let session = this.codify.getSession(sessionId);
    for (let guard = 0; guard <= session.maxTurns; guard += 1) {
      const before = session.turns.length;
      session = await this.advanceSession(sessionId, onDispatch);
      if (session.status !== "active" || session.turns.length === before) break;
    }
    return session;
  }

  /** Claim, run and settle a single session turn. */
  private async runSessionTurn(
    sessionId: string,
    step: Awaited<ReturnType<CodifyService["planWave"]>>[number],
    onDispatch?: (dispatched: { run: AgentRun; message: Message }) => void,
  ): Promise<void> {
    const participant = this.getAgent(step.selection.agentId);
    let claimed;
    try {
      claimed = await this.codify.claimTurn(sessionId, {
        agentId: participant.id,
        agentName: participant.name,
        ...(step.stepIndex !== undefined ? { stepIndex: step.stepIndex } : {}),
        ...(step.selection.contract
          ? {
              contractId: step.selection.contract.id,
              contractName: step.selection.contract.name,
            }
          : {}),
        selection: step.selection.reason,
        instruction: step.instruction,
      });
    } catch {
      // Lost the race for this step or this Agent. The other claimant is
      // running it; there is nothing to record and nothing to fail.
      return;
    }

    try {
      const dispatched = await this.sendMessage(participant.id, step.instruction, {
        userId: step.session.createdBy,
        // A step is a task in its own right and must be routed as one. Without
        // this, splitting a compound prompt and then re-entering `sendMessage`
        // would split each fragment again.
        skipPlanner: true,
      });
      const run = dispatched.run;
      onDispatch?.({ run, message: dispatched.message });
      // `sendMessage` returns as soon as the Run is queued; a session turn is
      // only over when the Run is. Awaiting the execution here is what makes a
      // turn a unit of work rather than a dispatch.
      await this.activeExecutions.get(run.agentId)?.catch(() => undefined);
      const settled = this.getRun(run.id);
      if (settled.status === "completed") {
        const output = settled.output ?? "";
        await this.codify.settleTurn(sessionId, claimed.index, {
          status: "completed",
          runId: settled.id,
          output,
          state: this.codify.declaredState(output),
        });
      } else {
        await this.codify.settleTurn(sessionId, claimed.index, {
          status: "failed",
          runId: settled.id,
          error: settled.error ?? "The run did not complete.",
        });
      }
    } catch (error) {
      // A refused turn — a busy Agent, an exhausted budget — is a recorded
      // failure of that turn, never a crash of the session. The stop rules then
      // decide whether the session can continue.
      await this.codify.settleTurn(sessionId, claimed.index, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Split a compound request, start it, and return its first step.
   *
   * Returns null when the request turned out to be one task, when there is no
   * specialist to hand a fragment to, or when the session could not get a
   * single step off the ground — in every one of those the caller carries on
   * down the ordinary path, so a planner that misfires costs the split and
   * nothing else.
   *
   * The later waves run in the background, because a step that depends on an
   * earlier one cannot start until that output exists, and the caller is a
   * chat turn that should not be held open for the whole plan.
   */
  private async splitIntoSession(input: {
    addressedAgentId: string;
    prompt: string;
    userId: string;
    tracer: RunTracer;
    turnSpanId: string;
  }): Promise<{ run: AgentRun; message: Message; session: CoordinationSession } | null> {
    const session = await this.coordinatePrompt({
      addressedAgentId: input.addressedAgentId,
      prompt: input.prompt,
      userId: input.userId,
    });
    if (!session) return null;

    const plan = session.plan ?? [];
    input.tracer.event({
      name: "split into " + plan.length + " steps",
      category: "orchestration",
      parentId: input.turnSpanId,
      attributes: {
        sessionId: session.id,
        steps: plan.map((step) => step.text.slice(0, 80)).join(" | "),
        // How much of the plan can run at once, which is the difference between
        // a graph and a list.
        waves: waves(plan).length,
      },
    });

    // Resolves as soon as the first step has a queued Run, not when it finishes.
    let settle: (() => void) | undefined;
    const dispatchedFirst = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let first: { run: AgentRun; message: Message } | undefined;
    void this.runSessionToCompletion(session.id, (dispatched) => {
      if (first) return;
      first = dispatched;
      settle?.();
    })
      .catch(() => undefined)
      // If the whole session ended without dispatching anything, stop waiting.
      .finally(() => settle?.());
    await dispatchedFirst;
    if (!first) {
      await this.codify.stopSession(
        session.id,
        "No step could be started, so the request ran as a single turn instead.",
      );
      return null;
    }
    return { ...first, session: this.codify.getSession(session.id) };
  }

  /**
   * Turn one request that asks for several things into a plan-backed session.
   *
   * Returns null when the request is a single task, which is the common case
   * and the one that must stay on the ordinary path.
   *
   * The participants are every ready Agent that holds an active contract, plus
   * the Agent the request was addressed to as the fallback. That list is not a
   * grant of anything: a participant only ever receives a step its own contract
   * matched, and the fallback only receives steps nothing matched. The union of
   * their scopes is never held by anyone.
   */
  async coordinatePrompt(input: {
    addressedAgentId: string;
    prompt: string;
    userId: string;
  }): Promise<CoordinationSession | null> {
    const plan = await this.codify.splitPrompt(input.prompt);
    if (!plan) return null;

    const database = this.store.snapshot();
    const specialists = database.contracts
      .filter((contract) => contract.status === "active" && contract.agentId)
      .map((contract) => contract.agentId as string);
    const participants = [
      input.addressedAgentId,
      ...specialists.filter((id) =>
        database.agents.some((agent) => agent.id === id && agent.status !== "stopped"),
      ),
    ];
    // A session needs someone to route between. With no specialist to hand a
    // fragment to, splitting buys nothing the general Agent was not already
    // going to do in one turn.
    if (new Set(participants).size < 2) return null;

    return this.codify.createSession({
      topic: "Split request",
      goal: input.prompt,
      participantAgentIds: participants,
      fallbackAgentId: input.addressedAgentId,
      // One turn per step, plus room for a step that has to be retried in a
      // later wave because its Agent was busy.
      maxTurns: Math.min(plan.length * 2, 12),
      createdBy: input.userId,
      plan,
    });
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
      codifyEnabled: this.config.codifyEnabled,
      codifyEnforcing: isCodifyActive(this.config),
      codifyMatchThreshold: this.config.codifyMatchThreshold,
      codifyContainmentThreshold: this.config.codifyContainmentThreshold,
      codifySemanticThreshold: this.config.codifySemanticThreshold,
      // Reported separately from the switch: a reviewer needs to see whether the
      // semantic channel is actually available, not just whether it is wanted.
      codifySemanticEnabled: this.config.codifySemanticEnabled,
      codifySemanticAvailable: Boolean(
        this.config.codifySemanticEnabled &&
          this.config.arkApiKey &&
          this.config.arkEmbedModel,
      ),
      codifyManagedSecrets: Object.keys(this.config.codifyManagedSecrets),
    };
  }

  /**
   * Approve a repeated correction and write it into the specialist itself.
   *
   * The contract is the record; `AGENTS.md` in the Agent's workspace is what
   * the Runtime actually reads. Both move together, or the brief a reviewer
   * approved is not the brief anyone runs.
   */
  async applyRefinement(
    id: string,
    userId: string,
    editedRule?: string | undefined,
  ): Promise<{ contract: TaskContract; agent: Agent | null }> {
    const { contract, instructions } = await this.codify.applyRefinement(
      id,
      userId,
      editedRule,
    );
    let agent: Agent | null = null;
    try {
      agent = await this.updateAgent(contract.agentId, { instructions });
    } catch (error) {
      // A specialist that is mid-run cannot be edited. The contract already
      // carries the rule, so say so rather than pretending it took effect.
      throw new HttpError(
        409,
        "Recorded the refinement on contract v" +
          contract.version +
          ", but the specialist Agent is busy so its brief was not updated. " +
          "Retry once its run finishes. (" +
          (error instanceof Error ? error.message : String(error)) +
          ")",
      );
    }
    return { contract, agent };
  }

  /** Promotion needs to create a real Agent, so it goes through this service. */
  async approveCandidate(
    id: string,
    input: {
      name?: string | undefined;
      scope?: CapabilityScope | undefined;
      userId: string;
    },
  ) {
    return this.codify.approveCandidate(id, input, (agent) => this.createAgent(agent));
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    context: {
      rawPrompt: string;
      tracer: RunTracer;
      turnSpanId: string;
      userId: string;
      /** Where the reply is filed, which is not always where it ran. */
      conversationAgentId: string;
      threadId: string | null;
      binding?: RunnerScopeBinding;
      decision?: RouteDecision;
    },
  ): Promise<void> {
    const { tracer, turnSpanId } = context;
    const runtime = tracer.open({
      name: "runtime turn",
      category: "sandbox_execution",
      parentId: turnSpanId,
      attributes: {
        provider: this.config.runtimeProvider,
        ...(context.binding ? { brokerMode: context.binding.mode } : {}),
      },
    });
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    // Collected on success and on failure alike: a denied run is exactly the
    // one whose evidence matters most.
    let evidence: RunEvidence | undefined;
    const recordEvidence = async (): Promise<void> => {
      if (!evidence || !context.decision) return;
      const captured = evidence;
      evidence = undefined;
      try {
        await this.codify.recordRunEvidence({
          run,
          decision: context.decision,
          evidence: captured,
        });
        // Detection runs on the evidence this turn just produced, and anything
        // that clears its thresholds is promoted without waiting for someone to
        // open the review queue. `autoPromote` is a no-op when the switch is off
        // or when the reviewer withholds its approval.
        await this.codify.refreshCandidates();
        await this.codify.autoPromote((agent) => this.createAgent(agent));
        // The same pass for corrections: several people asking for the same
        // change rewrites the brief without waiting for an operator, behind a
        // guard that only signs presentation changes.
        await this.codify.refreshRefinements();
        await this.codify.autoApplyRefinements();
        // The broker's own JSONL is the source of truth for what happened at
        // the boundary; the trace only gives those facts an ordering and a
        // parent, so a reviewer reads one sequence instead of two logs.
        for (const event of captured.brokerEvents ?? []) {
          if (event.type === "denial") {
            tracer.event({
              name: "denied " + (event.target ?? event.host ?? "unknown"),
              category: "egress",
              parentId: runtime.id,
              status: "denied",
              at: event.at,
              attributes: {
                kind: event.kind ?? "egress",
                ...(event.reason ? { reason: event.reason } : {}),
              },
            });
          } else if (event.type === "egress" && event.host) {
            tracer.event({
              name: "egress " + event.host,
              category: "egress",
              parentId: runtime.id,
              at: event.at,
              attributes: { host: event.host, ...(event.port ? { port: event.port } : {}) },
            });
          } else if (event.type === "model_call") {
            tracer.event({
              name: "model call",
              category: "model_call",
              parentId: runtime.id,
              at: event.at,
              status: event.status && event.status >= 400 ? "error" : "ok",
              ...(event.status ? { attributes: { status: event.status } } : {}),
            });
          }
        }
      } catch {
        /* Evidence must never change the outcome the caller already saw. */
      }
    };

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      // One workspace per principal, created on this person's first run. The
      // Agent is shared; the directory it works in is not.
      const workspacePath = await this.workspaces.ensureFor(agentAtStart, context.userId);
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath,
        // The Agent is the intended recipient of the raw prompt; the store is
        // not. This is the only place the unredacted text is used.
        prompt: context.rawPrompt,
        threadId: context.threadId,
        ...(context.binding ? { codify: context.binding } : {}),
        onEvidence: (collected) => {
          evidence = collected;
        },
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: context.conversationAgentId,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
          userId: context.userId,
          ...(agent.id !== context.conversationAgentId
            ? { executedByAgentId: agent.id }
            : {}),
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        if (result.threadId) {
          agent.codexThreads = { ...(agent.codexThreads ?? {}), [context.userId]: result.threadId };
        }
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      runtime.end({
        attributes: {
          ...(result.usage?.inputTokens ? { inputTokens: result.usage.inputTokens } : {}),
          ...(result.usage?.outputTokens ? { outputTokens: result.usage.outputTokens } : {}),
        },
      });
      await recordEvidence();
      tracer.open({ name: "completed", category: "orchestration", parentId: turnSpanId }).end();
      // Close the root explicitly. `flush` closes anything still open as an
      // error, which is right for a crash and wrong for the ordinary path.
      tracer.close(turnSpanId, { status: "ok" });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      runtime.end({
        status: cancelled ? "ok" : "error",
        attributes: { outcome: cancelled ? "cancelled" : "failed" },
      });
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      await recordEvidence();
    } finally {
      // Closes the turn span and writes every span in one mutation. Swallows
      // its own failures: a Run that finished must not be reported otherwise
      // because its trace could not be stored.
      await tracer.flush();
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
