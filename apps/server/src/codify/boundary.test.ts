/**
 * The HTTP trust boundary. A capability scope is always read server-side from
 * the governing contract, so nothing a caller puts in the request body may ever
 * influence what the Runtime is allowed to do.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

const config = loadConfig({ NODE_ENV: "test", CODIFY_DEFAULT_USER: "user-a" });

function stubService() {
  const sendMessage = vi.fn(async () => ({
    run: { id: "run-1" },
    message: { id: "message-1" },
  }));
  const service = {
    sendMessage,
    listAgents: () => [],
    systemInfo: async () => ({}),
  } as unknown as AgentService;
  return { service, sendMessage };
}

const agentId = "22222222-2222-4222-8222-222222222222";

describe("Codify request boundary", () => {
  it("ignores a capability scope supplied by the caller", async () => {
    const { service, sendMessage } = stubService();
    const app = await createApp(config, service);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: {
        content: "generate the release notes",
        // A forged scope, exactly as an attacker would attempt it.
        scope: {
          paths: [{ path: ".", mode: "rw" }],
          domains: ["collector.evil.example"],
          secrets: ["ARK_API_KEY"],
        },
        contractId: "someone-elses-contract",
      },
    });

    expect(response.statusCode).toBe(202);
    const [, , options] = sendMessage.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(options).not.toHaveProperty("scope");
    expect(options).not.toHaveProperty("contractId");
    expect(JSON.stringify(options)).not.toContain("collector.evil.example");
    await app.close();
  });

  it("attributes the run to the calling principal", async () => {
    const { service, sendMessage } = stubService();
    const app = await createApp(config, service);

    await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      headers: { "x-codify-user": "user-b" },
      payload: { content: "generate the release notes" },
    });
    expect((sendMessage.mock.calls[0] as unknown[])[2]).toMatchObject({ userId: "user-b" });

    await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "generate the release notes" },
    });
    expect((sendMessage.mock.calls[1] as unknown[])[2]).toMatchObject({ userId: "user-a" });
    await app.close();
  });

  it("reports a refused scope edit with its reason, in production too", async () => {
    // `setNotFoundHandler` forks the root context, so an error handler
    // registered after it silently stops applying. That regression turned every
    // Codify policy refusal into a bare "Bad Request" in the only mode the demo
    // actually runs in.
    const production = loadConfig({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      LOG_LEVEL: "silent",
    });
    const { service } = stubService();
    const app = await createApp(production, service);

    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(response.json()).toHaveProperty("details");
    await app.close();
  });

  it("passes an explicit ad-hoc override through as a recorded decision", async () => {
    const { service, sendMessage } = stubService();
    const app = await createApp(config, service);
    await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "generate the release notes", forceAdHoc: true },
    });
    expect((sendMessage.mock.calls[0] as unknown[])[2]).toMatchObject({ forceAdHoc: true });
    await app.close();
  });
});
