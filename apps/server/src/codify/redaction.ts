/**
 * Mechanism ① — the redaction gate.
 *
 * Runs at the Fastify request boundary, before anything reaches the store.
 * Promotion turns one user's prompts into a shared Agent specification that
 * other users can read, so an unredacted prompt is an exfiltration path. The
 * gate records which rule fired, never what it matched.
 *
 * The Agent still receives the raw prompt in memory — redaction protects the
 * store and everything downstream of it, not the intended recipient.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
}

/** Ordered most-specific first; each rule runs against the previous output. */
export const REDACTION_RULES: RedactionRule[] = [
  { name: "private-key", pattern: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g },
  { name: "model-api-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  // Real Ark model keys look like `ark-<uuid>-<suffix>`. Matched before the
  // generic UUID-ish rules so the hit names the credential, not its shape.
  { name: "ark-api-key", pattern: /\bark-[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}(?:-[A-Za-z0-9]+)?\b/g },
  { name: "ark-endpoint-id", pattern: /\bep-[A-Za-z0-9-]{8,}\b/g },
  { name: "volc-access-key", pattern: /\bAKLT[A-Za-z0-9+/=_-]{10,}\b/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "bearer-token", pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "phone", pattern: /\+\d[\d\s().-]{7,}\d\b/g },
  { name: "long-digit-run", pattern: /\b\d{9,}\b/g },
];

export interface RedactionResult {
  redactedText: string;
  /** Rule names that fired, de-duplicated and stable-ordered. */
  hits: string[];
  /** Share of the original characters that were replaced, 0..1. */
  redactionRatio: number;
  /**
   * False when so much of the prompt was secret that it cannot safely become a
   * shared task specification.
   */
  promotionEligible: boolean;
}

/** Above this share of redacted characters a prompt cannot be promoted. */
export const PROMOTION_REDACTION_CEILING = 0.25;

export function redact(
  text: string,
  rules: RedactionRule[] = REDACTION_RULES,
): RedactionResult {
  const original = text ?? "";
  const hits: string[] = [];
  let redactedCharacters = 0;
  let working = original;

  for (const rule of rules) {
    // Rules carry the global flag; reset lastIndex so reuse across calls is safe.
    rule.pattern.lastIndex = 0;
    let fired = false;
    working = working.replace(rule.pattern, (match) => {
      fired = true;
      redactedCharacters += match.length;
      return "[redacted:" + rule.name + "]";
    });
    if (fired) hits.push(rule.name);
  }

  const ratio = original.length === 0 ? 0 : redactedCharacters / original.length;
  return {
    redactedText: working,
    hits,
    redactionRatio: ratio,
    promotionEligible: ratio <= PROMOTION_REDACTION_CEILING,
  };
}

/**
 * Defence in depth for anything Codify is about to display or store that did
 * not come through the request boundary — broker targets, error strings.
 */
export function redactValue(value: string): string {
  return redact(value).redactedText;
}
