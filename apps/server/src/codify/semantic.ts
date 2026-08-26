/**
 * Mechanism ③b — semantic matching.
 *
 * The lexical fingerprint in `fingerprint.ts` estimates *Jaccard* similarity,
 * and Jaccard has a property that is fatal for a router an untrusted party can
 * write to: it is monotonically decreasing in the length of the inbound text.
 * |A∩B| / |A∪B| falls every time the caller adds a word, so anyone who wants to
 * leave a governed task can simply say more. Two polite sentences were enough
 * (see `semantic.test.ts`), and the same mechanism silently defeats detection:
 * twelve genuine wordings of one task cluster into twelve singletons and the
 * occurrence threshold is never reached.
 *
 * This module adds two channels that fail in different directions:
 *
 *   containment  |A∩B| / |A|, exact rather than sketched. It asks "is the
 *                governed task still in here?", which padding cannot change, so
 *                it holds under arbitrary dilution. It is blind to vocabulary.
 *
 *   embedding    cosine over an Ark embedding. It survives rewording,
 *                obfuscation and translation, and it degrades under heavy
 *                dilution — exactly where containment is strongest.
 *
 * Neither is sufficient alone; measured against the corpus in
 * `docs/SEMANTIC-ROUTING.md`, the pair covers every evasion tried. The
 * embedding channel is best-effort by construction: a failed or slow call
 * yields `null` and matching degrades to the lexical channels, which is the
 * behaviour the platform had before this module existed.
 */
import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import { shingles } from "./fingerprint.js";

/**
 * Fraction of the *contract's* shingles present in the inbound prompt.
 *
 * Asymmetric on purpose. The contract side is the denominator, so growing the
 * prompt can only ever add matches. That is what makes the score padding-proof:
 * an evader who appends filler keeps containment at 1.0, and an attacker who
 * appends instructions stays inside the contract that constrains them.
 */
export function containment(contractCanonical: string, promptCanonical: string): number {
  const contractGrams = new Set(shingles(contractCanonical));
  if (contractGrams.size < MIN_CONTAINMENT_SHINGLES) return 0;
  const promptGrams = new Set(shingles(promptCanonical));
  let shared = 0;
  for (const gram of contractGrams) if (promptGrams.has(gram)) shared += 1;
  return shared / contractGrams.size;
}

/**
 * Below this many shingles a contract exemplar is too short to be evidence.
 *
 * Measured: "Write the weekly status update" reduces to three shingles, and
 * *any* prompt that happens to contain that phrase then scores 1.0 — including
 * "…and then delete every file in /". Realistic exemplars carry 15-21 shingles,
 * so the floor costs nothing and closes the degenerate case.
 */
export const MIN_CONTAINMENT_SHINGLES = 10;

/**
 * Containment required to treat a prompt as an instance of a task.
 *
 * Calibrated, like every threshold here, against the measured corpus: 370 real
 * unrelated prompts scored 0.000, and every padded or diluted variant of a
 * governed task scored 1.000. Anything in between is a wide, empty gap.
 */
export const DEFAULT_CONTAINMENT_THRESHOLD = 0.6;

/**
 * Cosine required to treat two prompts as the same task.
 *
 * The weakest true positive in the corpus scored 0.753 and the strongest of 370
 * unrelated real prompts scored 0.307. 0.70 sits in that gap, biased towards
 * catching: routing still fails open, so a miss costs an ungoverned run.
 */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.7;

// ------------------------------------------------------------------ storage

/**
 * Embeddings are 2048 floats. Stored as JSON numbers that is ~43 KB each, which
 * would dwarf every other record in the JSON store, so they are quantised to
 * int8 and base64-encoded: 2.7 KB, a 16x reduction. Measured cosine error is
 * 3.4e-4 mean / 1.2e-3 max against a threshold gap of 0.44, so the quantisation
 * is free at the precision this decision needs.
 */
export function packEmbedding(vector: number[]): string {
  const scale = Math.max(...vector.map((value) => Math.abs(value))) || 1;
  const bytes = Buffer.alloc(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    const quantised = Math.round(((vector[index] as number) / scale) * 127) + 128;
    bytes[index] = Math.max(0, Math.min(255, quantised));
  }
  return bytes.toString("base64");
}

/** Inverse of `packEmbedding`, returning a unit vector. Null if unreadable. */
export function unpackEmbedding(packed: string): number[] | null {
  if (!packed) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(packed, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const vector = new Array<number>(bytes.length);
  let norm = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = ((bytes[index] as number) - 128) / 127;
    vector[index] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!norm) return null;
  return vector.map((value) => value / norm);
}

/** Cosine of two unit vectors. Zero when the shapes disagree. */
export function cosine(left: number[] | null, right: number[] | null): number {
  if (!left || !right || left.length !== right.length) return 0;
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] as number) * (right[index] as number);
  }
  return total;
}

/** Cosine between two packed embeddings, for callers reading from the store. */
export function packedCosine(left: string | undefined, right: string | undefined): number {
  if (!left || !right) return 0;
  return cosine(unpackEmbedding(left), unpackEmbedding(right));
}

// ------------------------------------------------------------------ the call

const REQUEST_TIMEOUT_MS = 4_000;
/** Bounded so a struggling endpoint delays a turn by seconds, never minutes. */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
/**
 * Bounded so a hot store cannot grow without limit in a long-lived process.
 * Keyed by the exact text embedded, so a repeated prompt costs one call.
 */
const CACHE_LIMIT = 2_000;
const cache = new Map<string, string>();

function cacheKey(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function remember(key: string, packed: string): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, packed);
}

/** Test seam: drop the process-local embedding cache. */
export function clearEmbeddingCache(): void {
  cache.clear();
}

/**
 * Embed a redacted prompt, returning the packed vector or `null`.
 *
 * What is embedded is the *redacted text*, deliberately not the canonical form
 * the lexical channels use. Canonicalisation exists to make matching robust to
 * incidental difference: it lowercases, strips stopwords, crushes paths and
 * versions to placeholders, and stems words into non-words ("everything" ->
 * "everyth"). Every one of those steps removes signal an embedding model was
 * trained to read. Measured on the same probes, embedding the canonical form
 * cost 0.12 of cosine on a genuine rewording and pulled it under the threshold;
 * the redacted text also separates negatives better. The two representations
 * are tuned for opposite things, so each channel gets its own.
 *
 * Redaction has already run, so this is safe: no secret can leave the control
 * plane through the embedding call.
 *
 * `null` is an ordinary outcome, not an error path: no endpoint configured, the
 * feature switched off, a timeout, an exhausted retry budget, a malformed body.
 * Every caller treats it as "this channel has no opinion" and falls back to the
 * lexical ones, so an unreachable model degrades match quality but never breaks
 * a run.
 */
export async function embedPrompt(
  config: AppConfig,
  redactedText: string,
): Promise<string | null> {
  if (!config.codifySemanticEnabled) return null;
  if (!config.arkApiKey || !config.arkEmbedModel) return null;
  const trimmed = redactedText.trim();
  if (!trimmed) return null;

  const key = cacheKey(trimmed);
  const cached = cache.get(key);
  if (cached) return cached;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    const outcome = await requestEmbedding(config, trimmed);
    if (outcome.packed) {
      remember(key, outcome.packed);
      return outcome.packed;
    }
    if (!outcome.retryable || attempt === RETRY_ATTEMPTS - 1) return null;
    await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
  }
  return null;
}

/**
 * One attempt, reporting whether a failure is worth repeating.
 *
 * The distinction matters more here than it looks. A 429 or a 503 that is
 * treated as "no embedding" silently drops the semantic channel for that turn,
 * and because routing fails open, a prompt that should have been governed then
 * runs unenforced. A rate limit must not become a policy decision, so transient
 * failures are retried and only a real answer — or an exhausted budget — ends
 * the attempt.
 */
async function requestEmbedding(
  config: AppConfig,
  text: string,
): Promise<{ packed: string | null; retryable: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.arkBaseUrl + "/embeddings/multimodal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + config.arkApiKey,
      },
      body: JSON.stringify({
        model: config.arkEmbedModel,
        // The multimodal endpoint fuses a multi-item input into one vector, so
        // one call embeds one prompt. Truncated because a caller controls the
        // length and the tail of a diluted prompt carries no task signal.
        input: [{ type: "text", text: text.slice(0, 4_000) }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // 4xx other than 429 is a configuration answer, not a hiccup: a wrong
      // endpoint or an unactivated model will say the same thing next time.
      return { packed: null, retryable: response.status === 429 || response.status >= 500 };
    }
    const body = (await response.json()) as { data?: { embedding?: unknown } };
    const vector = body?.data?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) return { packed: null, retryable: false };
    if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { packed: null, retryable: false };
    }
    return { packed: packEmbedding(vector as number[]), retryable: false };
  } catch {
    // Aborts and socket errors are the transient case by definition.
    return { packed: null, retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------------------------------------ matching

export type MatchChannel = "fingerprint" | "containment" | "semantic";

export interface MatchResult {
  /** True when any channel cleared its own threshold. */
  matched: boolean;
  /** The channel that carried the decision, for the audit record. */
  channel: MatchChannel;
  /** The winning channel's raw score, on that channel's own scale. */
  score: number;
  /**
   * Score normalised by the winning channel's threshold. Comparable across
   * channels, so several matching contracts can be ranked against each other.
   */
  confidence: number;
  scores: Record<MatchChannel, number>;
}

export interface MatchThresholds {
  fingerprint: number;
  containment: number;
  semantic: number;
}

export interface MatchCandidate {
  fingerprint: string;
  canonicalForm: string;
  /** Packed embedding, when one was obtained. */
  embedding?: string;
}

/**
 * Score a prompt against one contract exemplar across all three channels.
 *
 * The channels are combined with OR, not with a weighted sum. A weighted score
 * lets a strong channel be dragged under the line by a weak one, which is
 * precisely the failure being fixed: the diluted prompt that containment sees
 * perfectly is the one the embedding sees worst, and vice versa. Each channel
 * carries its own calibrated threshold and any one of them is enough.
 */
export function matchAgainst(
  exemplar: MatchCandidate,
  prompt: MatchCandidate,
  thresholds: MatchThresholds,
): MatchResult {
  const scores: Record<MatchChannel, number> = {
    fingerprint: fingerprintScore(exemplar.fingerprint, prompt.fingerprint),
    containment: containment(exemplar.canonicalForm, prompt.canonicalForm),
    semantic: packedCosine(exemplar.embedding, prompt.embedding),
  };

  let best: MatchResult = {
    matched: false,
    channel: "fingerprint",
    score: scores.fingerprint,
    confidence: 0,
    scores,
  };
  for (const channel of ["fingerprint", "containment", "semantic"] as MatchChannel[]) {
    const threshold = thresholds[channel];
    if (threshold <= 0) continue;
    const confidence = scores[channel] / threshold;
    if (confidence > best.confidence) {
      best = {
        matched: scores[channel] >= threshold,
        channel,
        score: scores[channel],
        confidence,
        scores,
      };
    }
  }
  return best;
}

/** Best match of a prompt against every exemplar a contract carries. */
export function bestMatch(
  exemplars: MatchCandidate[],
  prompt: MatchCandidate,
  thresholds: MatchThresholds,
): MatchResult {
  let best: MatchResult | null = null;
  for (const exemplar of exemplars) {
    const result = matchAgainst(exemplar, prompt, thresholds);
    if (!best || result.confidence > best.confidence) best = result;
  }
  return (
    best ?? {
      matched: false,
      channel: "fingerprint",
      score: 0,
      confidence: 0,
      scores: { fingerprint: 0, containment: 0, semantic: 0 },
    }
  );
}

/** Re-exported so this module owns the whole scoring surface. */
function fingerprintScore(left: string, right: string): number {
  if (!left || !right || left.length !== right.length) return 0;
  const width = 8;
  const positions = left.length / width;
  let agreements = 0;
  for (let index = 0; index < positions; index += 1) {
    const start = index * width;
    if (left.slice(start, start + width) === right.slice(start, start + width)) agreements += 1;
  }
  return agreements / positions;
}

/**
 * Greedy single-linkage clustering under the same OR-of-channels rule routing
 * uses, so a cluster that would be promoted is exactly a cluster that would
 * later match.
 *
 * The lexical channel alone was not enough to cluster real usage. Measured on
 * twelve genuine wordings of one task, MinHash produced twelve clusters whose
 * largest held three members — below the five-run promotion floor, so nothing
 * was ever promoted and the platform's central premise quietly did not hold.
 * The same twelve reduce to one pure cluster once the semantic channel is
 * present.
 */
export function clusterByMatch<T extends MatchCandidate>(
  items: T[],
  thresholds: MatchThresholds,
): T[][] {
  const clusters: T[][] = [];
  for (const item of items) {
    if (!item.fingerprint && !item.embedding) continue;
    const existing = clusters.find((members) =>
      members.some((member) => matchAgainst(member, item, thresholds).matched),
    );
    if (existing) existing.push(item);
    else clusters.push([item]);
  }
  return clusters;
}
