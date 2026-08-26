/**
 * Mechanism ② (filesystem half) — observing what a run actually touched.
 *
 * The Runtime container is disposable, so the only durable record of what it
 * did to the workspace is the workspace itself. Snapshotting before and after a
 * turn yields the write set exactly, and the read set approximately.
 *
 * Honest limits: writes are derived from size and mtime and are reliable.
 * Reads are derived from atime, which most Linux mounts update lazily under
 * `relatime`; treat `pathsRead` as a hint, never as an authority.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".codex",
  "dist",
  "build",
  ".cache",
]);

/**
 * Files the platform itself writes into every workspace.
 *
 * These are not the task's output and must not reach a derived scope: a
 * contract that grants `rw` on `.codex` is describing the platform's own
 * bookkeeping as though the task had asked for it. `.codex` is a *file* on the
 * host-process path and a directory under the container, so the directory set
 * above does not catch both.
 */
const IGNORED_FILES = new Set([".codex", "AGENTS.md"]);

/** Cap the walk so a runaway workspace cannot stall a turn. */
const MAX_ENTRIES = 5_000;

export interface FileStamp {
  size: number;
  mtimeMs: number;
  atimeMs: number;
}

export type WorkspaceSnapshot = Map<string, FileStamp>;

export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();

  async function walk(directory: string, relative: string): Promise<void> {
    if (snapshot.size >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.size >= MAX_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const relativePath = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(path.join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!relative && IGNORED_FILES.has(entry.name)) continue;
      try {
        const stats = await stat(path.join(directory, entry.name));
        snapshot.set(relativePath, {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          atimeMs: stats.atimeMs,
        });
      } catch {
        /* Raced with the Runtime deleting it; absence is itself a signal. */
      }
    }
  }

  await walk(root, "");
  return snapshot;
}

export interface WorkspaceDelta {
  pathsWritten: string[];
  pathsRead: string[];
}

export function diffWorkspace(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceDelta {
  const written: string[] = [];
  const read: string[] = [];

  for (const [relativePath, stamp] of after) {
    const previous = before.get(relativePath);
    if (!previous) {
      written.push(relativePath);
      continue;
    }
    if (previous.mtimeMs !== stamp.mtimeMs || previous.size !== stamp.size) {
      written.push(relativePath);
      continue;
    }
    // Unmodified but accessed since the snapshot: a best-effort read signal.
    if (stamp.atimeMs > previous.atimeMs) read.push(relativePath);
  }
  // A deletion is a write to the containing directory.
  for (const relativePath of before.keys()) {
    if (!after.has(relativePath)) written.push(relativePath);
  }

  return {
    pathsWritten: [...new Set(written)].sort(),
    pathsRead: [...new Set(read)].sort(),
  };
}

/**
 * Workspace paths named by the shell commands a run reported executing.
 *
 * The filesystem is a poor witness to reads. `atime` is the only durable trace
 * and `relatime` — the default on virtually every Linux mount — stops updating
 * it once it is newer than `mtime`, so only a run's *first* read of a file
 * leaves a mark. Derived scopes then omit the very inputs the task depends on,
 * and a contract ends up granting write access to its output directory while
 * denying read access to the data it summarises: a policy that would break the
 * task it was derived from.
 *
 * Codex reports each command it runs, and `cat finance/NOTES.md` says plainly
 * what was read. This extracts path-shaped tokens and keeps only those that
 * exist in the workspace, so a token that merely looks like a path cannot widen
 * anything. It is a *supplement* to the `atime` signal, unioned with it, never
 * a replacement — a run that reads a file through an editor rather than a shell
 * still leaves only the `atime` trace.
 *
 * Deliberately not a shell parser. It is a conservative reader of text that
 * happens to be a command, and it grants nothing on its own: the caller still
 * applies the frequency floor, and reads are the narrowest thing a scope can
 * carry.
 */
export function pathsNamedByCommands(
  commands: string[],
  present: WorkspaceSnapshot,
): string[] {
  const found = new Set<string>();
  for (const command of commands) {
    // Split on shell punctuation and quoting, keeping path characters.
    for (const raw of command.split(/[\s'"`;|&()<>]+/)) {
      if (!raw) continue;
      const token = raw.replace(/^\.\//, "").replace(/[,:]+$/, "");
      if (!token || token.startsWith("-")) continue;
      if (present.has(token)) found.add(token);
    }
  }
  return [...found].sort();
}
