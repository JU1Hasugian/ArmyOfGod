/**
 * Mechanism ④ — deriving a capability scope from observed behaviour.
 *
 * The premise: a task performed many times has already told you what it needs.
 * This is the same pattern as `aa-logprof` generating an AppArmor profile from
 * audit logs, or IAM Access Analyzer generating a policy from CloudTrail —
 * applied to Agent tasks.
 *
 * Derivation is union-with-a-frequency-floor, never a raw union: one anomalous
 * exemplar must not widen the scope for everyone.
 */
import type { CapabilityObservation, CapabilityScope } from "./types.js";

/** Never derivable, whatever the observations say. Confused-deputy targets. */
export const NEVER_ALLOW_DOMAINS = [
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "100.100.100.200",
];

/** Workspace subtrees that must never enter a proposed scope. */
const EXCLUDED_PATH_SEGMENTS = [".ssh", ".aws", ".config", ".git", "node_modules"];

/** A domain must appear in at least this share of exemplar runs. */
export const FREQUENCY_FLOOR = 0.5;
/** Hard cap on derived domains, so a noisy cluster cannot mint a wide policy. */
export const MAX_DERIVED_DOMAINS = 5;

export const EMPTY_SCOPE: CapabilityScope = { paths: [], domains: [], secrets: [] };

/**
 * Reduce a derived scope to what may be granted without a human looking at it.
 *
 * Only ever removes. Returns both the clamped scope and what was withheld, so
 * the caller can record the difference rather than silently losing it — a
 * capability that was observed and then withheld is exactly the thing an
 * operator later needs to see justified.
 *
 * Secrets are the sharp edge and are withheld by default. A path or a domain
 * that a task demonstrably used is a narrowing of what an ad-hoc run already
 * had; a credential handed to a newly-minted principal is not.
 */
export function clampForAutoGrant(
  derived: CapabilityScope,
  options: { grantSecrets: boolean },
): { scope: CapabilityScope; withheld: CapabilityScope } {
  const secrets = options.grantSecrets ? derived.secrets : [];
  return {
    scope: { paths: derived.paths, domains: derived.domains, secrets },
    withheld: {
      paths: [],
      domains: [],
      secrets: options.grantSecrets ? [] : derived.secrets,
    },
  };
}

function frequent<T extends string>(lists: T[][], floor: number): T[] {
  if (lists.length === 0) return [];
  const counts = new Map<T, number>();
  for (const list of lists) {
    for (const value of new Set(list)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const required = lists.length * floor;
  return [...counts.entries()]
    .filter(([, count]) => count >= required)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value]) => value);
}

/** Normalise a workspace-relative path to the directory that must be writable. */
export function containingDirectory(relativePath: string): string | null {
  const normalised = relativePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
  if (!normalised || normalised.startsWith("../")) return null;
  const segments = normalised.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => EXCLUDED_PATH_SEGMENTS.includes(segment))) return null;
  // Drop the filename; a write to `out/notes.md` needs `out` writable.
  segments.pop();
  return segments.length === 0 ? "." : segments.join("/");
}

/** Remove any path already covered by an ancestor in the same set. */
export function collapsePaths(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort();
  if (unique.includes(".")) return ["."];
  return unique.filter(
    (candidate) =>
      !unique.some((other) => other !== candidate && candidate.startsWith(other + "/")),
  );
}

export function deriveScope(
  observations: CapabilityObservation[],
  floor = FREQUENCY_FLOOR,
): CapabilityScope {
  if (observations.length === 0) return { ...EMPTY_SCOPE };

  const domains = frequent(
    observations.map((observation) => observation.domainsReached.map((d) => d.toLowerCase())),
    floor,
  )
    .filter((domain) => !NEVER_ALLOW_DOMAINS.includes(domain))
    .slice(0, MAX_DERIVED_DOMAINS);

  const writeDirectories = collapsePaths(
    frequent(
      observations.map((observation) =>
        observation.pathsWritten
          .map(containingDirectory)
          .filter((value): value is string => value !== null),
      ),
      floor,
    ),
  );
  const readDirectories = collapsePaths(
    frequent(
      observations.map((observation) =>
        observation.pathsRead
          .map(containingDirectory)
          .filter((value): value is string => value !== null),
      ),
      floor,
    ),
  ).filter((path) => !writeDirectories.includes(path));

  const secrets = frequent(
    observations.map((observation) => observation.secretsRead),
    floor,
  );

  return {
    paths: [
      ...writeDirectories.map((path) => ({ path, mode: "rw" as const })),
      ...readDirectories.map((path) => ({ path, mode: "ro" as const })),
    ],
    domains,
    secrets,
  };
}

export function normalizeScope(scope: CapabilityScope): CapabilityScope {
  const seen = new Set<string>();
  const paths = scope.paths
    .map((entry) => ({
      path: (containingDirectory(entry.path + "/_") ?? ".").trim(),
      mode: entry.mode,
    }))
    .filter((entry) => (seen.has(entry.path) ? false : (seen.add(entry.path), true)));
  return {
    paths,
    domains: [...new Set(scope.domains.map((domain) => domain.trim().toLowerCase()))]
      .filter(Boolean)
      .filter((domain) => !NEVER_ALLOW_DOMAINS.includes(domain)),
    secrets: [...new Set(scope.secrets.map((secret) => secret.trim()))].filter(Boolean),
  };
}

export interface NarrowingCheck {
  ok: boolean;
  widenedDomains: string[];
  widenedPaths: string[];
  widenedSecrets: string[];
}

/**
 * The asymmetry that is the design's spine: an operator reviewing a proposal may
 * only ever narrow it. A permission is never added by argument, only by
 * demonstrated need through the escalation path.
 */
export function checkNarrowing(
  original: CapabilityScope,
  edited: CapabilityScope,
): NarrowingCheck {
  const originalDomains = new Set(original.domains.map((d) => d.toLowerCase()));
  const originalSecrets = new Set(original.secrets);
  const originalPaths = new Map(original.paths.map((entry) => [entry.path, entry.mode]));

  const widenedDomains = edited.domains
    .map((domain) => domain.toLowerCase())
    .filter((domain) => !originalDomains.has(domain));
  const widenedSecrets = edited.secrets.filter((secret) => !originalSecrets.has(secret));
  const widenedPaths = edited.paths
    .filter((entry) => {
      const previous = originalPaths.get(entry.path);
      if (previous === undefined) return true;
      // ro -> rw is a widening; rw -> ro is a narrowing and therefore allowed.
      return previous === "ro" && entry.mode === "rw";
    })
    .map((entry) => entry.path);

  return {
    ok:
      widenedDomains.length === 0 &&
      widenedPaths.length === 0 &&
      widenedSecrets.length === 0,
    widenedDomains,
    widenedPaths,
    widenedSecrets,
  };
}
