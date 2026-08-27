import { describe, expect, it } from "vitest";
import {
  MAX_DERIVED_DOMAINS,
  checkNarrowing,
  collapsePaths,
  containingDirectory,
  deriveScope,
  normalizeScope,
} from "./scope.js";
import type { CapabilityObservation, CapabilityScope } from "./types.js";

function observation(
  partial: Partial<CapabilityObservation> & { runId: string },
): CapabilityObservation {
  return {
    agentId: "agent-1",
    domainsReached: [],
    pathsRead: [],
    pathsWritten: [],
    secretsRead: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("Codify scope derivation", () => {
  it("keeps a domain seen in most exemplars and drops a one-off", () => {
    const observations = Array.from({ length: 7 }, (_, index) =>
      observation({
        runId: "run-" + index,
        // github.com in all seven; the odd domain in exactly one.
        domainsReached: index === 3 ? ["github.com", "pastebin.example"] : ["github.com"],
      }),
    );
    const scope = deriveScope(observations);
    expect(scope.domains).toEqual(["github.com"]);
    expect(scope.domains).not.toContain("pastebin.example");
  });

  it("never derives a metadata endpoint, however often it is observed", () => {
    const observations = Array.from({ length: 5 }, (_, index) =>
      observation({
        runId: "run-" + index,
        domainsReached: ["169.254.169.254", "metadata.google.internal", "github.com"],
      }),
    );
    expect(deriveScope(observations).domains).toEqual(["github.com"]);
  });

  /**
   * Codex contacts its telemetry endpoint on every turn, so the host clears the
   * frequency floor in every family. Left in, every contract the platform ever
   * derives would grant a host no task asked for — and `ab.chatgpt.com` would
   * stop being refused at the broker, which is the clearest denial the design
   * has, and it is refused precisely because no contract names it.
   */
  it("keeps the Runtime's own telemetry out of a task's scope", () => {
    const observations = [1, 2, 3, 4].map((n) =>
      observation({
        runId: "run-" + n,
        domainsReached: ["ab.chatgpt.com", "api.frankfurter.dev"],
      }),
    );
    expect(deriveScope(observations).domains).toEqual(["api.frankfurter.dev"]);
  });

  it("caps the number of derived domains", () => {
    const many = Array.from({ length: 12 }, (_, index) => "host" + index + ".example");
    const observations = Array.from({ length: 4 }, (_, index) =>
      observation({ runId: "run-" + index, domainsReached: many }),
    );
    expect(deriveScope(observations).domains).toHaveLength(MAX_DERIVED_DOMAINS);
  });

  it("derives writable directories from written files and excludes credential paths", () => {
    const observations = Array.from({ length: 4 }, (_, index) =>
      observation({
        runId: "run-" + index,
        pathsWritten: ["out/RELEASE.md", "out/notes/summary.md", ".ssh/id_rsa"],
        pathsRead: ["repo/CHANGELOG.md"],
      }),
    );
    const scope = deriveScope(observations);
    expect(scope.paths).toContainEqual({ path: "out", mode: "rw" });
    expect(scope.paths).toContainEqual({ path: "repo", mode: "ro" });
    // `out/notes` is already covered by `out`, and `.ssh` is never derivable.
    expect(scope.paths.map((entry) => entry.path)).not.toContain("out/notes");
    expect(scope.paths.map((entry) => entry.path)).not.toContain(".ssh");
  });

  it("derives only the secrets that most exemplars actually used", () => {
    const observations = [
      observation({ runId: "a", secretsRead: ["GITHUB_TOKEN"] }),
      observation({ runId: "b", secretsRead: ["GITHUB_TOKEN"] }),
      observation({ runId: "c", secretsRead: ["GITHUB_TOKEN", "STRIPE_KEY"] }),
      observation({ runId: "d", secretsRead: ["GITHUB_TOKEN"] }),
    ];
    expect(deriveScope(observations).secrets).toEqual(["GITHUB_TOKEN"]);
  });

  it("returns an empty scope when there is nothing to learn from", () => {
    expect(deriveScope([])).toEqual({ paths: [], domains: [], secrets: [] });
  });
});

describe("Codify path helpers", () => {
  it("maps a written file to the directory that must be writable", () => {
    expect(containingDirectory("out/RELEASE.md")).toBe("out");
    expect(containingDirectory("./out/a/b.md")).toBe("out/a");
    expect(containingDirectory("README.md")).toBe(".");
    expect(containingDirectory("../escape.md")).toBeNull();
    expect(containingDirectory("node_modules/pkg/index.js")).toBeNull();
  });

  /**
   * The workplace case: five people, five of their own files.
   *
   * Nobody in an office summarises the *same* spreadsheet. Each person brings
   * their own, so no single filename appears in a majority of the runs — and a
   * frequency floor applied to filenames would clear nothing and derive a
   * contract with no readable path at all, which is the failure mode §11 of the
   * design doc names.
   *
   * It survives because the floor is applied to the containing *directory*, not
   * the file. Divergent filenames inside one directory collapse to that
   * directory before anything is counted.
   */
  it("derives a shared directory when every person brought their own file", () => {
    const people = ["alice", "bob", "carla", "dev", "erin"];
    const scope = deriveScope(
      people.map((person, index) =>
        observation({
          runId: "run-" + index,
          // One file each, and no two the same.
          pathsRead: ["finance/" + person + "-q1.csv"],
          pathsWritten: ["out/" + person + "-summary.md"],
        }),
      ),
    );

    expect(scope.paths).toContainEqual({ path: "out", mode: "rw" });
    expect(scope.paths).toContainEqual({ path: "finance", mode: "ro" });
    // And never the individual files, which would be a scope nobody else can use.
    expect(scope.paths.every((entry) => !entry.path.includes(".csv"))).toBe(true);
  });

  it("derives nothing readable when the same task ran in different directories", () => {
    // The other half of the same property, and the reason an upload path that
    // let people choose a destination would make derivation worse: divergent
    // *directories* do not collapse, so none of them clears the floor.
    const scope = deriveScope([
      observation({ runId: "r1", pathsRead: ["finance/q1.csv"] }),
      observation({ runId: "r2", pathsRead: ["data/q1.csv"] }),
      observation({ runId: "r3", pathsRead: ["uploads/alice/q1.csv"] }),
      observation({ runId: "r4", pathsRead: ["reports/q1.csv"] }),
      observation({ runId: "r5", pathsRead: ["inbox/q1.csv"] }),
    ]);

    // Fails in the safe direction: the task breaks visibly and an operator
    // widens it through the escalation path, rather than quietly over-granting.
    expect(scope.paths).toEqual([]);
  });

  it("collapses descendants into their ancestor", () => {
    expect(collapsePaths(["out", "out/notes", "repo"])).toEqual(["out", "repo"]);
    expect(collapsePaths(["out", "."])).toEqual(["."]);
  });
});

describe("Codify scope monotonicity", () => {
  const derived: CapabilityScope = {
    paths: [
      { path: "out", mode: "rw" },
      { path: "repo", mode: "ro" },
    ],
    domains: ["github.com"],
    secrets: ["GITHUB_TOKEN"],
  };

  it("allows a reviewer to narrow", () => {
    expect(checkNarrowing(derived, { paths: [], domains: [], secrets: [] }).ok).toBe(true);
    expect(
      checkNarrowing(derived, { ...derived, domains: [] }).ok,
    ).toBe(true);
    // Downgrading a writable path to read-only is a narrowing.
    expect(
      checkNarrowing(derived, {
        ...derived,
        paths: [{ path: "out", mode: "ro" }],
      }).ok,
    ).toBe(true);
  });

  it("rejects every kind of widening", () => {
    const domain = checkNarrowing(derived, {
      ...derived,
      domains: ["github.com", "collector.evil.example"],
    });
    expect(domain.ok).toBe(false);
    expect(domain.widenedDomains).toEqual(["collector.evil.example"]);

    const path = checkNarrowing(derived, {
      ...derived,
      paths: [...derived.paths, { path: "secrets", mode: "rw" }],
    });
    expect(path.ok).toBe(false);
    expect(path.widenedPaths).toEqual(["secrets"]);

    // ro -> rw on an existing path is an escalation, not an edit.
    const upgrade = checkNarrowing(derived, {
      ...derived,
      paths: [
        { path: "out", mode: "rw" },
        { path: "repo", mode: "rw" },
      ],
    });
    expect(upgrade.ok).toBe(false);
    expect(upgrade.widenedPaths).toEqual(["repo"]);

    const secret = checkNarrowing(derived, {
      ...derived,
      secrets: ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"],
    });
    expect(secret.ok).toBe(false);
    expect(secret.widenedSecrets).toEqual(["AWS_SECRET_ACCESS_KEY"]);
  });

  it("strips deny-listed domains during normalisation", () => {
    const normalised = normalizeScope({
      paths: [{ path: "out", mode: "rw" }],
      domains: ["GitHub.com", "169.254.169.254", "github.com"],
      secrets: [" GITHUB_TOKEN ", ""],
    });
    expect(normalised.domains).toEqual(["github.com"]);
    expect(normalised.secrets).toEqual(["GITHUB_TOKEN"]);
    expect(normalised.paths).toEqual([{ path: "out", mode: "rw" }]);
  });
});
