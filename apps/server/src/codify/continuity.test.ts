import { describe, expect, it } from "vitest";
import { looksLikeFollowUp } from "./continuity.js";

describe("telling a follow-up from a new request", () => {
  it("reads corrections as follow-ups", () => {
    for (const text of [
      "break it up with headings please",
      "use more colour in the headings",
      "make it shorter",
      "add a summary at the top",
      "do that again but sorted by department",
      "same thing, fewer bullets",
    ]) {
      expect(looksLikeFollowUp(text).followUp, text).toBe(true);
    }
  });

  it("reads self-contained requests as new work", () => {
    for (const text of [
      "Summarise the 2026 finances in ./finance into ./out/finance-summary.md",
      "Audit the dependencies in ./repo and write findings to ./reports/audit.md",
      "Generate release notes from the commits in ./repo since v2.7.0",
      "Draft a birthday message for a colleague in accounting and send it round the team",
    ]) {
      expect(looksLikeFollowUp(text).followUp, text).toBe(false);
    }
  });

  it("treats naming a target as standing alone, however short", () => {
    // "more" would otherwise read as an adjustment.
    const verdict = looksLikeFollowUp("more detail in ./out/report.md");
    expect(verdict.followUp).toBe(false);
    expect(verdict.reason).toContain("target");
  });

  it("reads a hedged correction as a follow-up however long it runs", () => {
    // The politeness is what makes these long, so length cannot be the test:
    // every one of these is the same instruction as "bigger, bolder heading".
    for (const text of [
      "i think the heading needs to be more bigger and bolder for the release note",
      "the release note heading should be bigger and bolder than it is now",
      "could you possibly make that heading a fair bit larger and put it in bold",
    ]) {
      expect(looksLikeFollowUp(text).followUp, text).toBe(true);
    }
  });

  it("reads a creation verb as new work even when it carries a pronoun", () => {
    const verdict = looksLikeFollowUp(
      "Draft a birthday message for a colleague in accounting and send it round the team",
    );
    expect(verdict.followUp).toBe(false);
    expect(verdict.reason).toContain("does not exist yet");
  });

  it("keeps a creation verb a correction when it asks for an adjustment", () => {
    // Remaking an artefact differently is not asking for a new one.
    for (const text of [
      "write it shorter than that but keep the second paragraph exactly as it is",
      "rewrite the opening section so it reads a little less formally than before",
    ]) {
      expect(looksLikeFollowUp(text).followUp, text).toBe(true);
    }
  });

  it("does not treat a long unrelated request as a correction", () => {
    const verdict = looksLikeFollowUp(
      "Write a detailed proposal for the new onboarding process covering the first " +
        "week, the buddy system, and how we measure whether any of it worked",
    );
    expect(verdict.followUp).toBe(false);
  });
});
