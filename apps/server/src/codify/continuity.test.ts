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

  it("does not treat a long unrelated request as a correction", () => {
    const verdict = looksLikeFollowUp(
      "Write a detailed proposal for the new onboarding process covering the first " +
        "week, the buddy system, and how we measure whether any of it worked",
    );
    expect(verdict.followUp).toBe(false);
  });
});
