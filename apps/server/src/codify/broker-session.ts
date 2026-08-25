/**
 * Mechanism ⑤ — the enforcement boundary's lifecycle.
 *
 * One broker per run. Each run gets its own `--internal` network and its own
 * broker container, so a run's allowlist and its brokered credential are scoped
 * to that run and torn down with it. Per-run isolation costs about a second of
 * container start-up, which is noise next to a model turn, and it removes the
 * need to demultiplex concurrent runs inside a shared broker.
 *
 * Topology:
 *
 *   run container ──(only network)──> codify-net-<run>  (--internal, no route out)
 *                                            │
 *                                     broker container ──> bridge ──> internet
 *
 * The run container cannot route anywhere except the broker. Setting
 * HTTP(S)_PROXY inside it is a convenience for well-behaved clients, not the
 * control: an agent that ignores the proxy reaches nothing at all.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { BrokerEvent, BrokerMode, CapabilityScope } from "./types.js";

const execFileAsync = promisify(execFile);

/** DNS alias the run container uses to reach its broker. */
export const BROKER_ALIAS = "codify-broker";
export const BROKER_PORT = 8080;
/** Every run container points Codex here; the alias resolves per-run. */
export const BROKER_ARK_BASE_URL = "http://" + BROKER_ALIAS + ":" + BROKER_PORT + "/ark";
export const BROKER_PROXY_URL = "http://" + BROKER_ALIAS + ":" + BROKER_PORT;

export const CODIFY_LABEL = "io.codejam.codify";

export interface BrokerSessionOptions {
  engine: string;
  runId: string;
  instanceId: string;
  mode: BrokerMode;
  scope: CapabilityScope;
  image: string;
  brokerScriptPath: string;
  eventRoot: string;
  arkUpstream: string;
  arkKey: string;
  containerUser: string;
  contractId?: string | undefined;
  contractVersion?: number | undefined;
  environment: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

function shortId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || randomUUID().slice(0, 12);
}

export class BrokerSession {
  private stopped = false;

  private constructor(
    private readonly options: BrokerSessionOptions,
    readonly networkName: string,
    readonly containerName: string,
    readonly runToken: string,
    private readonly eventLogPath: string,
    private readonly revocationPath: string,
  ) {}

  private static run(
    engine: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
    timeout = 20_000,
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(engine, args, { timeout, env: environment });
  }

  static async start(options: BrokerSessionOptions): Promise<BrokerSession> {
    const suffix = shortId(options.runId);
    const networkName = "codify-net-" + options.instanceId + "-" + suffix;
    const containerName = "codify-broker-" + options.instanceId + "-" + suffix;
    // The placeholder the run container receives in place of the real Ark key.
    const runToken = "codify-run-" + randomUUID().replace(/-/g, "");
    const eventDirectory = path.join(options.eventRoot, suffix);
    const eventLogPath = path.join(eventDirectory, "events.jsonl");
    const revocationPath = path.join(eventDirectory, "revoked");

    await mkdir(eventDirectory, { recursive: true });
    // Pre-create so the container appends to a host-owned file rather than
    // leaving a root-owned artefact behind.
    await writeFile(eventLogPath, "", { encoding: "utf8", mode: 0o666 });

    const session = new BrokerSession(
      options,
      networkName,
      containerName,
      runToken,
      eventLogPath,
      revocationPath,
    );

    try {
      await BrokerSession.run(
        options.engine,
        [
          "network", "create", "--internal",
          "--label", CODIFY_LABEL + "=network",
          "--label", "io.codejam.instance-id=" + options.instanceId,
          networkName,
        ],
        options.environment,
      );

      await BrokerSession.run(
        options.engine,
        [
          "run", "--detach", "--init",
          "--name", containerName,
          "--label", CODIFY_LABEL + "=broker",
          "--label", "io.codejam.instance-id=" + options.instanceId,
          "--network", networkName,
          "--network-alias", BROKER_ALIAS,
          "--user", options.containerUser,
          "--security-opt", "no-new-privileges",
          "--cap-drop", "ALL",
          "--env", "CODIFY_RUN_ID=" + options.runId,
          "--env", "CODIFY_MODE=" + options.mode,
          "--env", "CODIFY_ALLOWED_DOMAINS=" + options.scope.domains.join(","),
          "--env", "CODIFY_EVENT_LOG=/codify/events.jsonl",
          "--env", "CODIFY_REVOCATION_FILE=/codify/revoked",
          "--env", "CODIFY_ARK_UPSTREAM=" + options.arkUpstream,
          // Name-only form for both credentials: the values are supplied
          // through the spawned process environment instead, so neither the
          // real provider key nor the run's bearer token appears in the engine
          // command line, in `docker inspect`, or in the host process list.
          "--env", "CODIFY_ARK_KEY",
          "--env", "CODIFY_RUN_TOKEN",
          "--env", "CODIFY_BROKER_PORT=" + BROKER_PORT,
          ...(options.contractId ? ["--env", "CODIFY_CONTRACT_ID=" + options.contractId] : []),
          ...(options.contractVersion
            ? ["--env", "CODIFY_CONTRACT_VERSION=" + options.contractVersion]
            : []),
          "--mount",
          "type=bind,src=" + options.brokerScriptPath + ",dst=/codify/codify-broker.mjs,readonly",
          "--mount", "type=bind,src=" + eventDirectory + ",dst=/codify",
          options.image,
          "node", "/codify/codify-broker.mjs",
        ],
        {
          ...options.environment,
          CODIFY_ARK_KEY: options.arkKey,
          CODIFY_RUN_TOKEN: runToken,
        },
      );

      // Give the broker its route out. The run container never joins this.
      await BrokerSession.run(
        options.engine,
        ["network", "connect", "bridge", containerName],
        options.environment,
      );

      await session.waitUntilListening(options.startupTimeoutMs ?? 15_000);
      return session;
    } catch (error) {
      await session.stop();
      throw error;
    }
  }

  /**
   * The broker records `broker_started` as its first action after `listen`, so
   * the evidence file doubles as the readiness signal. This avoids needing any
   * network path from the control plane to the broker.
   */
  private async waitUntilListening(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = await this.readEvents();
      if (events.some((event) => event.type === "broker_started")) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(
      "Codify broker did not start within " +
        timeoutMs +
        " ms; refusing to run unbrokered (fail closed)",
    );
  }

  async readEvents(): Promise<BrokerEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.eventLogPath, "utf8");
    } catch {
      return [];
    }
    const events: BrokerEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as BrokerEvent);
      } catch {
        /* A torn final line just means the broker is mid-append. */
      }
    }
    return events;
  }

  /** Live revocation: the next brokered model call fails, visibly. */
  async revoke(): Promise<void> {
    await writeFile(this.revocationPath, new Date().toISOString(), "utf8");
  }

  /**
   * Non-secret proxy variables for the run container. Safe to pass inline in
   * argv. The brokered credential is `runToken` and travels via the spawned
   * process environment instead, so it never appears in the engine command line.
   */
  proxyEnvironment(): Record<string, string> {
    return {
      HTTP_PROXY: BROKER_PROXY_URL,
      HTTPS_PROXY: BROKER_PROXY_URL,
      http_proxy: BROKER_PROXY_URL,
      https_proxy: BROKER_PROXY_URL,
      NO_PROXY: BROKER_ALIAS,
      no_proxy: BROKER_ALIAS,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const { engine, environment } = this.options;
    await BrokerSession.run(engine, ["rm", "--force", this.containerName], environment).catch(
      () => undefined,
    );
    await BrokerSession.run(engine, ["network", "rm", this.networkName], environment).catch(
      () => undefined,
    );
  }

  /** Remove the run's evidence spool once it has been folded into the store. */
  async cleanupEvidence(): Promise<void> {
    await rm(path.dirname(this.eventLogPath), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** Remove broker containers and networks orphaned by a crash or a hard stop. */
export async function reapOrphanedBrokers(
  engine: string,
  instanceId: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const filters = [
    "--filter", "label=" + CODIFY_LABEL + "=broker",
    "--filter", "label=io.codejam.instance-id=" + instanceId,
  ];
  try {
    const { stdout } = await execFileAsync(
      engine,
      ["ps", "--all", "--quiet", ...filters],
      { timeout: 10_000, env: environment },
    );
    for (const id of stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      await execFileAsync(engine, ["rm", "--force", id], {
        timeout: 10_000,
        env: environment,
      }).catch(() => undefined);
    }
  } catch {
    /* No engine, or nothing to reap. */
  }
  try {
    const { stdout } = await execFileAsync(
      engine,
      [
        "network", "ls", "--quiet",
        "--filter", "label=" + CODIFY_LABEL + "=network",
        "--filter", "label=io.codejam.instance-id=" + instanceId,
      ],
      { timeout: 10_000, env: environment },
    );
    for (const id of stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      await execFileAsync(engine, ["network", "rm", id], {
        timeout: 10_000,
        env: environment,
      }).catch(() => undefined);
    }
  } catch {
    /* Networks still referenced by a live container are skipped. */
  }
}
