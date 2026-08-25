/**
 * Mechanism ③ — canonicalisation, fingerprinting, and clustering.
 *
 * Deterministic by design: the demo must never hinge on a model call, and the
 * clustering threshold must be testable. MinHash over word shingles gives a
 * fixed-size signature whose per-position agreement estimates Jaccard
 * similarity between the underlying shingle sets.
 */
import { createHash } from "node:crypto";

/** Number of hash permutations in a signature. */
export const SIGNATURE_LENGTH = 64;
/**
 * Shingle widths, unioned. 2-grams tolerate a single substituted word; 3-grams
 * keep unrelated tasks far apart. Using both gets most of each.
 */
export const SHINGLE_SIZES = [2, 3];
/**
 * Similarity required to treat two prompts as the same task.
 *
 * Chosen from measurement, not intuition. Across the fixture corpus,
 * rephrasings of one task score 0.45-1.00 while genuinely different tasks score
 * 0.00-0.05. 0.65 sits inside that gap: a one-word substitution still matches,
 * and nothing unrelated comes close. Routing fails open, so a false negative
 * costs an ungoverned ad-hoc run while a false positive would apply the wrong
 * policy — the threshold is deliberately biased towards the former.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.65;

/**
 * Filler words that vary freely between people describing the same task and
 * carry no capability signal. Deliberately tiny: anything that could change
 * what a task *does* stays in.
 */
const STOPWORDS = new Set([
  "please", "kindly", "the", "a", "an", "of", "for", "that", "this", "it",
  "them", "then", "and", "also", "just", "can", "you", "could", "would",
]);

/**
 * Crude suffix stripping so "commits"/"commit" and "writing"/"write" agree.
 * It mangles words ("writing" becomes "writ"), which is fine: the output is a
 * matching key, and it is mangled identically on both sides of a comparison.
 */
function stem(word: string): string {
  if (word.startsWith("{")) return word;
  const stripped = word.replace(/(ing|ed|es|s)$/, "");
  return stripped.length >= 4 ? stripped : word;
}

/**
 * Normalise a prompt so that incidental differences — casing, punctuation,
 * dates, counts, quoted strings, paths — collapse, while the task shape stays.
 */
export function canonicalize(text: string): string {
  return (text ?? "")
    .toLowerCase()
    // Redaction placeholders are noise for clustering purposes.
    .replace(/\[redacted:[a-z-]+\]/g, " {SECRET} ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " {DATE} ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " {DATE} ")
    .replace(/(?:^|\s)(?:\.{0,2}\/)[^\s"']*/g, " {PATH} ")
    .replace(/\bhttps?:\/\/\S+/g, " {URL} ")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, " {STR} ")
    .replace(/\bv?\d+(?:\.\d+)+\b/g, " {NUM} ")
    .replace(/\b\d+\b/g, " {NUM} ")
    // Placeholders are inserted after lower-casing, so keep A-Z here or this
    // pass would erase `{PATH}` down to `{}`.
    .replace(/[^a-zA-Z0-9{}\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !STOPWORDS.has(word))
    .map(stem)
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function shingles(canonical: string, sizes: number[] = SHINGLE_SIZES): string[] {
  const words = canonical.split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const result: string[] = [];
  for (const size of sizes) {
    if (words.length < size) {
      result.push(words.join(" "));
      continue;
    }
    for (let index = 0; index + size <= words.length; index += 1) {
      result.push(words.slice(index, index + size).join(" "));
    }
  }
  return [...new Set(result)];
}

function hashShingle(shingle: string, seed: number): number {
  return createHash("sha1")
    .update(seed + ":" + shingle)
    .digest()
    .readUInt32BE(0);
}

/** MinHash signature, hex-encoded so it can live in JSON and compare cheaply. */
export function fingerprint(canonical: string): string {
  const grams = shingles(canonical);
  if (grams.length === 0) return "";
  const signature: string[] = [];
  for (let seed = 0; seed < SIGNATURE_LENGTH; seed += 1) {
    let minimum = 0xffffffff;
    for (const gram of grams) {
      const value = hashShingle(gram, seed);
      if (value < minimum) minimum = value;
    }
    signature.push(minimum.toString(16).padStart(8, "0"));
  }
  return signature.join("");
}

/** Estimated Jaccard similarity of two signatures, 0..1. */
export function similarity(left: string, right: string): number {
  if (!left || !right || left.length !== right.length) return 0;
  let agreements = 0;
  for (let index = 0; index < SIGNATURE_LENGTH; index += 1) {
    const start = index * 8;
    if (left.slice(start, start + 8) === right.slice(start, start + 8)) agreements += 1;
  }
  return agreements / SIGNATURE_LENGTH;
}

/**
 * Coarse bucket key used to name a cluster. Not used for matching — that is
 * always the MinHash signature — but it gives a candidate a stable identity
 * across background passes.
 */
export function clusterKey(canonical: string): string {
  const words = canonical
    .split(" ")
    .filter((word) => word.length > 3 && !word.startsWith("{"));
  const salient = [...new Set(words)].sort().slice(0, 6).join("-");
  return createHash("sha1").update(salient).digest("hex").slice(0, 12);
}

export interface Clusterable {
  fingerprint: string;
}

/**
 * Greedy single-pass clustering under single linkage: an item joins the first
 * cluster containing any member it is similar enough to, otherwise it seeds a
 * new one. Deterministic for a given input order, which is what the tests and
 * the routing path both rely on — routing scores an inbound prompt against every
 * fingerprint a contract carries and takes the best, which is the same rule.
 */
export function cluster<T extends Clusterable>(
  items: T[],
  threshold = DEFAULT_MATCH_THRESHOLD,
): T[][] {
  const clusters: T[][] = [];
  for (const item of items) {
    if (!item.fingerprint) continue;
    const existing = clusters.find((members) =>
      members.some((member) => similarity(member.fingerprint, item.fingerprint) >= threshold),
    );
    if (existing) existing.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

/** Best similarity of a prompt against any fingerprint a contract carries. */
export function bestScore(candidate: string, fingerprints: string[]): number {
  return fingerprints.reduce(
    (best, entry) => Math.max(best, similarity(candidate, entry)),
    0,
  );
}
