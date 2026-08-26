import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { agentCodexHome, isArkConfigured, isCodifyActive } from "./config.js";
import { reapOrphanedBrokers } from "./codify/broker-session.js";
import { RunTracer } from "./codify/trace.js";
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

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    options: { userId?: string; forceAdHoc?: boolean } = {},
  ): Promise<{ run: AgentRun; message: Message; delegatedTo?: Agent }> {
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
    let executionAgentId = agentId;
    let delegatedTo: Agent | undefined;

    if (this.codify.enabled) {
      const observation = await this.codify.recordPromptObservation({
        runId,
        agentId,
        userId,
        redactedText: storedPrompt,
        redactionHits: redaction.hits,
        promotionEligible: redaction.promotionEligible,
      });
      // ⑤a The routing decision: which contract, if any, governs this turn.
      const routing = this.codify.route({
        runId,
        agentId,
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
      // An unmatched run still goes through the broker, permissively, so it
      // yields the CapabilityObservation that scope derivation feeds on.
      binding = routing.binding ?? this.codify.observeBinding(runId);
      summary = routing.summary;

      // ⑤b Delegation. Recognising a task is only worth anything if the work is
      // handed to the Agent built for it: its workspace, its session, and the
      // brief distilled from every past run. Applying the permissions alone
      // would govern the turn without improving it.
      if (routing.delegateToAgentId && routing.delegateToAgentId !== agentId) {
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
    const message: Message = {
      id: randomUUID(),
      agentId: executionAgentId,
      runId,
      role: "user",
      content: storedPrompt,
      createdAt: timestamp,
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
  async advanceSession(sessionId: string): Promise<CoordinationSession> {
    const plan = this.codify.planTurn(sessionId);
    if (!plan) return this.codify.getSession(sessionId);

    const participant = this.getAgent(plan.selection.agentId);
    const claimed = await this.codify.claimTurn(sessionId, {
      agentId: participant.id,
      agentName: participant.name,
      ...(plan.selection.contract
        ? {
            contractId: plan.selection.contract.id,
            contractName: plan.selection.contract.name,
          }
        : {}),
      selection: plan.selection.reason,
      instruction: plan.instruction,
    });

    try {
      const { run } = await this.sendMessage(participant.id, plan.instruction, {
        userId: plan.session.createdBy,
      });
      // `sendMessage` returns as soon as the Run is queued; a session turn is
      // only over when the Run is. Awaiting the execution here is what makes
      // the turns sequential rather than overlapping.
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
    return this.codify.getSession(sessionId);
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
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        // The Agent is the intended recipient of the raw prompt; the store is
        // not. This is the only place the unredacted text is used.
        prompt: context.rawPrompt,
        threadId: agentAtStart.codexThreadId,
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
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
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
