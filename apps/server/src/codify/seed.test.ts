import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { seedObservations } from "./seed.js";
import { CodifyService } from "./service.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function seeded() {
  const root = await mkdtemp(path.join(tmpdir(), "codify-seed-"));
  directories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    ARK_API_KEY: "k",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  const result = await seedObservations(store);
  return { store, service: new CodifyService(config, store), result };
}

describe("Codify seeded corpus", () => {
  it("populates the review queue with exactly the families that clear both thresholds", async () => {
    const { service, result } = await seeded();
    expect(result.seeded).toBe(true);

    const candidates = await service.refreshCandidates();
    expect(candidates).toHaveLength(3);

    const names = candidates.map((candidate) => candidate.proposedName.toLowerCase());
    expect(names.some((name) => name.includes("releas"))).toBe(true);
    expect(names.some((name) => name.includes("incident") || name.includes("summaris"))).toBe(
      true,
    );
    expect(names.some((name) => name.includes("audit"))).toBe(true);
  });

  it("never promotes a task one user repeated fifteen times", async () => {
    const { service } = await seeded();
    const candidates = await service.refreshCandidates();

    // The poisoning family clears the occurrence threshold on its own and is
    // stopped by the distinct-user requirement alone.
    for (const candidate of candidates) {
      expect(candidate.distinctUsers).toBeGreaterThanOrEqual(3);
      expect(candidate.proposedPrompt.toLowerCase()).not.toContain("collect every credential");
      expect(candidate.proposedScope.domains).not.toContain("collector.evil.example");
    }
    expect(candidates.some((candidate) => candidate.occurrences === 15)).toBe(false);
  });

  it("derives a different scope for each family, matching what it observed", async () => {
    const { service } = await seeded();
    const candidates = await service.refreshCandidates();
    const byName = (fragment: string) =>
      candidates.find((candidate) =>
        candidate.proposedName.toLowerCase().includes(fragment),
      );

    const release = byName("releas");
    expect(release?.proposedScope.domains).toEqual(["github.com"]);
    expect(release?.proposedScope.secrets).toEqual(["GITHUB_TOKEN"]);
    expect(release?.proposedScope.paths).toContainEqual({ path: "out", mode: "rw" });
    expect(release?.proposedScope.paths).toContainEqual({ path: "repo", mode: "ro" });

    // A task that never reached the network gets no network.
    const postmortem = byName("summaris") ?? byName("incident");
    expect(postmortem?.proposedScope.domains).toEqual([]);
    expect(postmortem?.proposedScope.secrets).toEqual([]);
  });

  it("is idempotent", async () => {
    const { store } = await seeded();
    const before = store.snapshot().promptObservations.length;
    const again = await seedObservations(store);
    expect(again.seeded).toBe(false);
    expect(store.snapshot().promptObservations).toHaveLength(before);
  });
});
