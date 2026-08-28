/**
 * What the follow-up test does with no endpoint at all.
 *
 * The semantic channel is exercised in `continuity.live.test.ts`, which needs
 * credentials. This file covers the case that has to hold regardless: Ark
 * disabled, exhausted, or unreachable, which is the state a demo is in when an
 * endpoint runs out mid-session.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { CORPUS } from "./continuity.corpus.js";
import { classifyFollowUp, clearAnchorCache, looksLikeFollowUp } from "./continuity.js";
import { clearEmbeddingCache } from "./semantic.js";

function offlineConfig() {
  return loadConfig({
    NODE_ENV: "development",
    ARK_API_KEY: "",
    ARK_MODEL: "ep-unused",
    CODIFY_SEMANTIC: "false",
    RUNTIME_PROVIDER: "local-process",
  });
}

describe("the follow-up test with no endpoint", () => {
  it("answers from the wordlist and says so", async () => {
    clearEmbeddingCache();
    clearAnchorCache();
    const config = offlineConfig();
    for (const sample of CORPUS) {
      const verdict = await classifyFollowUp(config, sample.text);
      expect(verdict.channel, sample.text).toBe("lexical");
      expect(verdict.followUp, sample.text).toBe(looksLikeFollowUp(sample.text).followUp);
    }
  });

  it("records what the wordlist alone is worth on the paraphrase corpus", () => {
    const correct = CORPUS.filter(
      (sample) => looksLikeFollowUp(sample.text).followUp === sample.followUp,
    );
    // Pinned rather than aspirational. This is the number the semantic layer
    // has to beat in the live test, and the number a pulled endpoint falls
    // back to. It moves only when the wordlists or the corpus change, and
    // either is a deliberate act worth failing a build over.
    expect(correct.length).toBe(24);
    expect(CORPUS.length).toBe(39);
  });

  it("still reads the short unambiguous corrections a demo actually gets", () => {
    // Whatever happens to the endpoint, these must route to the specialist.
    for (const text of ["shorter", "shorter pls", "too long", "cut it down", "trim it a bit"]) {
      expect(looksLikeFollowUp(text).followUp, text).toBe(true);
    }
  });
});
