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
  it("seeds the mock resource set into a principal's workspace on first run", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);

    // `create` builds only the container; the seeded workspace belongs to
    // whoever runs first, because at creation time nobody knows who that is.
    const workspace = await manager.ensureFor(agent, "user-a");

    expect(await readFile(path.join(workspace, "repo", "CHANGELOG.md"), "utf8"))
      .toContain("Changelog");
    expect(await readFile(path.join(workspace, "NOTES.md"), "utf8")).toContain("notes");
    // The platform's own files still land.
    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain("Fixture");
  });

  it("gives each principal their own copy, so neither can see the other", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);

    const alice = await manager.ensureFor(agent, "user-a");
    const bob = await manager.ensureFor(agent, "user-b");
    expect(alice).not.toBe(bob);

    await writeFile(path.join(alice, "secret.md"), "alice only", "utf8");

    // The point of the split: one person's output is not in the other's
    // workspace, and cannot overwrite it either.
    const bobFiles = (await manager.list(bob)).map((f) => f.path);
    expect(bobFiles).not.toContain("secret.md");
    expect((await manager.list(alice)).map((f) => f.path)).toContain("secret.md");
  });

  it("keeps the relative paths identical across principals, so derivation is unaffected", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);

    // The property the whole loop depends on. Splitting the root must not
    // split the evidence: scope derivation counts workspace-relative paths, so
    // two people reading "their own" file still agree on `repo/CHANGELOG.md`.
    const alice = (await manager.list(await manager.ensureFor(agent, "user-a"))).map((f) => f.path);
    const bob = (await manager.list(await manager.ensureFor(agent, "user-b"))).map((f) => f.path);
    expect(alice.sort()).toEqual(bob.sort());
    expect(alice).toContain("repo/CHANGELOG.md");
  });

  it("refuses to let a principal name escape the Agent's directory", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const root = manager.workspacePath("agent-1");

    // The principal arrives from a header, so a crafted one must not climb out
    // or collide with a sibling by encoding a separator.
    for (const hostile of ["../other-agent", "../../etc", "a/b", "..", ""]) {
      const resolved = manager.workspacePathFor("agent-1", hostile);
      expect(resolved.startsWith(root + path.sep)).toBe(true);
      // A ".." *segment* escapes; those characters inside a name do not.
      expect(path.relative(root, resolved).split(path.sep)).not.toContain("..");
    }
  });

  it("creates a bare workspace when fixtures are disabled", async () => {
    const { workspaces } = await roots();
    const manager = new WorkspaceManager(workspaces, null);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);
    const workspace = await manager.ensureFor(agent, "user-a");

    await expect(readFile(path.join(workspace, "NOTES.md"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain("Fixture");
  });

  it("still creates the workspace when the fixtures directory is missing", async () => {
    const { workspaces } = await roots();
    const manager = new WorkspaceManager(workspaces, path.join(workspaces, "does-not-exist"));
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);
    const workspace = await manager.ensureFor(agent, "user-a");

    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toContain("Fixture");
  });
});

/**
 * Reading a workspace back.
 *
 * The platform's own methodology says to compare the files a run produced and
 * not the chat message about them. Until this existed the browser could only
 * show the message, so the demo's central comparison needed a terminal and a
 * refused write could not be shown as "the directory is unchanged".
 */
describe("reading a workspace back", () => {
  it("lists files with their size, and skips transcripts and vendor noise", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);

    const workspace = await manager.ensureFor(agent, "user-a");
    await mkdir(path.join(workspace, "out"), { recursive: true });
    await writeFile(path.join(workspace, "out", "RELEASE.md"), "# notes", "utf8");
    // Both must stay out of the listing: one leaks session transcripts, the
    // other would bury the artefact under thousands of rows.
    await mkdir(path.join(workspace, ".codex", "sessions"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "sessions", "t.jsonl"), "{}", "utf8");
    await mkdir(path.join(workspace, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(workspace, "node_modules", "left-pad", "i.js"), "x", "utf8");

    const { files } = { files: await manager.list(workspace) };
    const paths = files.map((f) => f.path);

    expect(paths).toContain("out/RELEASE.md");
    expect(paths).toContain("AGENTS.md");
    expect(paths.some((f) => f.startsWith(".codex/"))).toBe(false);
    expect(paths.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files.find((f) => f.path === "out/RELEASE.md")?.size).toBeGreaterThan(0);
  });

  it("reads a file back", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);
    const workspace = await manager.ensureFor(agent, "user-a");
    await mkdir(path.join(workspace, "out"), { recursive: true });
    await writeFile(path.join(workspace, "out", "R.md"), "# release", "utf8");

    const file = await manager.read(workspace, "out/R.md");
    expect(file.content).toContain("# release");
    expect(file.truncated).toBe(false);
    expect(file.path).toBe("out/R.md");
  });

  it("refuses to read outside the workspace", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);
    // A secret that exists next to the workspace, which is where a real
    // deployment keeps them.
    await writeFile(path.join(workspaces, "secrets.txt"), "ARK_API_KEY=real", "utf8");

    // The path arrives from the browser, so both shapes have to fail rather
    // than be sanitised into something that happens to be safe.
    await expect(manager.read(agent.workspacePath, "../secrets.txt")).rejects.toThrow(/outside/i);
    await expect(
      manager.read(agent.workspacePath, "../../../../etc/passwd"),
    ).rejects.toThrow(/outside/i);
    await expect(
      manager.read(agent.workspacePath, path.join(workspaces, "secrets.txt")),
    ).rejects.toThrow(/outside/i);
  });

  it("truncates a large file instead of streaming it into the browser", async () => {
    const { workspaces, fixtures } = await roots();
    const manager = new WorkspaceManager(workspaces, fixtures);
    await manager.initialize();
    const agent = agentAt(manager.workspacePath("agent-1"));
    await manager.create(agent);
    await writeFile(path.join(agent.workspacePath, "big.txt"), "x".repeat(5000), "utf8");

    const file = await manager.read(agent.workspacePath, "big.txt", 1000);
    expect(file.content).toHaveLength(1000);
    expect(file.truncated).toBe(true);
    expect(file.size).toBe(5000);
  });
});
