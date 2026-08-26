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
 * The second is worse on both counts, so the test leans towards continuity. It
 * is deliberately not a model call: this is on the live request path, where the
 * only model call in the system is the planner, and that one is reached solely
 * for prompts already carrying a compound signature.
 */

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

/** A self-contained request usually names where it operates. */
const TARGET = /(^|\s)(\.\/|\/|~\/)[\w.\-/]+|https?:\/\/|\b\w+\.(md|csv|json|ts|tsx|js|py|txt|ya?ml|toml|html)\b/i;

export interface FollowUpVerdict {
  followUp: boolean;
  reason: string;
}

/**
 * Does this read as a continuation of the previous turn?
 *
 * Only ever consulted when nothing matched a contract — a recognised task is a
 * new instance of that task regardless of what came before it, which is the
 * same rule that starts a fresh Codex thread on a matched turn.
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

  // Short, targetless imperatives are corrections far more often than they are
  // new tasks: "use more colour", "break it up with headings".
  if (words.length <= SHORT_ENOUGH) {
    return { followUp: true, reason: "short and names no new subject" };
  }

  // Beyond that the markers alone are not enough. "it" is a referential word,
  // but it is also just English: *"draft a birthday message and send it round
  // the team"* is a whole new task that happens to contain a pronoun. A
  // correction long enough to need one is rare; a fresh request long enough to
  // contain one is ordinary. So the markers only decide within a window, and
  // anything longer reads as self-contained.
  if (words.length > MARKER_WINDOW) {
    return { followUp: false, reason: "long enough to be a request in its own right" };
  }

  const has = (list: string[]) => words.some((word) => list.includes(word));
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
/** Above this, referential and adjustment words stop being evidence. */
const MARKER_WINDOW = 12;
