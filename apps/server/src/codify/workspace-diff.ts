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
