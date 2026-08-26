import { cp, mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  /**
   * @param fixturesDirectory A mock resource set copied into every new
   *   workspace. Detection is seeded with observed runs so the review queue is
   *   populated at t=0; without the matching files, those tasks route correctly
   *   and then find nothing to read, which makes the governed run look broken
   *   rather than governed. Pass `null` to create bare workspaces.
   */
  constructor(
    private readonly root: string,
    private readonly fixturesDirectory: string | null = null,
  ) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.copyFixtures(agent.workspacePath);
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  /**
   * Copy the mock resource set in, if one is configured and present.
   *
   * Never fatal: a missing or unreadable fixtures directory leaves a bare
   * workspace, because failing Agent creation over demo data would trade a
   * cosmetic problem for a functional one. Existing files are not overwritten,
   * so anything the platform writes afterwards wins.
   */
  private async copyFixtures(destination: string): Promise<void> {
    if (!this.fixturesDirectory) return;
    try {
      const entry = await stat(this.fixturesDirectory);
      if (!entry.isDirectory()) return;
    } catch {
      return;
    }
    try {
      await cp(this.fixturesDirectory, destination, {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
    } catch {
      // A partial copy is still more useful than no workspace at all.
    }
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
