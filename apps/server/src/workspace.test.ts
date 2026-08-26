import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

async function roots(): Promise<{ workspaces: string; fixtures: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-ws-"));
  temporaryDirectories.push(root);
  const workspaces = path.join(root, "workspaces");
  const fixtures = path.join(root, "fixtures");
  await mkdir(path.join(fixtures, "repo"), { recursive: true });
  await writeFile(path.join(fixtures, "repo", "CHANGELOG.md"), "# Changelog\n", "utf8");
  await writeFile(path.join(fixtures, "NOTES.md"), "notes\n", "utf8");
  return { workspaces, fixtures };
}

function agentAt(workspacePath: string): Agent {
  return {
    id: "agent-1",
    name: "Fixture",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Agent;
}

describe("workspace fixtures", () => {
  it("copies the mock resource set into a new workspace", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);

    expect(await readFile(path.join(agent.workspacePath, "repo", "CHANGELOG.md"), "utf8"))
      .toContain("Changelog");
    expect(await readFile(path.join(agent.workspacePath, "NOTES.md"), "utf8")).toContain("notes");
    // The platform's own files still land.
    expect(await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8")).toContain("Fixture");
  });

  it("creates a bare workspace when fixtures are disabled", async () => {
    const { workspaces } = await roots();
    const manager = new WorkspaceManager(workspaces, null);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);

    await expect(readFile(path.join(agent.workspacePath, "NOTES.md"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8")).toContain("Fixture");
  });

  it("still creates the workspace when the fixtures directory is missing", async () => {
    const { workspaces } = await roots();
    const manager = new WorkspaceManager(workspaces, path.join(workspaces, "does-not-exist"));
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);

    expect(await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8")).toContain("Fixture");
  });
});
