import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { agentCodexHome, isCodifyActive, writeCodexConfig, type AppConfig } from "./config.js";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import { BrokerSession } from "./codify/broker-session.js";
import {
  diffWorkspace,
  pathsNamedByCommands,
  pathsRefusedByOutput,
  snapshotWorkspace,
} from "./codify/workspace-diff.js";
import type { BrokerEvent, CapabilityScope } from "./codify/types.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunEvidence,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  /** Which Agent this container belongs to, so `cancel` can find them all. */
  agentId: string;
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  commands: string[];
  outputs: string[];
}

export function containerName(
  agentId: string,
  instanceId = "default",
  runId?: string,
): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  const base = "launchpad-" + safeInstance + "-" + safeAgent;
  // The Agent is shared; the container is not. Without the run, two principals
  // on one specialist collide on the daemon's name registry.
  if (!runId) return base;
  return base + "-" + runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
}

/**
 * Everything the container launch needs from a live BrokerSession in order to
 * enforce a scope. Kept as plain data so `buildContainerRunArgs` stays a pure
 * function that can be unit-tested without an engine.
 */
export interface ScopedLaunch {
  /** The run's `--internal` network. It has no route off-host. */
  networkName: string;
  /** Non-secret proxy variables, safe to appear inline in argv. */
  proxyEnvironment: Record<string, string>;
  scope: CapabilityScope;
  /** Per-Agent Codex home, so sessions are not shared between Agents. */
  codexHome: string;
  /** Managed secrets granted to this run. Names only — values never hit argv. */
  secretNames: string[];
}

/** True when the scope leaves the whole workspace writable, i.e. is not narrowed. */
export function scopeCoversWholeWorkspace(scope: CapabilityScope): boolean {
  return scope.paths.some((entry) => entry.mode === "rw" && entry.path === ".");
}

/** Workspace-relative directories a scope makes writable, root excluded. */
export function writableScopePaths(scope: CapabilityScope): string[] {
  return scope.paths
    .filter((entry) => entry.mode === "rw" && entry.path !== "." && entry.path !== "")
    .map((entry) => entry.path);
}

/**
 * Filesystem scope is enforced by how the workspace is mounted, not by asking
 * Codex to behave: the workspace root goes in read-only and each writable
 * subpath is layered back over it read-write. A write anywhere else fails with
 * EROFS in the kernel.
 *
 * This is deliberately the layer below Codex's own sandbox. `CODEX_SANDBOX_MODE`
 * falls back to `danger-full-access` on kernels without Landlock — the Starter
 * Kit says so itself — and on those kernels these mounts are the only per-Agent
 * filesystem boundary there is.
 */
function workspaceMounts(request: RunnerRequest, launch: ScopedLaunch): string[] {
  if (scopeCoversWholeWorkspace(launch.scope)) {
    return ["--mount", "type=bind,src=" + request.workspacePath + ",dst=/workspace"];
  }
  const mounts = [
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace,readonly",
  ];
  for (const relativePath of writableScopePaths(launch.scope)) {
    mounts.push(
      "--mount",
      "type=bind,src=" +
        path.join(request.workspacePath, relativePath) +
        ",dst=" +
        path.posix.join("/workspace", relativePath),
    );
  }
  return mounts;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
  launch?: ScopedLaunch,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId, request.runId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const codexHome = launch?.codexHome ?? config.codexHome;
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    // Scoped runs attach only to their own `--internal` network, which has no
    // route out. Unscoped runs keep the baseline bridge.
    launch ? launch.networkName : "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    // Name-only form: the value comes from the spawned process environment, so
    // no credential is ever visible in the engine's argv.
    "--env",
    "ARK_API_KEY",
    ...(launch?.secretNames ?? []).flatMap((secret) => ["--env", secret]),
    ...Object.entries(launch?.proxyEnvironment ?? {}).flatMap(([key, value]) => [
      "--env",
      key + "=" + value,
    ]),
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    ...(launch
      ? workspaceMounts(request, launch)
      : ["--mount", "type=bind,src=" + request.workspacePath + ",dst=/workspace"]),
    "--mount",
    "type=bind,src=" + codexHome + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();
  private readonly sessions = new Map<string, BrokerSession>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Stops every container this Agent currently has, whoever started it. */
  async cancel(agentId: string): Promise<boolean> {
    const running = [...this.active.values()].filter((entry) => entry.agentId === agentId);
    if (running.length === 0) return false;

    await Promise.all(
      running.map(async (active) => {
        active.cancelled = true;
        await this.removeContainer(active);
        await active.settled;
      }),
    );
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          active.child.kill("SIGTERM");
          const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          forceKill.unref();
        });
    }
    return active.termination;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.runId)) {
      throw new Error("This run already has an active Runtime container");
    }
    const binding = isCodifyActive(this.config) ? request.codify : undefined;
    if (!binding) return this.execute(request);

    // Each Agent gets its own Codex home, so one Agent cannot read another's
    // sessions or rewrite the shared provider configuration.
    const codexHome = agentCodexHome(this.config, request.agentId);
    await mkdir(codexHome, { recursive: true });
    await writeCodexConfig(this.config, codexHome);

    // Bind mounts fail on a missing source, and the engine would otherwise
    // create them as root. Materialise writable scope paths as the app user.
    for (const relativePath of writableScopePaths(binding.scope)) {
      await mkdir(path.join(request.workspacePath, relativePath), { recursive: true });
    }

    const before = await snapshotWorkspace(request.workspacePath);
    // Filled by the event parser further down and read by `publishEvidence`,
    // which is defined before the parser exists. Shared by reference so the
    // read set can be widened by what the commands named — `atime` stops
    // recording reads under `relatime` after the first one.
    const commandLog: string[] = [];
    const outputLog: string[] = [];
    const secretNames = binding.scope.secrets.filter(
      (name) => this.config.codifyManagedSecrets[name] !== undefined,
    );
    const secretValues: Record<string, string> = {};
    for (const name of secretNames) {
      secretValues[name] = this.config.codifyManagedSecrets[name] as string;
    }

    // Fail closed: if the broker cannot start, this throws and the run fails.
    // There is deliberately no path here that falls back to unbrokered network.
    const session = await BrokerSession.start({
      engine: this.config.containerEngine,
      runId: binding.runId,
      instanceId: this.config.runtimeInstanceId,
      mode: binding.mode,
      scope: binding.scope,
      image: this.config.codifyBrokerImage,
      brokerScriptPath: this.config.codifyBrokerScript,
      eventRoot: this.config.codifyEventRoot,
      arkUpstream: this.config.arkBaseUrl,
      arkKey: this.config.arkApiKey,
      containerUser: this.config.containerUser,
      contractId: binding.contractId,
      contractVersion: binding.contractVersion,
      environment: this.childEnvironment(),
    });
    this.sessions.set(request.agentId, session);

    let evidencePublished = false;
    const publishEvidence = async (): Promise<void> => {
      if (evidencePublished || !request.onEvidence) return;
      evidencePublished = true;
      let brokerEvents: BrokerEvent[] = [];
      let pathsWritten: string[] = [];
      let pathsRead: string[] = [];
      try {
        brokerEvents = await session.readEvents();
        const after = await snapshotWorkspace(request.workspacePath);
        const delta = diffWorkspace(before, after);
        pathsWritten = delta.pathsWritten;
        const written = new Set(pathsWritten);
        pathsRead = [
          ...new Set([...delta.pathsRead, ...pathsNamedByCommands(commandLog, after)]),
        ]
          .filter((entry) => !written.has(entry))
          .sort();
      } catch {
        /* Evidence collection must never mask the run's own outcome. */
      }
      request.onEvidence({
        brokerEvents,
        pathsWritten,
        pathsRead,
        secretsGranted: secretNames,
        pathsRefused: pathsRefusedByOutput(outputLog),
      });
    };

    try {
      return await this.execute(
        request,
        {
          networkName: session.networkName,
          proxyEnvironment: session.proxyEnvironment(),
          scope: binding.scope,
          codexHome,
          secretNames,
        },
        // The container receives a per-run placeholder, never the real Ark key.
        { ARK_API_KEY: session.runToken, ...secretValues },
        commandLog,
        outputLog,
      );
    } finally {
      await publishEvidence();
      this.sessions.delete(request.agentId);
      await session.stop();
      await session.cleanupEvidence();
    }
  }

  private async execute(
    request: RunnerRequest,
    launch?: ScopedLaunch,
    extraEnvironment: Record<string, string> = {},
    // Shared by reference with the caller's evidence step, which runs after
    // this returns and needs the commands the turn reported.
    commandLog: string[] = [],
    outputLog: string[] = [],
  ): Promise<RunnerResult> {
    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config, launch),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(extraEnvironment),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: containerName(
        request.agentId,
        this.config.runtimeInstanceId,
        request.runId,
      ),
      agentId: request.agentId,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
    };
    this.active.set(request.runId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
      commands: commandLog,
      outputs: outputLog,
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        void this.removeContainer(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) parseCodexEventLine(line, parsed);
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) parseCodexEventLine(stdout.trim(), parsed);
      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error(
          this.config.containerEngine +
            " Runtime exited with code " +
            exitCode +
            ": " +
            detail,
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) throw new Error("Codex completed without an agent message");
      return { output, threadId: parsed.threadId, usage: parsed.usage };
    } finally {
      clearTimeout(timeout);
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(
    overrides: Record<string, string> = {},
  ): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return { ...environment, ...overrides };
  }
}
