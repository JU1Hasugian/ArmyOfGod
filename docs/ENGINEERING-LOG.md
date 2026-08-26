# Engineering log

**A handover record: what was done, what was measured, what was tried and
discarded, and which conclusions were reached the wrong way before they were
reached the right way.**

This exists so that whoever picks the project up next — human or agent — does not
have to re-derive the reasoning, and does not repeat the mistakes. Numbers here
are measurements, not estimates; where something is unverified it says so.

---

## 1. Orientation

Codify is middleware on top of the Track 1 Starter Kit. Its thesis:

> You cannot specify what a non-deterministic actor may touch before you have
> seen what it touches, and you cannot write the perfect brief for a task before
> seeing how it is really used. But a task performed fifty times has already
> answered both. Harvest the brief and the policy from the same observations.

The quality half is not a second feature — it is the **adoption mechanism** for
the security half. People take the governed path because it produces the better
answer, and least privilege arrives as a side effect.

Read in this order: `README.md` → `docs/CODIFY.md` (design) →
`docs/SEMANTIC-ROUTING.md` (all measurement).

---

## 2. What was found broken, and fixed

### 2.1 `npm run check` was failing — 12 tests, 9 of them the security suite

The broker is loaded by `broker.test.ts` via `import()`. It began with a
**shebang**, which Vite's transform cannot handle, so the import threw
`SyntaxError` and **all nine broker egress-control and credential-exchange tests
silently never ran**. The broker is launched as `node /codify/broker.mjs` and is
never exec'd directly, so the shebang was decorative. Removed.

Two container tests asserted POSIX paths against a `path.resolve`d value, and
`JsonStore.persist` did not retry its atomic `rename`, so a transient `EPERM`
failed a run rather than just a test. Both fixed.

### 2.2 The matcher recognised almost nothing

MinHash estimates **Jaccard**, `|A∩B| / |A∪B|`, which *decreases monotonically as
the inbound text grows*. That is disqualifying for a router whose input the
caller writes: two sentences of ordinary politeness dropped a governed task from
1.000 to 0.578 against a 0.65 threshold, and it ran unenforced.

The same property broke **detection**, silently and worse: twelve genuine
wordings of one task produced fourteen clusters whose largest held three
members, against a promotion floor of five. **Nothing would ever have been
promoted.** The seeded corpus hid this because its fixtures differed only in a
version number and an output path, both of which canonicalisation crushes to
placeholders.

Fixed by matching on three channels, ORed:

| channel | strong against | blind to |
|---|---|---|
| `fingerprint` (MinHash) | near-duplicates | everything below |
| `containment` `|A∩B|/|A|`, exact | padding, dilution, injection | vocabulary |
| `semantic` (Ark embedding cosine) | rewording, obfuscation, translation | heavy dilution |

ORed rather than blended **on purpose**: each attack is invisible to one channel,
so averaging drags the channel that *can* see it under the line.

### 2.3 One specialist, one Codex session, everybody

A promoted specialist is one Agent that everyone routed to it executes on, and it
held **one thread for all of them**. A specialist carrying 26 turns replied
*"Done. `./out/RELEASE.md` has the release notes"* and wrote nothing — five times
— while the same task under identical scope on a fresh thread ran correctly. It
was answering from the memory of having done it.

Fixed two ways: threads are keyed by principal, and **a turn that matches a
contract starts a fresh thread**, because it is a new instance of the task rather
than a continuation. For a repeated job, continuity is a liability; the
specialist's value is its brief and workspace, both of which persist. Follow-ups
that *don't* match still resume — that is the turn the refinement loop harvests.

### 2.4 Clustering chained across unrelated tasks

Detection used **single linkage**: an item joined a cluster if it matched *any*
member, which makes membership transitive. Over 360 prompts spanning twelve
unrelated tasks arriving together:

| linkage | clusters | containing more than one family |
|---|---|---|
| single | 9 | **2** |
| seed (leader) | 13 | **0** |

A contaminated cluster mints one contract with the **union of those families'
scopes** — the confused-deputy shape the design exists to prevent. Every
streaming test missed it and none *could* have: once a family is promoted its
prompts are routed instead of feeding detection, so the eligible pool never holds
several families at once. A real backlog does.

### 2.5 UI faults invisible to an API-contract check

39/39 API shape assertions passed while the page was visibly broken. `.button`
carried no background or colour of its own while a dozen sites use it bare, so
they fell through to the browser default — which made the **Codify governance nav
button white-on-white**, hiding the entrance to the whole governance view.
`className="button ghost"` was a dead class. And a global `input` rule set
`width:100%; height:40px`, which **every checkbox inherited**.

Lesson worth keeping: a contract check cannot see a colour.

---

## 3. What was built

| mechanism | where | note |
|---|---|---|
| three-channel matching | `codify/semantic.ts` | embeds the *redacted text*, not the canonical form — canonicalisation destroys the signal an embedding reads |
| principal-bound scope | `codify/service.ts` | `principal_bound`: a specialist runs under its own contract's scope whatever it is asked, so evading the matcher costs the brief and gains no capability |
| trace | `codify/trace.ts` | spans carry the id of the record they describe; a view, never a second source of truth |
| budget | `codify/budget.ts` | admission only — a run in flight is never interrupted; spend follows the whole contract lineage so narrowing a scope cannot reset it |
| coordination | `codify/coordination.ts` | turn selection **is** the router, so each step runs under the matching specialist's scope and the union scope never exists |
| auto-promotion | `service.autoPromote` | gated by `reviewScope`, which sees a task name and three lists — never prompt text |

### Why `reviewScope` sees no prose

The observations are user-written. A reviewer reading *prompt text* would be
reading attacker-influenceable prose and could be argued with. A hostname has
nowhere for an instruction to hide. It is a **tier, not a boundary** — the
distinct-user floor, frequency floor, never-allow list and secret clamp all hold
without it. It **fails closed**, unlike every other model call in Codify, because
failing open there would auto-approve precisely the cases nobody looked at.

---

## 4. Tried, measured, and rejected

Three principled ideas were validated **before** being built and none shipped.
Recording them matters: a threshold defended only by the sweep that produced it
is a tuned constant; one that survived alternatives is a decision.

**Contrastive matching with counter-exemplars** — have promotion generate
requests that sit just outside the task, and require a margin. Dominated by a
plain threshold on *both* axes (84.7% recall / 90 near-miss, versus 97.8% / 71 at
threshold 0.78). Auto-generated counter-exemplars land close to genuine positives
too.

**Per-contract thresholds derived from exemplar cohesion.** Cohesion genuinely
varies (0.822–0.937 across twelve), but `threshold = cohesion − slack` traces
almost the same recall/precision frontier a single constant does. Not worth a
derived quantity over a number an operator can read.

**Exemplar growth from confirmed matches.** Two arms over the same 2,247-prompt
stream. **No drift** — worst centroid movement 0.013, purity 100%, contagion 0 —
but also **no benefit**: identical coverage, identical accuracy, zero extra
prompts matched. Safe and pointless on this data, because carryover is already
100%.

---

## 5. Decisions, and the reasoning behind them

**Routing fails open; enforcement fails closed; model calls fail soft.** A missed
match costs quality; a missed limit costs containment. `reviewScope` is the one
model call that fails closed.

**`CODIFY_AUTO_PROMOTE` defaults on.** Promotion does not create the task and does
not grant capability — the runs it derives from already reached those hosts and
wrote those paths, unbounded. The derived scope *is* that behaviour, so promoting
**narrows**. What review guards against is *laundering*, and that judgement is
delegated. The human belongs *after*: a gate nobody exercises degrades into
rubber-stamping, which manufactures assurance without producing any. This also
matches what oversight regimes actually require — that oversight be *possible and
effective*, not that a person approve every action.

> This flipped twice during the session. On (100-prompt evidence) → off (misread
> a 2,247-prompt run as over-firing) → on. The middle position was wrong: "36
> contracts where 12 tasks existed" compared against an arbitrary baseline; the
> other 23 were genuinely recurring tasks.

**Credentials stay clamped** (`CODIFY_AUTO_GRANT_SECRETS=false`). A host or path a
task demonstrably used is a narrowing; handing a brand-new principal a credential
is the one step that genuinely widens reach. Withheld secrets are recorded as
`DenialEvent`s so the evidence for granting them accumulates where an egress
refusal lands.

**Semantic threshold 0.72.** Positives and adversarial near-misses genuinely
overlap, so no threshold separates them; 0.72 is the cheapest point where
cross-contract error reaches zero. Biasing higher became defensible only once
principal binding changed what a miss costs.

**Handoff, not call-and-return.** Delegation moves the conversation to the
specialist rather than relaying a result back. Right, because the specialist's
value is partly its workspace and session, which call-and-return would strand.
The residual UX weakness — your history fragments — is noted below.

---

## 6. Mistakes made while measuring

Recorded because each one nearly became a wrong conclusion in the repo.

**CRLF, twice.** Claimed a submission-blocking CRLF problem in committed blobs.
Both probes had shell-escaping bugs (`grep -c '\\r'` matches the letter *r*;
`tr -cd "\r"` through nested `bash -c` counts backslashes). The blobs are clean
LF. The CRLF existed only in a tar produced by `git archive` on a Windows
checkout with `core.autocrlf=true`.

**Raw vectors versus packed embeddings.** The scratch corpus stores raw unit
vectors; `PromptObservation.embedding` stores an int8+base64 packing. Feeding one
where the other belongs made **every pair score 1.00**, which looked exactly like
catastrophic cluster chaining and prompted a fix on a false premise. Fixing the
harness gave a clean result; only *then* did comparing the two linkage rules
expose the real, much smaller defect.

**The consistency A/B, three times over.** Measured headings in the chat message
when the artefact is a *file*. Then the specialist's workspace still held that
file from earlier runs, so it short-circuited. Then every control arm was
**delegated back to the same specialist** — sending a governed task to a plain
Agent does not produce a plain run. `forceAdHoc` exists for exactly this.

**The office run, twice.** First attempt made a live embedding call per prompt,
serially, and never finished. Second ran with `CODIFY_LLM_DRAFTING=false`, which
disables the reviewer — and since the reviewer fails closed, nothing was ever
promoted, which left every observation eligible forever and made each pass
re-cluster the whole store. One cause, both symptoms.

---

## 7. Verification surface

| test | proves | how to run |
|---|---|---|
| `npm run check` | 186 tests, typecheck, both builds | `npm run check` |
| `semantic.live.test.ts` | recognition against a real Ark endpoint | set `ARK_API_KEY` + `ARK_EMBED_MODEL`; skips otherwise |
| live-demo (49 checks) | the policy **binds** — real Docker, real Codex, derived scope enforced, `ab.chatgpt.com` refused, budget 429, trace, two specialists never sharing a scope | scratch harness, needs a container engine |
| office run (1,748 prompts) | the **learning loop** from an empty store | scratch harness |

**Headline numbers** (all in `docs/SEMANTIC-ROUTING.md`):

- Independent benchmark, 685 probes a model wrote: lexical-only recall **1.7%**,
  three channels **100%**, background false positives **0/2000**.
- Office run: **12/12** families promoted by prompt 100, **297/297** carryover,
  **0/788** one-off requests routed, **0** contracts holding two families' egress.
- Datasets: `google-research-datasets/paws`, `SetFit/qqp`,
  `agentlans/allenai-WildChat`, `fka/prompts.chat`, `bigcode/bigcodebench`,
  `princeton-nlp/SWE-bench`.

---

## 8. Environment notes

- Development host is Windows; the platform targets **Linux**. A WSL2 Ubuntu
  22.04 box with Docker Engine and Node 22 is the working setup — `npm run poc`
  runs there unmodified. The Windows host has no container engine, so
  `codifyEnforcing` is false there and enforcement cannot be exercised.
- The Ark **embedding** model must be activated in the console; an unactivated
  one answers `ModelNotOpen` with HTTP 404, indistinguishable from a wrong
  endpoint id unless the message is read. It is reached at
  `/embeddings/multimodal`, one text per call, 2048 dimensions.
- The kernel in that WSL image does not expose Landlock, so Codex falls back to
  `danger-full-access`. This is *useful*: the enforcement evidence was collected
  with Codex's own sandbox switched off, which is the case Codify's container
  boundary exists for.
- Measurement harnesses and embedding caches live in the session scratch
  directory, not the repo. They are throwaway; the results they produced are in
  the docs.

---

## 9. Open items

**Blocking.** The GitHub repository is **private**. Anonymous clone returns
404/401, so a reviewer cannot clone it — the first line of the acceptance
checklist. Nothing else matters until that changes.

**Unmeasured.** The *consistency* claim — that a specialist's output is more
predictable than a general agent's — still rests on one hand-picked A/B. Three
attempts to measure it properly were invalidated (§6). The ad-hoc control
happened to produce identical structure across 4 runs, so on that task there was
no variance to close.

**Known limitations**, in `docs/CODIFY.md` §11: within-family over-matching, word
order (PAWS unaffected by embeddings), budget binding at admission only,
coordination advancing one turn per call, JSON persistence being single-process.

**Worth considering next.** Delegation switches the view to another agent
mid-conversation; a stub in the original transcript (*"→ handed to Release
notes"*) would keep the user's history continuous without changing the
architecture. And the demo should lead with the derived scope — *"nobody wrote
this policy"* — then the appended-exfiltration case, then `ab.chatgpt.com`.
Breadth is explicitly not what the brief rewards.
