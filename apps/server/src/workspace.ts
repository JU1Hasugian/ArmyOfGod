import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

/** Directories a reviewer is never inspecting, and one that leaks transcripts. */
const SKIP_DIRECTORIES = new Set([".codex", ".git", "node_modules", "dist"]);

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

  /**
   * Where a given person's run actually executes.
   *
   * One directory per principal, under the Agent. A promoted specialist is a
   * single Agent everybody routes to, so an Agent-wide workspace is both a
   * cross-user read and a collision: the second person's run overwrites the
   * first person's output. The transcript and the Codex thread were keyed by
   * principal for exactly that reason; this is the same fix for the third
   * shared thing.
   *
   * Derivation is unaffected, which is the part worth stating. Observations
   * record paths workspace-relative, so Alice's `finance/q1.csv` and Bob's
   * `finance/q1.csv` are both recorded as `finance/q1.csv` and collapse to
   * `finance` exactly as before. Splitting the root does not split the evidence.
   */
  workspacePathFor(agentId: string, userId: string): string {
    // The principal arrives from a header, so it must not be able to climb out
    // of the Agent's directory or collide with a sibling by encoding one.
    // Stripping separators is not enough on its own: `.` survives a character
    // filter, so a principal literally named `..` would resolve to the Agent's
    // parent. Anything that is only dots is not a name.
    const filtered = userId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
    const safe = /^\.+$/.test(filtered) || filtered === "" ? "unknown" : filtered;
    return path.join(this.root, agentId, safe);
  }

  /**
   * Create and seed this principal's workspace the first time they run.
   *
   * Lazy rather than eager: an Agent does not know who will route to it, and
   * pre-creating one per known principal would seed workspaces for people who
   * never arrive.
   */
  async ensureFor(agent: Agent, userId: string): Promise<string> {
    const directory = this.workspacePathFor(agent.id, userId);
    try {
      if ((await stat(directory)).isDirectory()) return directory;
    } catch {
      /* first run for this principal */
    }
    await mkdir(directory, { recursive: true });
    await this.copyFixtures(directory);
    await this.writeInstructionsTo(directory, agent);
    await this.writeScaffold(directory, agent);
    return directory;
  }

  /** Every principal workspace that exists under an Agent. */
  async principalWorkspaces(agentId: string): Promise<string[]> {
    try {
      const entries = await readdir(path.join(this.root, agentId), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(this.root, agentId, entry.name));
    } catch {
      return [];
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  /**
   * Only the container. The per-principal workspaces inside it are seeded by
   * `ensureFor` when somebody actually runs, because at creation time nobody
   * knows who will route here.
   */
  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
  }

  private async writeScaffold(directory: string, agent: Agent): Promise<void> {
    await writeFile(
      path.join(directory, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(directory, "README.md"),
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

  async writeInstructionsTo(directory: string, agent: Agent): Promise<void> {
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
    await writeFile(path.join(directory, "AGENTS.md"), content, "utf8");
  }

  /**
   * Regenerate AGENTS.md everywhere it exists.
   *
   * The brief is per-Agent, the workspaces are per-principal, so an edit has
   * to reach every one of them or somebody keeps running the old brief.
   */
  async writeInstructions(agent: Agent): Promise<void> {
    for (const directory of await this.principalWorkspaces(agent.id)) {
      await this.writeInstructionsTo(directory, agent);
    }
  }

  /**
   * What is in a workspace, so the browser can show the artefact rather than
   * the Agent's claim about it.
   *
   * The platform's own methodology note says to compare the files a run
   * produced and not the chat message describing them — and until this existed
   * the UI could only show the message. A refused write is the same story from
   * the other side: "the directory is unchanged" is a claim without a listing.
   *
   * Read-only, and deliberately so. There is no upload path here for the reason
   * §11 of the design doc gives: staging bytes into a workspace belongs to a
   * deployment, and an ingress would itself need governing.
   */
  async list(
    workspacePath: string,
    limit = 400,
  ): Promise<{ path: string; size: number; modifiedAt: string }[]> {
    const root = path.resolve(workspacePath);
    const found: { path: string; size: number; modifiedAt: string }[] = [];

    const walk = async (directory: string): Promise<void> => {
      if (found.length >= limit) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return; // A directory that vanished mid-walk is not an error worth raising.
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (found.length >= limit) return;
        // `.codex` holds session transcripts, and the rest is noise nobody is
        // inspecting a governed run to see.
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const info = await stat(absolute);
          found.push({
            path: path.relative(root, absolute).split(path.sep).join("/"),
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        } catch {
          /* raced with a delete */
        }
      }
    };

    await walk(root);
    return found;
  }

  /**
   * One file's text.
   *
   * `relative` arrives from the browser, so it is resolved against the
   * workspace and then checked to still be inside it. `../` and an absolute
   * path both fail that check rather than being sanitised, because a rejected
   * request is legible and a rewritten one is not.
   */
  async read(
    workspacePath: string,
    relative: string,
    maxBytes = 256 * 1024,
  ): Promise<{ path: string; content: string; size: number; truncated: boolean }> {
    const root = path.resolve(workspacePath);
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("Path is outside the workspace");
    }
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Not a file");
    const buffer = await readFile(resolved);
    const slice = buffer.subarray(0, maxBytes);
    return {
      path: path.relative(root, resolved).split(path.sep).join("/"),
      // Anything that is not text reads as replacement characters rather than
      // pretending to have failed; the size is shown either way.
      content: slice.toString("utf8"),
      size: info.size,
      truncated: info.size > slice.length,
    };
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
