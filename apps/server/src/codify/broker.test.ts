/**
 * The broker is plain JavaScript because it is bind-mounted into a container
 * and run by node directly. It is still the most security-critical code in the
 * project, so it is exercised here in-process — real sockets, real CONNECT, real
 * credential exchange — with no container engine required.
 */
import { createServer, type Server } from "node:http";
import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
  vi.resetModules();
});

function listen(server: Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function startBroker(environment: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "codify-broker-test-"));
  directories.push(root);
  const eventLog = path.join(root, "events.jsonl");
  await writeFile(eventLog, "", "utf8");

  vi.resetModules();
  for (const [key, value] of Object.entries({
    CODIFY_RUN_ID: "test-run",
    CODIFY_MODE: "enforce",
    CODIFY_EVENT_LOG: eventLog,
    CODIFY_REVOCATION_FILE: path.join(root, "revoked"),
    ...environment,
  })) {
    vi.stubEnv(key, value);
  }

  const { createBroker } = (await import("../../broker/codify-broker.mjs")) as {
    createBroker: () => Server;
  };
  const server = createBroker();
  const port = await listen(server);
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));

  return {
    port,
    revocationPath: path.join(root, "revoked"),
    events: async () =>
      (await readFile(eventLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Issue a raw CONNECT and return the status line. */
function connect(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n");
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes("\r\n")) {
        socket.destroy();
        resolve(buffer.split("\r\n")[0] as string);
      }
    });
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT timed out"));
    }, 5_000).unref();
  });
}

describe("Codify broker egress control", () => {
  it("tunnels to an allowlisted host and refuses everything else", async () => {
    // A stand-in upstream, so the test never leaves the loopback interface.
    const upstream = net.createServer((socket) => socket.end("ok"));
    const upstreamPort = await listen(upstream);
    closers.push(() => new Promise((resolve) => upstream.close(() => resolve())));

    const broker = await startBroker({ CODIFY_ALLOWED_DOMAINS: "127.0.0.1" });

    expect(await connect(broker.port, "127.0.0.1:" + upstreamPort)).toContain("200");
    expect(await connect(broker.port, "collector.evil.example:443")).toContain("403");

    const events = await broker.events();
    const denial = events.find((event) => event.type === "denial");
    expect(denial).toMatchObject({
      kind: "egress",
      target: "collector.evil.example",
      outcome: "blocked",
    });
  });

  it("never allows a metadata endpoint, even if the allowlist names it", async () => {
    const broker = await startBroker({
      CODIFY_ALLOWED_DOMAINS: "169.254.169.254,metadata.google.internal",
    });
    expect(await connect(broker.port, "169.254.169.254:80")).toContain("403");
    expect(await connect(broker.port, "metadata.google.internal:80")).toContain("403");
  });

  it("matches wildcard rules without matching an unrelated suffix", async () => {
    // The allow decision is asserted against the broker's own matcher rather
    // than through a socket. Reaching for a name that "should not resolve" is
    // not deterministic: some resolvers wildcard-answer unregistered TLDs, so a
    // supposedly-unreachable host connects and the test reports the opposite of
    // what it means to check.
    vi.resetModules();
    const { hostAllowed } = (await import("../../broker/codify-broker.mjs")) as {
      hostAllowed: (host: string, allowed: string[]) => boolean;
    };
    const rules = ["*.example.com", "single.example.org"];

    expect(hostAllowed("api.example.com", rules)).toBe(true);
    expect(hostAllowed("deep.nested.example.com", rules)).toBe(true);
    // A wildcard covers its own apex.
    expect(hostAllowed("example.com", rules)).toBe(true);
    expect(hostAllowed("single.example.org", rules)).toBe(true);

    // Suffix confusion: the classic way a naive endsWith() check is bypassed.
    expect(hostAllowed("notexample.com", rules)).toBe(false);
    expect(hostAllowed("example.com.evil.test", rules)).toBe(false);
    expect(hostAllowed("evil-example.com", rules)).toBe(false);
    expect(hostAllowed("example.org", rules)).toBe(false);
    expect(hostAllowed("", rules)).toBe(false);
    // The never-allow list wins over any rule.
    expect(hostAllowed("169.254.169.254", ["169.254.169.254"])).toBe(false);
  });

  it("refuses a non-allowlisted host without any network access at all", async () => {
    // The deny path is asserted over a real socket, which is safe to do because
    // a refusal happens before any DNS lookup or outbound connection.
    const broker = await startBroker({ CODIFY_ALLOWED_DOMAINS: "*.example.com" });
    expect(await connect(broker.port, "notexample.com:443")).toContain("403");
    expect(await connect(broker.port, "example.com.evil.test:443")).toContain("403");
  });

  it("observes without blocking in observe mode", async () => {
    const upstream = net.createServer((socket) => socket.end("ok"));
    const upstreamPort = await listen(upstream);
    closers.push(() => new Promise((resolve) => upstream.close(() => resolve())));

    const broker = await startBroker({ CODIFY_MODE: "observe", CODIFY_ALLOWED_DOMAINS: "" });
    expect(await connect(broker.port, "127.0.0.1:" + upstreamPort)).toContain("200");

    const events = await broker.events();
    expect(events.some((event) => event.decision === "observed")).toBe(true);
    expect(events.some((event) => event.type === "denial")).toBe(false);
  });
});

describe("Codify broker credential exchange", () => {
  async function withUpstream() {
    const seen: { authorization?: string }[] = [];
    const upstream = createServer((request, response) => {
      seen.push({ authorization: request.headers.authorization as string });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(upstream);
    closers.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    return { seen, url: "http://127.0.0.1:" + port };
  }

  it("exchanges the per-run placeholder for the real credential", async () => {
    const { seen, url } = await withUpstream();
    const broker = await startBroker({
      CODIFY_ALLOWED_DOMAINS: "",
      CODIFY_ARK_UPSTREAM: url,
      CODIFY_ARK_KEY: "REAL-ARK-KEY",
      CODIFY_RUN_TOKEN: "codify-run-token",
    });

    const response = await fetch("http://127.0.0.1:" + broker.port + "/ark/responses", {
      method: "POST",
      headers: { authorization: "Bearer codify-run-token" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    // The container presented a placeholder; upstream saw the real credential.
    expect(seen[0]?.authorization).toBe("Bearer REAL-ARK-KEY");
  });

  it("rejects a token the platform did not mint for this run", async () => {
    const { seen, url } = await withUpstream();
    const broker = await startBroker({
      CODIFY_ARK_UPSTREAM: url,
      CODIFY_ARK_KEY: "REAL-ARK-KEY",
      CODIFY_RUN_TOKEN: "codify-run-token",
    });

    const response = await fetch("http://127.0.0.1:" + broker.port + "/ark/responses", {
      method: "POST",
      headers: { authorization: "Bearer stolen-or-guessed" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
    const events = await broker.events();
    expect(events.some((event) => event.kind === "secret")).toBe(true);
  });

  it("breaks the next model call when the credential is revoked mid-flight", async () => {
    const { url } = await withUpstream();
    const broker = await startBroker({
      CODIFY_ARK_UPSTREAM: url,
      CODIFY_ARK_KEY: "REAL-ARK-KEY",
      CODIFY_RUN_TOKEN: "codify-run-token",
    });
    const call = () =>
      fetch("http://127.0.0.1:" + broker.port + "/ark/responses", {
        method: "POST",
        headers: { authorization: "Bearer codify-run-token" },
        body: "{}",
      });

    expect((await call()).status).toBe(200);
    await writeFile(broker.revocationPath, "revoked", "utf8");
    expect((await call()).status).toBe(403);
  });

  it("does not proxy arbitrary origin-form requests", async () => {
    const broker = await startBroker({ CODIFY_ALLOWED_DOMAINS: "github.com" });
    const response = await fetch("http://127.0.0.1:" + broker.port + "/etc/passwd");
    expect(response.status).toBe(404);
  });
});
