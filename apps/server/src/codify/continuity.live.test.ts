/**
 * The follow-up test against a real Ark embedding endpoint.
 *
 * Skipped unless `ARK_API_KEY` and `ARK_EMBED_MODEL` are both present, in the
 * same spirit as `semantic.live.test.ts`: `npm run check` stays green without
 * credentials, and a reviewer who supplies them gets the claim verified rather
 * than asserted.
 *
 * The claim is specifically about paraphrase. The deterministic layer scores
 * 24/39 on `continuity.corpus.ts`: a wordlist cannot see that "trim",
 * "tighten" and "waffly" mean what "shorter" means, and under the word gate it
 * cannot see a short new request at all. That is what an embedding is for, and
 * it cannot be shown with a fixture vector.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { CORPUS } from "./continuity.corpus.js";
import { classifyFollowUp, clearAnchorCache, looksLikeFollowUp } from "./continuity.js";
import { clearEmbeddingCache } from "./semantic.js";

const LIVE = Boolean(process.env.ARK_API_KEY && process.env.ARK_EMBED_MODEL);

/** The floor the lexical layer already clears, measured on this corpus. */
const DETERMINISTIC_BASELINE = 24;

function liveConfig() {
  return loadConfig({
    NODE_ENV: "development",
    ARK_API_KEY: process.env.ARK_API_KEY,
    ARK_MODEL: process.env.ARK_MODEL ?? "ep-unused",
    ARK_EMBED_MODEL: process.env.ARK_EMBED_MODEL,
    ...(process.env.ARK_BASE_URL ? { ARK_BASE_URL: process.env.ARK_BASE_URL } : {}),
    CODIFY_SEMANTIC: "true",
    CODIFY_LLM_DRAFTING: "false",
    RUNTIME_PROVIDER: "local-process",
  });
}

describe.skipIf(!LIVE)("the follow-up test against a live Ark endpoint", () => {
  it("reads paraphrases the wordlist cannot", { timeout: 120_000 }, async () => {
    clearEmbeddingCache();
    clearAnchorCache();
    const config = liveConfig();

    const results = await Promise.all(
      CORPUS.map(async (sample) => ({
        sample,
        lexical: looksLikeFollowUp(sample.text).followUp === sample.followUp,
        verdict: await classifyFollowUp(config, sample.text),
      })),
    );

    const missed = results.filter((entry) => entry.verdict.followUp !== entry.sample.followUp);
    // Printed rather than only asserted: a miss should name its own family, so
    // a failure says which kind of phrasing is unhandled and not just a count.
    for (const entry of missed) {
      console.log(
        `  missed [${entry.sample.family}] via ${entry.verdict.channel}: "${entry.sample.text}"`,
      );
    }

    const score = CORPUS.length - missed.length;
    // The semantic layer has to earn its place: it may not be worse than the
    // layer it sits in front of, which needs no network at all.
    expect(score).toBeGreaterThan(DETERMINISTIC_BASELINE);

    // And the gains must come from the phrasings the wordlist provably cannot
    // see, rather than from the easy cases it already had.
    const rescued = results.filter(
      (entry) => !entry.lexical && entry.verdict.followUp === entry.sample.followUp,
    );
    expect(rescued.length).toBeGreaterThan(0);
  });

});
