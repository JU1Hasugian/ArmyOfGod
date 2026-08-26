import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import {
  diffWorkspace,
  pathsNamedByCommands,
  snapshotWorkspace,
} from "./codify/workspace-diff.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  /**
   * The shell commands Codex reported running.
   *
   * Kept because the filesystem cannot answer "what did this run read?" on its
   * own: `atime` is the only durable trace, and almost every Linux mount is
   * `relatime`, which stops updating it once it is newer than `mtime`. A run
   * that reads a file a second time leaves no mark at all, so a read set built
   * from `atime` alone is not merely approximate — it is systematically empty
   * for every run after the first. `cat finance/NOTES.md` is unambiguous.
   */
  commands: string[];
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
    if (item.type === "command_execution" && typeof item.command === "string") {
      parsed.commands.push(item.command);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    // Observation is not the container's job — it is a before/after read of the
    // workspace, and it works the same whether Codex runs in a container or as
    // a host process. Only the container runner used to do it, so on this path
    // every derived scope came back empty: the platform learned nothing about
    // what a task touched, and a promoted contract said "no egress, workspace
    // read-only" because nothing had been seen rather than because nothing
    // happened.
    const before = request.onEvidence
      ? await snapshotWorkspace(request.workspacePath).catch(() => null)
      : null;

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
      commands: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
      // In `finally`, because a denied or failed run is exactly the one whose
      // evidence matters most. There is no broker on this path and no managed
      // secret is injected, so those arrive empty rather than absent.
      if (request.onEvidence) {
        let pathsWritten: string[] = [];
        let pathsRead: string[] = [];
        try {
          if (before) {
            const after = await snapshotWorkspace(request.workspacePath);
            const delta = diffWorkspace(before, after);
            pathsWritten = delta.pathsWritten;
            // Unioned with what the commands named, because `atime` alone goes
            // silent after a file's first read under `relatime` and would leave
            // the task's own inputs out of its derived scope.
            const written = new Set(pathsWritten);
            pathsRead = [
              ...new Set([...delta.pathsRead, ...pathsNamedByCommands(parsed.commands, after)]),
            ]
              .filter((entry) => !written.has(entry))
              .sort();
          }
        } catch {
          /* Evidence collection must never mask the run's own outcome. */
        }
        request.onEvidence({
          brokerEvents: [],
          pathsWritten,
          pathsRead,
          secretsGranted: [],
        });
      }
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
