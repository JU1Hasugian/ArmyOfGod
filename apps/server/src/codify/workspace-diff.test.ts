import { describe, expect, it } from "vitest";
import { pathsNamedByCommands, pathsRefusedByOutput } from "./workspace-diff.js";

describe("reading a run's filesystem evidence", () => {
  it("recovers the path a read-only mount refused", () => {
    const refused = pathsRefusedByOutput([
      "cp: cannot create regular file './finance/backup.md': Read-only file system",
      "all good here",
    ]);
    expect(refused).toEqual(["finance/backup.md"]);
  });

  it("strips the container's mount prefix", () => {
    expect(
      pathsRefusedByOutput([
        "bash: /workspace/repo/notes.md: Read-only file system",
      ]),
    ).toEqual(["repo/notes.md"]);
  });

  it("says nothing when nothing was refused", () => {
    expect(pathsRefusedByOutput(["wrote out/summary.md", ""])).toEqual([]);
  });

  it("keeps only command paths that exist in the workspace", () => {
    const present = new Map([
      ["finance/NOTES.md", { size: 1, mtimeMs: 1, atimeMs: 1 }],
    ]);
    const named = pathsNamedByCommands(
      ["/bin/bash -lc 'cat finance/NOTES.md'", "/bin/bash -lc 'cat finance/ghost.md'"],
      present,
    );
    // A token that merely looks like a path cannot widen anything.
    expect(named).toEqual(["finance/NOTES.md"]);
  });
});
