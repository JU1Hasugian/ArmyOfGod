import { describe, expect, it } from "vitest";
import { parsePlan, readySteps, waves } from "./planner.js";

const PROMPT =
  "Pull last month's signups into ./out/signups.md and email it to the board";

const TWO_STEPS = [
  "STEP 1 AFTER NONE: Pull last month's signups into ./out/signups.md",
  "STEP 2 AFTER 1: Email the signups report at ./out/signups.md to the board",
].join("\n");

describe("parsePlan", () => {
  it("splits a compound request and keeps the dependency", () => {
    const steps = parsePlan(TWO_STEPS, PROMPT);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.text).toContain("./out/signups.md");
    expect(steps[0]?.dependsOn).toEqual([]);
    // Indices are zero-based internally; the wire format is one-based.
    expect(steps[1]?.dependsOn).toEqual([0]);
  });

  it("marks independent steps as independent", () => {
    const raw = [
      "STEP 1 AFTER NONE: Audit the dependency tree for advisories",
      "STEP 2 AFTER NONE: Write the weekly status update from ./notes",
    ].join("\n");
    const steps = parsePlan(raw, "audit deps and write the weekly status update from ./notes");
    expect(steps.map((step) => step.dependsOn)).toEqual([[], []]);
    expect(waves(steps)).toEqual([[0, 1]]);
  });

  it("returns the prompt unchanged when the model is unavailable", () => {
    expect(parsePlan(null, PROMPT)).toEqual([{ text: PROMPT, dependsOn: [] }]);
  });

  it("returns the prompt unchanged when the reply is unparseable", () => {
    expect(parsePlan("Sure! Here is how I would break that up:", PROMPT)).toEqual([
      { text: PROMPT, dependsOn: [] },
    ]);
  });

  it("treats a single step as no split at all", () => {
    // The caller must take the ordinary path, not a one-fragment coordination
    // session, when the request was only ever one job.
    const steps = parsePlan("STEP 1 AFTER NONE: Rewritten by the model", PROMPT);
    expect(steps).toEqual([{ text: PROMPT, dependsOn: [] }]);
  });

  it("rejects a plan that dropped most of the request", () => {
    const raw = ["STEP 1 AFTER NONE: signups", "STEP 2 AFTER 1: email"].join("\n");
    expect(parsePlan(raw, PROMPT)).toEqual([{ text: PROMPT, dependsOn: [] }]);
  });

  it("rejects gapped or misnumbered steps", () => {
    // If the numbering is not 1..n, "AFTER 2" does not mean what it appears to.
    const raw = [
      "STEP 1 AFTER NONE: Pull last month's signups into ./out/signups.md",
      "STEP 3 AFTER 1: Email the signups report at ./out/signups.md to the board",
    ].join("\n");
    expect(parsePlan(raw, PROMPT)).toEqual([{ text: PROMPT, dependsOn: [] }]);
  });

  it("rejects a plan with more fragments than the cap", () => {
    const raw = Array.from(
      { length: 6 },
      (_, index) => "STEP " + (index + 1) + " AFTER NONE: fragment number " + (index + 1),
    ).join("\n");
    expect(parsePlan(raw, "x".repeat(20))).toHaveLength(1);
  });

  it("drops forward and self dependencies rather than trusting them", () => {
    // A dependency may only point backwards, which is what makes cycles
    // impossible by construction.
    const raw = [
      "STEP 1 AFTER 2: Pull last month's signups into ./out/signups.md",
      "STEP 2 AFTER 2, 1: Email the signups report at ./out/signups.md to the board",
    ].join("\n");
    const steps = parsePlan(raw, PROMPT);
    expect(steps[0]?.dependsOn).toEqual([]);
    expect(steps[1]?.dependsOn).toEqual([0]);
  });

  it("ignores prose the model wrapped around the plan", () => {
    const raw = ["Happy to help.", TWO_STEPS, "Let me know if that works."].join("\n");
    expect(parsePlan(raw, PROMPT)).toHaveLength(2);
  });
});

describe("readySteps and waves", () => {
  it("releases a dependent step only once its dependency is done", () => {
    const steps = parsePlan(TWO_STEPS, PROMPT);
    expect(readySteps(steps, new Set())).toEqual([0]);
    expect(readySteps(steps, new Set([0]))).toEqual([1]);
    expect(readySteps(steps, new Set([0, 1]))).toEqual([]);
  });

  it("groups a diamond into three waves", () => {
    const raw = [
      "STEP 1 AFTER NONE: pull the raw signup numbers from the warehouse",
      "STEP 2 AFTER 1: chart the signup numbers by channel",
      "STEP 3 AFTER 1: chart the signup numbers by region",
      "STEP 4 AFTER 2, 3: assemble both signup charts into the board deck",
    ].join("\n");
    const steps = parsePlan(raw, "x".repeat(40));
    // The two charts have no reason to wait for each other.
    expect(waves(steps)).toEqual([[0], [1, 2], [3]]);
  });

  it("runs a fully independent plan in one wave", () => {
    const raw = [
      "STEP 1 AFTER NONE: audit the dependency tree for advisories",
      "STEP 2 AFTER NONE: write the weekly status update from ./notes",
      "STEP 3 AFTER NONE: reconcile the invoice ledger for last month",
    ].join("\n");
    const steps = parsePlan(raw, "x".repeat(60));
    expect(waves(steps)).toEqual([[0, 1, 2]]);
  });
});
