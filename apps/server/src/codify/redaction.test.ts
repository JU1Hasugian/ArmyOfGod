import { describe, expect, it } from "vitest";
import { PROMOTION_REDACTION_CEILING, redact } from "./redaction.js";

describe("Codify redaction gate", () => {
  it("keeps secret material out of anything that will be persisted", () => {
    const fixtures = [
      "sk-livekey1234567890abcdefghij",
      // The Volcengine Ark model-key shape. Synthetic value, real format.
      "ark-00000000-1111-4222-8333-444444444444-abcde",
      "ep-20250101abcdef",
      "AKLTZmFrZWFjY2Vzc2tleQ",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "Bearer abcdefghijklmnopqrstuvwx",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
      "ada.lovelace@example.com",
      "+1 415 555 0199",
      "4111111111111111",
    ];
    const prompt = "Deploy using " + fixtures.join(" and ") + " then report.";
    const result = redact(prompt);

    for (const secret of fixtures) {
      expect(result.redactedText).not.toContain(secret);
    }
    expect(result.hits.length).toBeGreaterThanOrEqual(10);
    expect(result.hits).toContain("ark-api-key");
  });

  it("names the rule that fired and never the value it matched", () => {
    const result = redact("token sk-livekey1234567890abcdefghij for the job");
    expect(result.hits).toContain("model-api-key");
    for (const hit of result.hits) {
      expect(hit).not.toContain("sk-");
    }
    expect(JSON.stringify(result.hits)).not.toContain("livekey");
  });

  it("marks a prompt that is mostly secret as ineligible for promotion", () => {
    const mostlySecret = redact(
      "sk-livekey1234567890abcdefghij sk-otherkey1234567890abcdefgh sk-thirdkey1234567890abcdefg",
    );
    expect(mostlySecret.redactionRatio).toBeGreaterThan(PROMOTION_REDACTION_CEILING);
    expect(mostlySecret.promotionEligible).toBe(false);

    const ordinary = redact(
      "Generate release notes from the commits in ./repo and write them to ./out/RELEASE.md",
    );
    expect(ordinary.promotionEligible).toBe(true);
    expect(ordinary.hits).toEqual([]);
  });

  it("is reusable across calls despite global regexes", () => {
    const once = redact("contact ada.lovelace@example.com");
    const twice = redact("contact ada.lovelace@example.com");
    expect(twice.redactedText).toBe(once.redactedText);
    expect(twice.hits).toEqual(once.hits);
  });
});
