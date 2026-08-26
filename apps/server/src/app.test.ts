import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const ID = "11111111-1111-4111-8111-111111111111";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

/**
 * The brief is explicit that "a login screen without server-side authorization
 * would not demonstrate the middleware itself". These assert the refusal is on
 * the route, where a caller who never loads the UI still meets it.
 */
describe("who may decide governance", () => {
  const governanceService = {
    listAgents: () => [],
    systemInfo: () => ({ codifyEnabled: true }),
    approveCandidate: async () => {
      throw new Error("must not be reached by a non-operator");
    },
    applyRefinement: async () => {
      throw new Error("must not be reached by a non-operator");
    },
    codify: {
      rejectCandidate: async () => {
        throw new Error("must not be reached by a non-operator");
      },
      rejectRefinement: async () => {
        throw new Error("must not be reached by a non-operator");
      },
      reviseContract: async () => {
        throw new Error("must not be reached by a non-operator");
      },
      listCandidates: () => [],
      listContracts: () => [],
      listDenials: () => [],
    },
  } as unknown as AgentService;

  const decisions: { method: "POST" | "PATCH"; url: string; payload?: unknown }[] = [
    { method: "POST", url: "/api/codify/candidates/" + ID + "/approve", payload: {} },
    { method: "POST", url: "/api/codify/candidates/" + ID + "/reject" },
    { method: "PATCH", url: "/api/codify/contracts/" + ID, payload: { scope: null } },
    { method: "POST", url: "/api/codify/refinements/" + ID + "/apply", payload: {} },
    { method: "POST", url: "/api/codify/refinements/" + ID + "/reject" },
  ];

  it("refuses every governance decision to an ordinary principal", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), governanceService);
    for (const decision of decisions) {
      const response = await app.inject({
        method: decision.method,
        url: decision.url,
        headers: { "x-codify-user": "user-a" },
        ...(decision.payload !== undefined ? { payload: decision.payload } : {}),
      });
      expect(response.statusCode, decision.url).toBe(403);
      expect(response.json().error, decision.url).toContain("operator");
    }
    await app.close();
  });

  it("lets an operator through to the service", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), governanceService);
    const response = await app.inject({
      method: "POST",
      url: "/api/codify/candidates/" + ID + "/reject",
      headers: { "x-codify-user": "operator" },
    });
    // The stub throws once past the gate, which is the proof it got past it.
    expect(response.statusCode).not.toBe(403);
    await app.close();
  });

  it("reads stay open, because evidence only an auditor can see is worth less", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), governanceService);
    for (const url of [
      "/api/codify/candidates",
      "/api/codify/contracts",
      "/api/codify/denials",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { "x-codify-user": "user-a" },
      });
      expect(response.statusCode, url).toBe(200);
    }
    await app.close();
  });
});
