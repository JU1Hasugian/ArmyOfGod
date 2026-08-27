import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRunner, buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import type { RunEvidence } from "./types.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

/**
 * The host-process runner has to observe the workspace too.
 *
 * Only the container runner used to, which meant every scope derived on the
 * local-process path came back empty — a promoted contract said "no egress,
 * workspace read-only" because nothing had been observed, not because the task
 * needed nothing. That is the design's central claim reading as a null result.
 *
 * The stand-in for Codex is a shell script, which `spawn` cannot execute on
 * Windows — it fails with `EFTYPE` before the runner is reached. The platform
 * targets Linux and the judging path is a container, but this project is
 * developed on a Windows host, so the suite skips there rather than failing:
 * a red `npm run check` on the machine the work happens on trains everyone to
 * ignore it. The same reason `enforcement.integration.test.ts` skips without a
 * container engine.
 */
describe.skipIf(process.platform === "win32")("host-process runner evidence", () => {
  it("reports the paths a turn wrote", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-runner-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(workspace, "data"), { recursive: true });
    await writeFile(path.join(workspace, "data", "in.csv"), "a,b\n1,2\n", "utf8");

    // A stand-in for Codex: reads a file, writes a file, then speaks the
    // protocol. The event lines live in their own file so the script needs no
    // nested quoting.
    const events = path.join(root, "events.jsonl");
    await writeFile(
      events,
      [
        JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "/bin/bash -lc cat data/in.csv" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Done." },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const fakeCodex = path.join(root, "fake-codex.sh");
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env bash",
        'mkdir -p "$PWD/out"',
        'printf summary > "$PWD/out/report.md"',
        'cat ' + JSON.stringify(events),
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);

    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: workspace,
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      CODEX_BIN: fakeCodex,
    });

    let evidence: RunEvidence | null = null;
    const result = await new CodexRunner(config).run({
      agentId: "agent-1",
      workspacePath: workspace,
      prompt: "write a report",
      threadId: null,
      onEvidence: (value) => {
        evidence = value;
      },
    });

    expect(result.output).toBe("Done.");
    expect(evidence).not.toBeNull();
    expect(evidence!.pathsWritten).toContain("out/report.md");
    // `cat` named an existing file, so it counts as a read even though
    // `relatime` may never have moved its atime.
    expect(evidence!.pathsRead).toContain("data/in.csv");
    // No broker and no managed secret on this path — empty, not absent.
    expect(evidence!.brokerEvents).toEqual([]);
    expect(evidence!.secretsGranted).toEqual([]);
  });
});
