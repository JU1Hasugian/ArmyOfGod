/**
 * Which Agent a follow-up belongs to.
 *
 * The platform routes work to specialists, and it used to move the person there
 * with it: the view switched mid-conversation, their history fragmented across
 * cards, and a correction typed in the wrong place was silently dropped. The
 * conversation now stays where it was typed, which leaves one question this
 * module answers — when a turn matches no contract, is it a *new* request, or a
 * follow-up to whatever the last specialist just produced?
 *
 * Getting this wrong is not symmetrical:
 *
 * - Treating a new request as a follow-up runs it on the wrong specialist. It
 *   is contained — that specialist's scope is narrow and `principal_bound`
 *   applies — but the wrong expert answers.
 * - Treating a follow-up as a new request runs it ad hoc on the general Agent,
 *   *unrestricted*, and the correction never reaches the contract it was about.
 *
 * The second is worse on both counts, so the test leans towards continuity.
 *
 * Two layers answer it. `looksLikeFollowUp` is lexical, deterministic and makes
 * no network call; `classifyFollowUp` puts an embedding in front of it, because
 * a wordlist breaks on paraphrase and paraphrase is what a live audience varies
 * most. The embedding is not a new cost on this path - every prompt is already
 * embedded by `recordPromptObservation`, and the cache is keyed by exact text -
 * and it never becomes load-bearing: a disabled endpoint, an exhausted one, or
 * two anchor sets too close to call all fall through to the lexical layer.
 *
 * No completion call belongs here. Those are 30s-timeout calls behind a human
 * gate, and this is the live request path.
 */
import type { AppConfig } from "../config.js";
import { embedPrompt, packedCosine } from "./semantic.js";

/** Words that only make sense against something already on the table. */
const REFERENTIAL = [
  "it", "its", "this", "that", "these", "those", "them", "they", "one",
  "again", "instead", "also", "too", "still", "same",
];

/** Adjustments to an existing artefact rather than a request for a new one. */
const ADJUSTMENT = [
  "more", "less", "fewer", "shorter", "longer", "bigger", "smaller", "brighter",
  "darker", "add", "remove", "drop", "keep", "change", "fix", "redo", "rewrite",
  "reword", "expand", "shorten", "simplify", "clarify", "split", "merge",
  "reorder", "sort", "rename", "tweak", "adjust", "prefer", "rather",
];

/** Verbs that ask for an artefact which does not exist yet. */
const CREATION = [
  "draft", "write", "generate", "create", "compose", "produce", "compile",
  "summarise", "summarize", "audit",
];

/** A self-contained request usually names where it operates. */
const TARGET = /(^|\s)(\.\/|\/|~\/)[\w.\-/]+|https?:\/\/|\b\w+\.(md|csv|json|ts|tsx|js|py|txt|ya?ml|toml|html)\b/i;

export interface FollowUpVerdict {
  followUp: boolean;
  reason: string;
  /** Which layer answered. Surfaced in the trace, and asserted in tests. */
  channel?: "lexical" | "semantic";
}

/**
 * Does this read as a continuation of the previous turn?
 *
 * Consulted before `route()`, so the verdict picks the Agent the contract match
 * then runs against. Contracts are matched globally rather than per Agent, so a
 * recognised task is still a new instance of that task whatever this returns —
 * what the verdict decides is which specialist executes it, not whether it is
 * governed.
 */
export function looksLikeFollowUp(text: string): FollowUpVerdict {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { followUp: false, reason: "empty" };

  // Naming a file or a URL is how a self-contained request states its subject.
  // A correction does not need to: the subject is what just happened.
  if (TARGET.test(trimmed)) {
    return { followUp: false, reason: "names its own target, so it stands alone" };
  }

  const words = trimmed.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);

  const has = (list: string[]) => words.some((word) => list.includes(word));

  // Asking for something that does not exist yet is a new request at any
  // length. "write up the postmortem" is five words and is not a correction to
  // anything, so this has to come before the word gate, not after it - brevity
  // is a property of how someone types, not of what they are asking for.
  //
  // Unless an adjustment word is there too: "write it shorter" names a creation
  // verb and is still a correction. Remaking an artefact differently is not
  // asking for a new one, and that guard is what makes the ordering safe.
  if (has(CREATION) && !has(ADJUSTMENT)) {
    return { followUp: false, reason: "asks for an artefact that does not exist yet" };
  }

  // Otherwise a short, targetless imperative is a correction far more often
  // than a new task: "use more colour", "break it up with headings".
  if (words.length <= SHORT_ENOUGH) {
    return { followUp: true, reason: "short and names no new subject" };
  }

  // Past that, length stops being evidence. A hedged correction is *longer*
  // than a blunt one - "i think the heading needs to be bigger for the release
  // note" is the same instruction as "bigger heading" with the politeness left
  // in - so cutting off at a word count reads manners as self-containment.

  if (has(REFERENTIAL)) {
    return { followUp: true, reason: "refers to something already produced" };
  }
  if (has(ADJUSTMENT)) {
    return { followUp: true, reason: "asks for an adjustment rather than a new artefact" };
  }
  return { followUp: false, reason: "reads as a self-contained request" };
}

/** Below this, a targetless message is a correction on length alone. */
const SHORT_ENOUGH = 8;

// ------------------------------------------------------- the semantic channel

/**
 * The wordlists above fail on the axis a live audience varies most: how a
 * person happens to phrase the same instruction. "shorter" is listed and
 * "trim" is not, for no better reason than which occurred to the author, so
 * *"could you trim the summary down a fair bit"* falls out of the test while
 * *"make it shorter"* sails through. Widening the list moves the edge; it does
 * not remove it, because the next person says "less waffly".
 *
 * An embedding does not have that failure mode - "trim", "tighten", "condense"
 * and "waffly" sit near "shorter" without anyone having listed them. And it
 * costs no extra call: `recordPromptObservation` already embeds every prompt on
 * this path, and `embedPrompt` is cached by exact text, so asking here and
 * recording there is one request rather than two.
 *
 * Anchors rather than a comparison against the previous turn. A correction is
 * *semantically distant* from the thing it corrects - "make it shorter" shares
 * no topic with a release note - so similarity to the last answer measures
 * subject matter, and is near zero exactly when the turn is most obviously a
 * follow-up. What separates the classes is the shape of the ask, which is what
 * these two sets exemplify.
 */
export const CORRECTION_ANCHORS = [
  "make it shorter",
  "too long, cut it down",
  "trim that a bit please",
  "use more colour in the headings",
  "break it up with headings",
  "the tone is too formal, soften it",
  "that heading needs to be bigger and bolder",
  "sorry, when I said brief I meant brief",
  "great start, my only note is the length",
  "this is running longer than I expected",
  "drop the last section entirely",
  "same thing but sorted by department",
  "can you do that again with fewer bullets",
  "it does not read the way I wanted",
];

export const NEW_REQUEST_ANCHORS = [
  "draft a birthday message for a colleague",
  "write up the postmortem for yesterday's outage",
  "generate release notes from the commits since the last tag",
  "audit the dependencies and report what is out of date",
  "summarise the 2026 finances into a one page brief",
  "put together a short summary of the incident for the status page",
  "I need a one pager on the migration",
  "prepare the quarterly board update",
  "what were the headline numbers for Q3",
  "pull the headcount figures for the finance team",
  "compile a list of every customer affected",
  "research how our competitors price this",
];

/**
 * How far apart the two sides must land before the embedding is allowed to
 * decide. Inside this margin the classes are not separated and the vote is
 * noise, so the deterministic layer answers instead - the same posture as every
 * other model call in Codify, which informs a decision and is never the only
 * thing standing between a prompt and a verdict.
 */
export const DECISIVE_MARGIN = 0.03;

/**
 * The same question, with the semantic channel consulted first.
 *
 * Fails soft in every direction: semantic disabled, no embedding endpoint, a
 * timed-out or exhausted Ark, an anchor set that did not embed, or two sides
 * too close to call all land on `looksLikeFollowUp`. A demo with the endpoint
 * pulled routes exactly as it does today.
 */
export async function classifyFollowUp(
  config: AppConfig,
  text: string,
): Promise<FollowUpVerdict> {
  const lexical = looksLikeFollowUp(text);

  // Naming a path settles it without spending a call: a self-contained request
  // states its own subject, and no phrasing of a correction does that.
  if (lexical.reason.startsWith("names its own target")) {
    return { ...lexical, channel: "lexical" };
  }

  const embedding = await embedPrompt(config, text);
  if (!embedding) return { ...lexical, channel: "lexical" };

  const anchors = await embedAnchors(config);
  if (!anchors) return { ...lexical, channel: "lexical" };

  const nearest = (set: string[]) =>
    set.reduce((best, packed) => Math.max(best, packedCosine(packed, embedding)), 0);
  const correction = nearest(anchors.corrections);
  const request = nearest(anchors.requests);

  if (Math.abs(correction - request) < DECISIVE_MARGIN) {
    return { ...lexical, channel: "lexical" };
  }
  return correction > request
    ? { followUp: true, reason: "reads like a correction to what was just produced", channel: "semantic" }
    : { followUp: false, reason: "reads like a request for something new", channel: "semantic" };
}

/** Packed anchor embeddings, resolved once per process. */
let anchorCache: Promise<{ corrections: string[]; requests: string[] } | null> | null = null;

/**
 * Embedded once and held for the life of the process. Single-flighted, so a
 * burst of first turns issues one set of calls rather than one set each, and
 * discarded on failure so a temporary outage does not poison the process.
 */
export async function embedAnchors(
  config: AppConfig,
): Promise<{ corrections: string[]; requests: string[] } | null> {
  if (!anchorCache) {
    anchorCache = (async () => {
      const embed = async (set: string[]) => {
        const packed = await Promise.all(set.map((phrase) => embedPrompt(config, phrase)));
        // A partial anchor set would bias whichever side embedded, which is
        // worse than not using the channel at all.
        return packed.every((entry): entry is string => Boolean(entry)) ? packed : null;
      };
      const [corrections, requests] = await Promise.all([
        embed(CORRECTION_ANCHORS),
        embed(NEW_REQUEST_ANCHORS),
      ]);
      return corrections && requests ? { corrections, requests } : null;
    })().then((result) => {
      if (!result) anchorCache = null;
      return result;
    });
  }
  return anchorCache;
}

/** Drops the memoised anchors. For tests, and for a config change at runtime. */
export function clearAnchorCache(): void {
  anchorCache = null;
}
