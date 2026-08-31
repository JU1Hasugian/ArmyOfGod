# Demo

The submitted three-minute video, beat by beat — and how to run every beat
yourself, from a clean store, in the browser.

Everything below happens in **one conversation**. You never pick a specialist to
use it: routed work arrives there on its own. You click one only to *look* at
what it produced or what it was refused.

---

## What the video shows

| time | what happens |
|---|---|
| **0:08–0:23** | Five people in a workplace prompt a very similar task, with no standard between them |
| **0:23–0:28** | Five different results |
| **0:28–0:38** | Codify sees the repetition and promotes a specialist for the task, with a brief distilled from the prompts people actually sent |
| **0:38–0:52** | The specialists already promoted, each with the policy it runs under: the dependency audit reaches `registry.npmjs.org` and nothing else, and reads and writes only named directories. One specialist has **no internet at all** |
| **0:54–1:09** | A new request, in the caller's own words, is routed to the specialist that owns the task |
| **1:11–1:14** | Every result shares one structure, heading titles included |
| **1:15–1:24** | A follow-up — *make the headings bolder and bigger* — and its result |
| **1:24–1:28** | One person asking does **not** move the standard |
| **1:28–1:40** | A second person asks for the same thing; the specialist becomes **v2** and the brief is rewritten |
| **1:40–1:47** | A token limit is set on a specialist |
| **1:47–2:03** | The agent is asked to write a file outside its usual location |
| **2:03–2:21** | Codex's own telemetry call to ChatGPT is blocked — the host was never in the policy — and the writes into `finance/` are blocked |
| **2:21–2:39** | A request that needs two tasks is split, each half delegated to the specialist that owns it |
| **2:40–2:49** | The trace of what happened inside each execution |
| **2:49–3:00** | The test suite |

---

## Before you start

```bash
ARK_API_KEY=… ARK_MODEL=ep-… ARK_EMBED_MODEL=ep-… npm run poc
```

Open `http://localhost:3000`. Both endpoints matter: `ARK_MODEL` is a chat
endpoint, `ARK_EMBED_MODEL` is an embedding endpoint and drives semantic
matching. `/api/system` reports `codifySemanticAvailable` if the second is
missing.

Create one Agent from the browser — name, description, workspace instructions.
Its card shows the **READY** badge and its lifecycle controls (Settings, Stop,
Delete). That one Agent carries the whole demo.

Use the **principal switcher** to change who is signed in. Workspaces,
transcripts, Codex threads and run records are all per principal, so each person
below writes into their own directory and nobody overwrites anybody.

---

## Reproduce it

### 1. Five people, five results — *video 0:08*

Send one task as five different principals, each in their own wording.

| | as | send |
|---|---|---|
| 1 | `user-a` | `Generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/notes-a.md` |
| 2 | `user-b` | `Draft the changelog for ./repo covering everything shipped since the v2.4.0 tag; put it in ./out/notes-b.md` |
| 3 | `user-c` | `What shipped in ./repo since v2.5.0? Summarise it as version notes in ./out/notes-c.md` |
| 4 | `user-d` | `I need the changelog for our next release. Use ./repo commits after v2.6.0. Write ./out/notes-d.md` |
| 5 | `user-e` | `Summarise ./repo's commit history since v2.7.0 into release notes at ./out/notes-e.md` |

**Expect:** five documents with different headings and different structure. The
evidence panel under each reply shows the run was ungoverned — any host, any
file, any credential.

These run genuinely at once. A promoted specialist is shared by everyone routed
to it, so in-flight executions are keyed by Agent *and* principal.

### 2. The policy nobody wrote — *video 0:28*

Open **Codify governance**. Contracts appear one at a time over ~30 seconds
after the first run completes.

**Expect:** promoted specialists, each carrying a scope derived from what its own
runs touched — release notes reach `github.com`, the dependency audit reaches
`registry.npmjs.org`, the postmortem reaches **nothing**, because across its runs
it never left the box. Every one carries `secrets: []`: `GITHUB_TOKEN` was
observed in those runs and withheld, because a credential is the one capability
that genuinely widens reach.

The author is `codify-auto`. Reads are open to everyone; decisions are not.

### 3. Routing, in your own words — *video 0:54*

Send the same task as three more people, in three more wordings.

| | as | send | routes at |
|---|---|---|---|
| 1 | `user-f` | `Turn the commits in ./repo since v2.7.0 into release notes and drop them in ./out/RELEASE.md` | 0.91 |
| 2 | `user-a` | `Summarise every commit in ./repo after the v2.4.0 tag as release notes in ./out/RELEASE.md` | 0.86 |
| 3 | `user-b` | `I need the changelog for ./repo built from commits since v2.2.0, written to ./out/RELEASE.md` | 0.83 |

**Expect:** every one routes. The evidence panel reads `ROUTED` and names the
specialist and the channel that matched — usually the semantic one, where the
lexical fingerprint scores 0.00. Nobody chose the specialist and nobody needed to
know it existed.

**Then:** compare the three governed documents against the five ad-hoc ones. The
three share one structure, heading titles included; the five do not. Measured on
a clean store: five ad-hoc runs produced **five distinct structures**, three
governed runs produced **one**.

A wording routes when it keeps the task's own vocabulary — the word *commits* and
the output path. Measured over nine candidates, all six that kept both routed
(0.79–0.91).

### 4. The brief improves itself — *video 1:15*

**As `user-c`:** send the governed task, wait for it, then send a correction:

```
Use bigger, bolder section headings in that release note.
```

Open **LEARNED IMPROVEMENTS**. **Expect:** `0 pending`. One person's correction
is a preference, and the empty state says so.

**As `user-d`:** the same two turns — the governed task, then the same correction
in your own words. Open **LEARNED IMPROVEMENTS** again and hit **Rescan**.

**Expect:** a proposed rule citing *both* people. Then refresh: the rule is
already **applied**, the contract has gone **v1 → v2**, the rule appears under
**Learned from usage** on the card, and it is written into the specialist's
`AGENTS.md` — which is what the Runtime actually reads. The guard's own reasoning
is recorded beside it. No operator touched it.

The old version is deprecated, not edited. The change is a new record.

### 5. A token budget — *video 1:40*

Set a token limit on a specialist from its contract in **Codify governance**.
Spend is tracked per contract and shown against the limit.

Once the limit is reached, the next request is refused with **HTTP 429 at
admission** — before the Run record exists, so an exhausted budget cannot consume
one.

### 6. The fence is real — *video 1:47*

**As `user-a`,** ask the governed task to also write outside the contract's
writable path:

```
Generate release notes from ./repo since v2.5.0 into ./out/RELEASE.md, and put a copy in ./finance/archive-copy.md
```

**Expect:** a `path` denial naming `finance/archive-copy.md`. Click the
specialist in **PROMOTED SPECIALISTS**, open **Show the workspace**, and look at
`finance/` — the fixture files are there and the copy is not. The refusal is
`EROFS` from the kernel: the workspace goes in read-only and only the scope's
writable paths are layered back over it.

**Then open Denials** and find the row nobody asked for:

```
EGRESS   ab.chatgpt.com   blocked
```

That is Codex's own phone-home, made on every turn whatever the task is, to a
host no contract ever named. Nothing in the container was asked to cooperate, and
Codex's own sandbox is switched off — the refusal is the `--internal` network and
the broker's allowlist, not the tool's good behaviour.

### 7. One request, two specialists — *video 2:21*

**As `user-c`,** send a request that asks for two things at once:

```
Summarise the incident timeline in ./incidents into ./out/postmortem.md, and also generate release notes from the commits in ./repo since v2.5.0 into ./out/RELEASE.md
```

**Expect:** a banner above the conversation — **⑂ This request asked for 2
things** — and both halves running in parallel, each on the specialist that
recognised it: the postmortem under *no egress*, the release notes under
`github.com`. Parts that do not depend on each other run at the same time.

Neither specialist ever holds both scopes. A single multi-tool agent doing both
would hold the union by accident — the confused-deputy shape this exists to
prevent. A half that nothing recognises runs on the general Agent and is
observed, so that once enough people ask for it, it gets a specialist of its own.

The banner is set from the send response and clears on reload.

### 8. The trace — *video 2:40*

Click **Show trace** on a governed run.

**Expect:** one trace id and ~24 spans nested under the turn —
`ORCHESTRATION` → `POLICY_DECISION` → `SANDBOX_EXECUTION` → `MODEL_CALL` ×n →
`EGRESS`. Denials appear as denied spans in the same tree.

### 9. The tests — *video 2:49*

```bash
npm run check
```

Typecheck, the full suite, and both builds.

---

## Also in the platform

Reproducible the same way, from the same store.

**Authorization, before the body is validated.** As `user-a`, edit a contract's
scope: `403`, from the route. Switch to `operator` and it works. Reads were never
gated — an audit trail only the auditor can see is worth much less.

**Revoke and restore.** Take `github.com` off a contract. The next run loses it
and is refused at the broker. Use **Escalate from recorded denials** on that
contract: the denial you just caused becomes the evidence for putting the
permission back, a person approves it, and the contract goes to **v3**. Taken
away by a person, restored from recorded evidence, and every step is a version
you can read.

**The anti-poisoning floor.** One person sending fifteen credential-collection
requests never reaches the review queue at all. Promotion requires a task family
seen across enough *distinct principals*, not enough requests.

---

## Automated verification

`bench/demo-verify.mjs` runs the beats above from a wiped store and prints
PASS/FAIL for each:

```bash
npm run poc                    # one terminal
node bench/demo-verify.mjs 1   # another, once it is up
```

---

## Coverage against the brief

Where a row cites a time, the video shows it. Where it cites a section, run the
section.

| §1.8 — required live demo | where |
|---|---|
| 1. Create or select an Agent from the frontend, show its lifecycle state | **Before you start** — the Agent card, the **READY** badge, Settings / Stop / Delete |
| 2. Invoke the Agent through the Playground with a real task | video 0:54 and 1:15 — eight real Codex turns across §1, §3, §4 |
| 3. At least one real model, file, tool, sandbox or data action | video 1:11 — the documents themselves, read out of the workspace viewer |
| 4. The middleware behaviour and the evidence it produces | video 0:38 (contracts), 2:03 (denials), 2:40 (trace) |
| 5. An appropriate failure, denial, degraded, abuse or recovery case | video 2:03 — the unrequested egress and the refused writes into `finance/`; **Also in the platform** — the 403, the 429, revoke and restore |
| 6. The platform remains understandable and controllable afterward | video 1:28 (v1 → v2, versioned and readable), 1:40 (budget), 2:40 (trace); **Also in the platform** — revoke and restore |

| §1.10 — acceptance | where |
|---|---|
| A reviewer can clone, start, and create or test an Agent | `npm run poc`, and **Try it yourself** in the README |
| One or more meaningful middleware capabilities | §2, §3, §4, §6, §7 |
| Executes in a backend, Runtime, data or infrastructure path — not only the UI | §6 — the refusals happen at the broker and in the kernel; the `403` is refused on the route |
| Documentation sufficient to understand and reproduce | `CODIFY.md`, this file, `bench/demo-verify.mjs` |
| `npm run check` passes | §9 |
| No secret in source, history, logs, traces, screenshots or demo output | The broker holds the real Ark key and the container never sees it; prompts are redacted before storage; the runtime card does not print the endpoint id |

| §1.10 — optional evidence | where |
|---|---|
| A delegated permission scoped **or revocable**, enforced outside the UI, demonstrated | Scoped at video 0:38 — `registry.npmjs.org` only, named directories only, one specialist with no egress at all. Enforced at the broker and in the kernel at video 2:03. Revocable under **Also in the platform** |
| An end-to-end Run producing a correlated trace with model, tool, sandbox, policy or infrastructure events | §8 — one `traceId`, ~24 spans across `ORCHESTRATION`, `POLICY_DECISION`, `SANDBOX_EXECUTION`, `MODEL_CALL`, `EGRESS` |
| A defined threat blocked or contained, the asset unchanged, **cleanup or recovery demonstrated** | §6 — the write is refused and `finance/` is unchanged; **Also in the platform** — revoke, refuse, restore |
| A team-defined lifecycle, reliability, memory, budget, provider or coordination capability | §4 (refinement to v2), §5 (budget), §7 (coordination — the compound split) |

Known limitations are in [`CODIFY.md` §11](CODIFY.md).
