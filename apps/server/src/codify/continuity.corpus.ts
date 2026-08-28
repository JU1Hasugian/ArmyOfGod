/**
 * A paraphrase corpus for the follow-up test.
 *
 * The heuristic is a wordlist, and a wordlist fails on the one axis a live
 * audience varies most: how a person happens to phrase the same instruction.
 * "shorter" is in the list because someone thought of it; "trim" was not,
 * because they did not. So the corpus is written the way a judge types —
 * the same intent at every length and register, from a two-word grunt to a
 * paragraph of apology — and both classes are stocked with the markers of the
 * other, because that is where a lexical test breaks.
 *
 * Shared by the offline test, which measures the deterministic layer, and the
 * live one, which measures the semantic layer against a real endpoint.
 */

export interface Sample {
  /** What a person typed. */
  text: string;
  /** True when it corrects whatever the last turn produced. */
  followUp: boolean;
  /** Why it is here — printed on failure so a miss names its own family. */
  family: string;
}

/** Corrections. Every one of these means "make the summary shorter". */
export const CORRECTIONS: Sample[] = [
  { text: "shorter", followUp: true, family: "one word" },
  { text: "shorter pls", followUp: true, family: "abbreviated" },
  { text: "too long", followUp: true, family: "states the fault, not the fix" },
  { text: "cut it down", followUp: true, family: "synonym: cut" },
  { text: "trim it a bit", followUp: true, family: "synonym: trim" },
  { text: "tighten that up", followUp: true, family: "synonym: tighten" },
  { text: "can you condense it", followUp: true, family: "synonym: condense" },
  { text: "bit waffly", followUp: true, family: "critique, no verb at all" },
  { text: "half the length would be better", followUp: true, family: "quantified" },
  { text: "could you trim the summary down a fair bit for the release note",
    followUp: true, family: "synonym + names the artefact, no path" },
  { text: "honestly the summary feels quite long, could you tighten the whole thing up",
    followUp: true, family: "hedged synonym over the word gate" },
  { text: "i think it probably needs to be quite a lot shorter than this",
    followUp: true, family: "hedged, referential" },
  { text: "would you mind awfully making that a good deal more concise for me",
    followUp: true, family: "very polite, synonym: concise" },
  { text: "sorry to be a pain but this is running way longer than i was expecting",
    followUp: true, family: "apologetic, no imperative anywhere" },
  { text: "yeah that's not going to fit on one slide, needs to lose about half",
    followUp: true, family: "states a constraint, implies the edit" },
  { text: "i appreciate the detail but our exec team genuinely will not read past the first paragraph so it has to come down a lot",
    followUp: true, family: "long justification, buried instruction" },
  { text: "is there any chance we could get this down to something a person might actually finish reading",
    followUp: true, family: "rhetorical question" },
  { text: "great start, only note is the length",
    followUp: true, family: "praise then correction" },
  { text: "when i said brief i really did mean brief",
    followUp: true, family: "refers to an earlier instruction" },
  { text: "the second and third paragraphs are basically saying the same thing so lose one",
    followUp: true, family: "specific structural edit" },
  { text: "it's fine but nobody has time for six paragraphs, needs to be way punchier",
    followUp: true, family: "synonym: punchier, past the word gate" },
  { text: "i asked for a summary and you gave me an essay",
    followUp: true, family: "names the fault by comparison, no verb" },
];

/** New requests. Several deliberately carry correction markers. */
export const NEW_REQUESTS: Sample[] = [
  { text: "Draft a birthday message for a colleague in accounting and send it round the team",
    followUp: false, family: "creation verb carrying a pronoun" },
  { text: "Write a detailed proposal for the new onboarding process covering the first week, the buddy system, and how we measure whether any of it worked",
    followUp: false, family: "long creation request with a pronoun" },
  { text: "Summarise the 2026 finances in ./finance into ./out/finance-summary.md",
    followUp: false, family: "names a path" },
  { text: "Generate release notes from the commits in ./repo since v2.7.0",
    followUp: false, family: "names a path" },
  { text: "put together a short summary of the incident for the status page",
    followUp: false, family: "new artefact described as short" },
  { text: "i need a one pager on the migration, keep it tight",
    followUp: false, family: "new artefact plus an adjustment word" },
  { text: "can you pull together something smaller scale than the last report, just the headlines for the board",
    followUp: false, family: "new artefact defined by contrast with the old one" },
  { text: "audit the dependency tree and tell me which ones have not been updated in over a year",
    followUp: false, family: "creation verb, no markers" },
  { text: "write up the postmortem for yesterday's outage",
    followUp: false, family: "creation verb, short" },
  { text: "what were the headline numbers for Q3 again",
    followUp: false, family: "question containing a referential word" },
  // Short new requests. The lexical layer cannot reach these at all: under the
  // word gate a targetless message is a correction on length alone, and every
  // one of these is under it. They are the reason the gate is not the whole
  // test, and the clearest thing the semantic channel has to earn.
  { text: "postmortem for the outage pls",
    followUp: false, family: "short: bare noun request" },
  { text: "need a short blurb for the careers page",
    followUp: false, family: "short: new artefact described as short" },
  { text: "who owns the billing service these days",
    followUp: false, family: "short: question, no artefact at all" },
  { text: "can you make me a smaller version of the logo",
    followUp: false, family: "short: new artefact, adjustment wording" },
  { text: "i want a punchy one-liner for the launch tweet",
    followUp: false, family: "short: new artefact, correction vocabulary" },
  { text: "run the numbers again for FY26 and tell me the delta",
    followUp: false, family: "carries \"again\" and is still new work" },
  { text: "list every dependency we added this quarter and flag the ones nobody uses",
    followUp: false, family: "carries \"add\" and \"one\" and is still new work" },
];

export const CORPUS: Sample[] = [...CORRECTIONS, ...NEW_REQUESTS];
