import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
/**
 * Note what this schema does NOT accept: a capability scope. A scope is always
 * read server-side from the governing contract, so a caller cannot smuggle one
 * in. Zod strips unknown keys, so an inline `scope` is silently ignored — there
 * is a negative test for exactly this.
 */
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  forceAdHoc: z.boolean().optional(),
});

const capabilityScopeBody = z.object({
  paths: z
    .array(
      z.object({
        path: z.string().trim().max(200),
        mode: z.enum(["ro", "rw"]),
      }),
    )
    .max(50),
  domains: z.array(z.string().trim().max(253)).max(50),
  secrets: z.array(z.string().trim().max(100)).max(50),
});

/**
 * A ceiling a reviewer may set. Every field optional: absent is unlimited, not
 * zero. Capped well above any plausible task so a typo cannot mint an infinite
 * budget by accident.
 */
const budgetBody = z.object({
  maxTotalTokens: z.number().int().positive().max(100_000_000).optional(),
  maxRuns: z.number().int().positive().max(100_000).optional(),
  maxTokensPerRun: z.number().int().positive().max(10_000_000).optional(),
});

const approveBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  scope: capabilityScopeBody.optional(),
  budget: budgetBody.optional(),
});

/**
 * Scope and budget move through the same review gate but under opposite rules:
 * a scope may only ever be narrowed, while a budget may be raised as well as
 * lowered. Spend is a decision an operator revisits with new information; a
 * permission is not, and widening one still needs a recorded denial.
 */
const reviseBody = z.object({
  scope: capabilityScopeBody.optional(),
  budget: budgetBody.nullable().optional(),
});

/**
 * A coordination session. `maxTurns` is required and capped: an unbounded
 * session is a runaway loop with extra steps, and the ceiling is the only thing
 * that guarantees it terminates.
 */
const createSessionBody = z.object({
  topic: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(4_000),
  participantAgentIds: z.array(z.string().uuid()).min(2).max(8),
  maxTurns: z.number().int().min(1).max(40),
  state: z.record(z.string().max(32), z.string().max(120)).optional(),
});

const stopSessionBody = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});

/** A reviewer may reword a proposed rule before it becomes part of the brief. */
const applyRefinementBody = z.object({
  rule: z.string().trim().min(1).max(300).optional(),
});

/**
 * Mock identity, as the brief permits. A header plus a UI switcher is enough to
 * demonstrate ownership and attribution; building real login would spend the
 * hackathon on the one part that is a solved problem elsewhere.
 */
function principal(request: { headers: Record<string, unknown> }, fallback: string): string {
  const header = request.headers["x-codify-user"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 64) : fallback;
}

/**
 * Refuse a governance decision to anyone who is not an operator.
 *
 * On the route, not in the UI. Hiding a button is a presentation choice and
 * proves nothing: the check has to be somewhere the caller cannot reach, or a
 * curl to the same endpoint walks straight past it. Reading the evidence stays
 * open — an audit trail only the auditor can see is worth much less — and what
 * is gated is *deciding*: approving a candidate mints a contract, and editing a
 * scope changes what an Agent may reach.
 *
 * The principal itself is asserted rather than authenticated (see
 * `docs/CODIFY.md` §11); a real deployment resolves it from an IdP and nothing
 * else about this changes.
 */
function requireOperator(
  request: { headers: Record<string, unknown> },
  config: AppConfig,
): string {
  const who = principal(request, config.codifyDefaultUser);
  if (!config.codifyOperators.includes(who)) {
    throw new HttpError(
      403,
      "Only an operator can decide governance. Signed in as " +
        who +
        "; operators are " +
        config.codifyOperators.join(", ") +
        ".",
    );
  }
  return who;
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async (request) => ({
    // `systemInfo` is async — spreading the promise silently yields nothing,
    // which emptied this payload down to the three fields added below.
    ...(await service.systemInfo()),
    principal: principal(request, config.codifyDefaultUser),
    // So the UI can show the governance controls as refused rather than
    // pretending they were never there. The route is the authority either way.
    isOperator: config.codifyOperators.includes(
      principal(request, config.codifyDefaultUser),
    ),
    operators: config.codifyOperators,
  }));

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return {
      messages: service.getMessages(id, principal(request, config.codifyDefaultUser)),
    };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, {
      userId: principal(request, config.codifyDefaultUser),
      ...(body.forceAdHoc !== undefined ? { forceAdHoc: body.forceAdHoc } : {}),
    });
    return reply.code(202).send(result);
  });

  /*
   * Clearing your own conversation is neither a read nor a governance
   * decision, so it is not gated on `CODIFY_OPERATORS` — but it is scoped to
   * the calling principal, who is the only person it may affect.
   */
  /*
   * Read-only, on purpose. There is no write or upload counterpart: staging
   * bytes into a workspace belongs to a deployment, and an ingress would itself
   * need governing. See `docs/CODIFY.md` §11.
   */
  app.get("/api/agents/:id/workspace", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.listWorkspace(id, principal(request, config.codifyDefaultUser));
  });

  app.get("/api/agents/:id/workspace/file", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { path: relative } = z
      .object({ path: z.string().min(1).max(1024) })
      .parse(request.query);
    return service.readWorkspaceFile(
      id,
      principal(request, config.codifyDefaultUser),
      relative,
    );
  });

  app.post("/api/agents/:id/session/reset", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.resetSession(id, principal(request, config.codifyDefaultUser));
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  // ------------------------------------------------------------------ Codify

  app.get("/api/codify/candidates", async () => ({
    candidates: service.codify.listCandidates(),
  }));

  app.post("/api/codify/candidates/refresh", async () => ({
    candidates: await service.codify.refreshCandidates(),
  }));

  app.get("/api/codify/candidates/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { candidate: service.codify.getCandidate(id) };
  });

  app.post("/api/codify/candidates/:id/approve", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    // Authorise before validating: a caller who may not use this route should
    // not be handed the shape of its payload.
    const operator = requireOperator(request, config);
    const body = approveBody.parse(request.body ?? {});
    const result = await service.approveCandidate(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
      ...(body.budget !== undefined ? { budget: body.budget } : {}),
      userId: operator,
    });
    return reply.code(201).send(result);
  });

  app.post("/api/codify/candidates/:id/reject", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    requireOperator(request, config);
    return { candidate: await service.codify.rejectCandidate(id) };
  });

  app.get("/api/codify/contracts", async () => ({
    contracts: service.codify.listContracts(),
  }));

  app.get("/api/codify/contracts/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { contract: service.codify.getContract(id) };
  });

  /** Narrowing is revocation and is always allowed; widening needs a denial. */
  app.patch("/api/codify/contracts/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const operator = requireOperator(request, config);
    const body = reviseBody.parse(request.body);
    return {
      contract: await service.codify.reviseContract(
        id,
        {
          ...(body.scope !== undefined ? { scope: body.scope } : {}),
          ...(body.budget !== undefined ? { budget: body.budget } : {}),
        },
        operator,
      ),
    };
  });

  app.get("/api/codify/contracts/:id/escalation", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.codify.proposeEscalation(id);
  });

  /** Everything Codify recorded about one Run, for the evidence view. */
  app.get("/api/codify/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const run = service.getRun(id);
    return {
      run,
      decision: service.codify.getRouteDecision(id) ?? null,
      denials: service.codify.listDenials(id),
    };
  });

  app.get("/api/codify/denials", async () => ({
    denials: service.codify.listDenials(),
  }));

  /**
   * One Run as a connected sequence rather than four unrelated record types.
   * 404 rather than an empty trace: a Run with no spans predates tracing, and
   * saying so is more useful than showing an empty timeline.
   */
  app.get("/api/codify/runs/:id/trace", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    service.getRun(id);
    const trace = service.codify.traceForRun(id);
    if (!trace) {
      return reply.code(404).send({ error: "No trace was recorded for this Run" });
    }
    return { trace };
  });

  // ⑨ Multi-Agent coordination.

  app.get("/api/codify/sessions", async () => ({
    sessions: service.codify.listSessions(),
  }));

  app.post("/api/codify/sessions", async (request, reply) => {
    const body = createSessionBody.parse(request.body);
    const session = await service.codify.createSession({
      ...body,
      createdBy: principal(request, config.codifyDefaultUser),
    });
    return reply.code(201).send({ session });
  });

  app.get("/api/codify/sessions/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { session: service.codify.getSession(id) };
  });

  /**
   * One turn per call. A second concurrent call is refused by the turn claim
   * rather than racing it, which is what makes duplicate turns impossible.
   */
  app.post("/api/codify/sessions/:id/advance", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { session: await service.advanceSession(id) };
  });

  app.post("/api/codify/sessions/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = stopSessionBody.parse(request.body ?? {});
    return {
      session: await service.codify.stopSession(
        id,
        body.reason ?? "Stopped by " + principal(request, config.codifyDefaultUser) + ".",
      ),
    };
  });

  /** Current spend against a contract's ceiling, for the review UI. */
  app.get("/api/codify/contracts/:id/budget", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.codify.budgetStatus(id);
  });

  // ⑦ Refinements: repeated corrections becoming standing rules.

  app.get("/api/codify/refinements", async () => ({
    refinements: service.codify.listRefinements(),
  }));

  app.post("/api/codify/refinements/refresh", async () => ({
    refinements: await service.codify.refreshRefinements(),
  }));

  app.post("/api/codify/refinements/:id/apply", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const operator = requireOperator(request, config);
    const body = applyRefinementBody.parse(request.body ?? {});
    return service.applyRefinement(id, operator, body.rule);
  });

  app.post("/api/codify/refinements/:id/reject", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    requireOperator(request, config);
    return { refinement: await service.codify.rejectRefinement(id) };
  });

  // Registered before the static/not-found block below: `setNotFoundHandler`
  // forks the root context, and a `setErrorHandler` installed after it never
  // applies to routes already registered. With the two in the other order,
  // production returned Fastify's default error shape and turned every
  // validation failure into a 500.
  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
