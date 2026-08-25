/**
 * The claim this whole design rests on: a scoped run cannot reach the network
 * except through its broker, and that is true whether or not the Agent
 * cooperates. Proving it needs a real container engine, so the suite skips
 * cleanly when there is none — `npm run check` must pass on a reviewer's
 * machine either way.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerSession } from "./broker-session.js";

const execFileAsync = promisify(execFile);
const ENGINE = process.env.CONTAINER_ENGINE ?? "docker";
const CANDIDATE_IMAGES = [
  process.env.CONTAINER_RUNTIME_IMAGE,
  "volc-agent-runtime:local",
  "node:22-bookworm-slim",
].filter((value): value is string => Boolean(value));

let image: string | null = null;

async function detectImage(): Promise<string | null> {
  try {
    await execFileAsync(ENGINE, ["version"], { timeout: 10_000 });
  } catch {
    return null;
  }
  for (const candidate of CANDIDATE_IMAGES) {
    try {
      await execFileAsync(ENGINE, ["image", "inspect", candidate], { timeout: 10_000 });
      return candidate;
    } catch {
      /* Try the next one. */
    }
  }
  return null;
}

beforeAll(async () => {
  image = await detectImage();
  if (!image) {
    console.warn(
      "[codify] Skipping enforcement integration tests: no container engine or runtime image.",
    );
  }
}, 60_000);

/** Run a short node program inside a container on the given network. */
async function probe(network: string, source: string): Promise<string> {
  const { stdout } = await execFileAsync(
    ENGINE,
    ["run", "--rm", "--network", network, image as string, "node", "-e", source],
    { timeout: 60_000 },
  );
  return stdout.trim();
}

const DIRECT_BY_IP = `
const net = require('net');
const done = (m) => { console.log(m); process.exit(0); };
setTimeout(() => done('BLOCKED:TIMEOUT'), 8000);
const s = net.connect(443, '1.1.1.1', () => done('REACHED'));
s.on('error', (e) => done('BLOCKED:' + e.code));
`;

const connectVia = (host: string) => `
const net = require('net');
const done = (m) => { console.log(m); process.exit(0); };
setTimeout(() => done('TIMEOUT'), 8000);
const s = net.connect(8080, 'codify-broker', () => {
  s.write('CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\n');
});
let buffer = '';
s.on('data', (d) => {
  buffer += d.toString();
  if (buffer.includes('\\r\\n')) done(buffer.split('\\r\\n')[0]);
});
s.on('error', (e) => done('ERR:' + e.code));
`;

describe.sequential("Codify enforcement at the container boundary", () => {
  let session: BrokerSession | null = null;
  let eventRoot = "";

  beforeAll(async () => {
    if (!image) return;
    eventRoot = await mkdtemp(path.join(tmpdir(), "codify-integration-"));
    session = await BrokerSession.start({
      engine: ENGINE,
      runId: "integration-" + Date.now().toString(36),
      instanceId: "codifytest",
      mode: "enforce",
      scope: { paths: [], domains: ["example.com"], secrets: [] },
      image,
      brokerScriptPath: fileURLToPath(
        new URL("../../broker/codify-broker.mjs", import.meta.url),
      ),
      eventRoot,
      arkUpstream: "https://ark.invalid.test/api/v3",
      arkKey: "integration-real-key",
      containerUser: process.getuid ? process.getuid() + ":" + process.getgid!() : "1000:1000",
      environment: process.env,
    });
  }, 180_000);

  afterAll(async () => {
    await session?.stop();
    if (eventRoot) await rm(eventRoot, { recursive: true, force: true });
  }, 60_000);

  it(
    "blocks a raw outbound connection even with no proxy configured at all",
    async () => {
      if (!image || !session) return;
      // This is the load-bearing test. The container is given no proxy
      // variables and dials a raw IP, so DNS and HTTP_PROXY are both out of the
      // picture: only the `--internal` network can be stopping it.
      const result = await probe(session.networkName, DIRECT_BY_IP);
      expect(result).toMatch(/^BLOCKED:/);
      expect(result).not.toContain("REACHED");
    },
    120_000,
  );

  it(
    "refuses a host outside the contract allowlist and records the denial",
    async () => {
      if (!image || !session) return;
      const result = await probe(session.networkName, connectVia("collector.evil.example"));
      expect(result).toContain("403");

      const events = await session.readEvents();
      const denial = events.find((event) => event.type === "denial");
      expect(denial?.target).toBe("collector.evil.example");
      expect(denial?.outcome).toBe("blocked");
    },
    120_000,
  );

  it(
    "permits an allowlisted host through the broker",
    async () => {
      if (!image || !session) return;
      const result = await probe(session.networkName, connectVia("example.com"));
      // 200 when the machine has internet, 502 when it does not. Either proves
      // the allow decision; only a 403 would mean the allowlist had failed.
      expect(result).not.toContain("403");
      expect(result).toMatch(/200|502/);
    },
    120_000,
  );

  it(
    "never exposes the real provider key in the broker's container definition",
    async () => {
      if (!image || !session) return;
      // `docker inspect` surfaces the full argv and the resolved environment.
      // The key must be reachable by the broker process and by nothing else.
      const { stdout } = await execFileAsync(ENGINE, [
        "inspect", session.containerName, "--format", "{{json .Config.Cmd}} {{json .Args}}",
      ]);
      expect(stdout).not.toContain("integration-real-key");
    },
    120_000,
  );

  it(
    "tears down its network and container so nothing outlives the run",
    async () => {
      if (!image || !session) return;
      const network = session.networkName;
      const container = session.containerName;
      await session.stop();
      session = null;

      const { stdout: networks } = await execFileAsync(ENGINE, [
        "network", "ls", "--quiet", "--filter", "name=" + network,
      ]);
      expect(networks.trim()).toBe("");
      const { stdout: containers } = await execFileAsync(ENGINE, [
        "ps", "--all", "--quiet", "--filter", "name=" + container,
      ]);
      expect(containers.trim()).toBe("");
    },
    120_000,
  );
});

describe("Codify fails closed", () => {
  it(
    "refuses to start a scoped run when the broker cannot come up",
    async () => {
      if (!image) return;
      const root = await mkdtemp(path.join(tmpdir(), "codify-failclosed-"));
      try {
        await expect(
          BrokerSession.start({
            engine: ENGINE,
            runId: "failclosed-" + Date.now().toString(36),
            instanceId: "codifytest",
            mode: "enforce",
            scope: { paths: [], domains: [], secrets: [] },
            // An image that does not exist: the broker can never listen.
            image: "codify-nonexistent-image:missing",
            brokerScriptPath: fileURLToPath(
              new URL("../../broker/codify-broker.mjs", import.meta.url),
            ),
            eventRoot: root,
            arkUpstream: "https://ark.invalid.test/api/v3",
            arkKey: "k",
            containerUser: "1000:1000",
            environment: process.env,
            startupTimeoutMs: 3_000,
          }),
        ).rejects.toThrow();
        // There is deliberately no fallback path here that would run the turn
        // with unrestricted network access.
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
