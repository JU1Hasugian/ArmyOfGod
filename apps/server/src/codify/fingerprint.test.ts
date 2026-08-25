import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_THRESHOLD,
  bestScore,
  canonicalize,
  cluster,
  fingerprint,
  similarity,
} from "./fingerprint.js";

const RELEASE_NOTES = [
  "Generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/RELEASE.md",
  "generate release notes from the commits in ./repo since v2.1.0, write them to ./out/NOTES.md",
  "Please generate release notes from the commits in ./repo since v1.9.2 and write them to ./out/CHANGELOG.md",
  "Generate the release notes from commits in ./repo since v3.0.0 and write them into ./out/RELEASE.md",
  "Generate release notes from the commits in ./repo since v0.9.0 and write them to ./out/rel.md",
];

const DISTINCT_TASKS = [
  "Summarise the incident timeline in ./incidents into a postmortem in ./out/post.md",
  "Run the test suite in ./repo and report which tests failed",
  "Delete every file in ./repo and reinstall the dependencies",
];

describe("Codify canonicalisation", () => {
  it("collapses incidental differences between phrasings of one task", () => {
    const forms = RELEASE_NOTES.map(canonicalize);
    expect(forms[0]).toBe(forms[1]);
    expect(forms[0]).toBe(forms[2]);
    // Versions, paths and counts become placeholders rather than literals.
    expect(forms[0]).toContain("{PATH}");
    expect(forms[0]).toContain("{NUM}");
    expect(forms[0]).not.toContain("v1.4.0");
  });

  it("keeps placeholders intact through the punctuation pass", () => {
    expect(canonicalize("write to ./out/x.md")).not.toContain("{}");
  });

  it("does not collapse genuinely different tasks", () => {
    const release = canonicalize(RELEASE_NOTES[0] as string);
    for (const other of DISTINCT_TASKS) {
      expect(canonicalize(other)).not.toBe(release);
    }
  });
});

describe("Codify fingerprint matching", () => {
  it("scores rephrasings above, and unrelated tasks far below, the threshold", () => {
    const signatures = RELEASE_NOTES.map((text) => fingerprint(canonicalize(text)));
    const reference = signatures[0] as string;

    for (const signature of signatures) {
      expect(similarity(reference, signature)).toBeGreaterThanOrEqual(
        DEFAULT_MATCH_THRESHOLD,
      );
    }
    for (const other of DISTINCT_TASKS) {
      const score = similarity(reference, fingerprint(canonicalize(other)));
      expect(score).toBeLessThan(0.2);
    }
  });

  it("takes the best score across every fingerprint a contract carries", () => {
    const carried = RELEASE_NOTES.slice(0, 2).map((text) => fingerprint(canonicalize(text)));
    const inbound = fingerprint(canonicalize(RELEASE_NOTES[3] as string));
    expect(bestScore(inbound, carried)).toBeGreaterThanOrEqual(DEFAULT_MATCH_THRESHOLD);
    expect(bestScore(inbound, [])).toBe(0);
  });

  it("groups one task together and leaves unrelated tasks in their own clusters", () => {
    const items = [...RELEASE_NOTES, ...DISTINCT_TASKS].map((text) => ({
      text,
      fingerprint: fingerprint(canonicalize(text)),
    }));
    const clusters = cluster(items);
    const biggest = clusters.sort((left, right) => right.length - left.length)[0];
    expect(biggest).toHaveLength(RELEASE_NOTES.length);
    expect(clusters).toHaveLength(1 + DISTINCT_TASKS.length);
  });

  it("returns an empty signature for empty input rather than throwing", () => {
    expect(fingerprint(canonicalize(""))).toBe("");
    expect(similarity("", "")).toBe(0);
  });
});
