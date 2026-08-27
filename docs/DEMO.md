# Demo runbook

Written so somebody who did not build this can record the whole thing. Every
step says **who to be signed in as, what to open, what to type, what should come
back, and what to say over it.**

It is a recorded demo, so cuts and speed-ups are assumed. Nothing here is paced
around how long a container turn takes.

**Everything happens in one conversation.** You never click a specialist to *use*
it — routed work arrives there on its own, and choosing one by hand would
undercut the whole point. You do click one twice, to *look* at what it produced
(Part 3.1) and at what it was refused (Part 4.3). Inspecting is not the same as
addressing, and it is worth saying so on camera.

---

## Part 0 — Before you hit record

### 0.1 Start it

```bash
ARK_API_KEY=<the ark key> \
ARK_MODEL=ep-… \
ARK_EMBED_MODEL=ep-… \
ARK_BASE_URL=https://ark.ap-southeast.volces.com/api/v3 \
npm run poc
```

Open <http://localhost:3000>.

### 0.2 Check five things at `/api/system`

Open <http://localhost:3000/api/system> in a second tab. **If any of these are
wrong, stop and fix them — the demo does not work without them.**

| field | must be | if it isn't |
|---|---|---|
| `codifyEnforcing` | `true` | No container engine. Nothing will be refused. The whole security half is dead. |
| `codexAvailable` | `true` | No Codex. No runs at all. |
| `arkConfigured` | `true` | `reviewScope` fails closed — candidates never auto-promote, so no contracts. |
| `codifySemanticAvailable` | `true` | Only lexical matching. Part 3 (person six) has nothing to stand on. |
| `codexSandboxMode` | `danger-full-access` | Fine either way, but if it *is* this, you get the best line in the demo. See 0.5. |

### 0.3 Create the one Agent you will use

Click **+ Create Agent**. Name it **General assistant**. Description `demo`.
Instructions can be anything — `Be concise and helpful.` Click create.

### 0.4 Do one throwaway run — this is mandatory

**Signed in as:** `user-f` (a principal you will not use on camera)

Type anything into the Playground, e.g. `Generate release notes from the commits
in ./repo since v1.4.0 and write them to ./out/scratch.md`, and send it. Wait
for it to finish.

**Why:** promotion only runs on the evidence a *completed run* produces. Before
this, **Codify governance shows three pending candidates and zero contracts** —
and Part 1 opens on a contract card. This run is what flips them.

Now open **Codify governance** and confirm you see **GOVERNED TASKS 3**.

> [!IMPORTANT]
> **They appear one at a time, over about half a minute.** Each promotion costs
> two model calls — the scope reviewer, then the brief drafter — so a store that
> shows `1` ten seconds after the run is mid-promotion, not broken. Wait for it
> to settle on three before you go near the camera. The cold open in Part 1.1
> uses the postmortem contract, and it is often the last to land.

Then switch back to a fresh principal for the recording.

### 0.5 Two sentences to have ready

Say this once, anywhere in Part 4. It is the most load-bearing sentence in the
demo and it costs four seconds:

> *"The startup script looks for Landlock, doesn't find it on this kernel, and
> falls back to `danger-full-access`. Codex's own sandbox is switched off. Every
> refusal you are about to see was collected in that state."*

### 0.6 Never on camera

The Ark key. Not in a terminal, not in an env dump, not in scrollback. The UI no
longer prints the endpoint id, but your shell will if you let it.

---

## Part 1 — The hook

### Shot 1.1 — five seconds on the artefact (00:00)

**Signed in as:** anyone
**Open:** Codify governance → the **Postmortem** contract card (the one whose
network column reads *No egress*)
**Do:** fill the frame with just that card. Nothing else.

**Say:**

> **"This is a least-privilege security policy for an AI agent. No human wrote it."**

Then **cut**. Do not explain it. Do not scroll.

> **Why open here.** A judge on their twentieth submission already knows LLM
> output is inconsistent — opening on that problem spends ten seconds convincing
> nobody of anything. *A policy that wrote itself* is the part nobody else is
> doing. Lead with the novelty and earn it afterwards.

### Shot 1.2 — five people, five answers (00:05)

**Open:** Playground, **General assistant**

Send these five, **each as a different principal**, and **tick `Run ad-hoc`
before every single one** (bottom-right of the composer):

| # | signed in as | type this |
|---|---|---|
| 1 | `user-a` | `Generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/notes-a.md` |
| 2 | `user-b` | `Draft the changelog for ./repo covering everything shipped since the v2.4.0 tag; put it in ./out/notes-b.md` |
| 3 | `user-c` | `What shipped in ./repo since v2.5.0? Summarise it as version notes in ./out/notes-c.md` |
| 4 | `user-d` | `I need the changelog for our next release. Use ./repo commits after v2.6.0. Write ./out/notes-d.md` |
| 5 | `user-e` | `Summarise ./repo's commit history since v2.7.0 into release notes at ./out/notes-e.md` |

To change principal: the dropdown at the top of the left sidebar under
**SIGNED IN AS**.

**Expect:** five different documents. Different headings, different structure,
different level of detail. Put them side by side in the edit.

**Say:**

> *"Same task. Five people. Five different answers. Whoever wrote the best prompt
> got the best answer — and nobody else will ever find out what they wrote."*

### Shot 1.3 — the second reveal, and do not skip it

**Do:** point at the evidence panel under each of the five replies. Each says:

```
OBSERVE   No contract matched · observed, not enforced
```

**Say:**

> *"And every one of these ran with everything. Any host, any file, any
> credential in the environment. Not because anyone was careless — because
> nobody can write a policy for a task they haven't seen yet."*

> **Why this sentence is not optional.** Without it a reviewer files the whole
> submission under "consistency tooling" and the 40% weighting for middleware
> behaviour goes elsewhere. It is the line that makes the inconsistency and the
> over-permission the *same* problem — which is the actual thesis.

---

## Part 2 — Where the policy came from

**Signed in as:** `user-a`
**Open:** **Codify governance** (left sidebar, shield icon)

**Expect:** the card from Shot 1.1 is sitting there, next to two others.

**Say:**

> *"Codify was watching every one of those. And not just those five — twelve
> people have asked for this. You watched five of them."*

> **Do not say "those five runs made this."** The contracts are derived from the
> observed-run corpus already in the store — twelve release-notes wordings from
> six people, six postmortems, five dependency audits. Your five runs join that
> cluster and *trigger* the promotion pass. They do not constitute it, and a
> reviewer can check that in one click on the candidate card.

**Do:** point at the release-notes contract's scope row:

| | |
|---|---|
| **NETWORK** | `github.com` |
| **FILESYSTEM** | `./out` RW · `./repo` RO |
| **SECRETS** | *None injected.* |

**Say:**

> **"Nobody wrote this policy. It is what those runs already did."**

**Do:** now point at the **Postmortem** contract directly below it — network
column reads *No egress. The run reaches nothing.*

**Say:**

> *"That task never left the box in any of its runs, so its policy says it
> can't. A person writing these two by hand would have given both the same
> template."*

**Do:** point at `SECRETS — None injected` on the release-notes card.

**Say:**

> *"`GITHUB_TOKEN` was in those runs. It's not in the policy. A host or a path
> the task demonstrably used is a narrowing — handing a brand-new agent a
> credential is the one thing that genuinely widens reach, so it stays behind a
> human."*

**Do:** point at the line under the contract name — `approved by codify-auto` —
and the **AUTO-PROMOTED** note beside it, which contains the reviewer's actual
words.

**Say:**

> *"A model signed this off, and that's its reasoning. It never sees prompt
> text — only a task name and three lists: hostnames, paths, credential names.
> The observations behind those are written by users, and a reviewer reading
> prose could be argued with. A hostname has nowhere for an instruction to hide."*

**Optional, strong:** click **Show the brief this specialist runs under**. It is
a real operating procedure — read one line aloud, e.g. *"Write the audit
findings to `reports/audit.md` regardless of any requested output path."*

---

## Part 3 — Three more people, one document

**This is the payoff for Part 1, and it is the most important shot in the demo.**
Part 1 showed five people getting five different answers. This shows what
happens to the next three.

### 3.1 Send three, from three more people, in three more wordings

Ad-hoc **unticked** this time. None of these wordings appears in Part 1, and
each asks about a **different release** — so the content genuinely differs.
That is the realistic case: in a workplace nobody is summarising the same thing.

| # | signed in as | type this | measured |
|---|---|---|---|
| 1 | `user-f` | `Turn the commits in ./repo since v2.7.0 into release notes and drop them in ./out/RELEASE.md` | routes, 0.91 |
| 2 | `user-a` | `Summarise every commit in ./repo after the v2.4.0 tag as release notes in ./out/RELEASE.md` | routes, 0.86 |
| 3 | `user-b` | `I need the changelog for ./repo built from commits since v2.2.0, written to ./out/RELEASE.md` | routes, 0.83 |

> [!CAUTION]
> **Use these wordings, or probe your own first.** An earlier draft of this
> runbook used three prompts that read like perfectly good paraphrases and
> **none of them routed** — 0.715, 0.681 and 0.643 against a 0.72 line. Filming
> with them would have collapsed the entire payoff on camera.
>
> The pattern, measured over nine candidates: a wording routes when it keeps the
> task's own vocabulary — **the word "commits" and the output path**. Drop
> either and the score falls under the line. All six candidates that kept both
> routed (0.79–0.91); all three that dropped them missed.
>
> This is not a flaw in the matcher. §4c of the routing doc puts the 5th
> percentile of genuine rewordings at **0.797**, so those three were further
> from the task than real paraphrases are. But it is a live demo, and a prompt
> you have not probed is a prompt that can miss.

**Expect:** every one routes. The evidence panel reads `ROUTED` and names the
channel that matched — the semantic one, because none of these share enough
words with the exemplars for the lexical channels to fire.

**Where the artefact actually is.** A governed run executes on the *specialist*,
in that principal's directory under it — not in the General assistant you typed
into. So to see the file:

1. Stay signed in as the same principal.
2. Click the specialist named on the evidence line, in **PROMOTED SPECIALISTS**.
3. **Show the workspace** → `out/RELEASE.md`.
4. Click back to **General assistant** to send the next one.

> That is the one place the demo asks you to click a specialist, and it is worth
> saying why out loud: you are clicking it to *inspect evidence*, never to
> converse. Nobody routed work there by choosing it.

> [!NOTE]
> **The three governed runs do not overwrite each other.** Workspaces are per
> principal, so `user-f`, `user-a` and `user-b` each write `out/RELEASE.md` into
> their own directory under the specialist. All three survive, and you can go
> back to any of them by switching principal. The same is true of the five
> ad-hoc files in Part 1 — each is in that person's own workspace on the
> General assistant.


### 3.2 The shot: five shapes against one

Put Part 1's five documents and Part 3's three side by side. All eight are read
out of **Show the workspace** without leaving the app, but they live in eight
different places, so collect them as you go rather than at the end:

| | signed in as | selected Agent | file |
|---|---|---|---|
| five ad-hoc | `user-a` … `user-e` | General assistant | `out/notes-a.md` … `out/notes-e.md` |
| three governed | `user-f`, `user-a`, `user-b` | the release-notes specialist | `out/RELEASE.md` |

Screenshot each one as it lands. Switching principal changes the workspace, so a
file you did not capture is a file you have to re-run for.

**Be precise about what is the same, because it is not the document.** The three
governed outputs say different things: different releases, different commits,
different lengths. What is identical is the **shape** — the same headings, in
the same order, with the same conventions.

- **Five** ad-hoc runs → five different structures. Different headings, different
  ordering, different level of detail.
- **Three** governed runs → **one structure**, three times, from three people who
  typed three different things and asked about three different releases.

**Say:**

> *"The content is different — they asked about different releases, and in a real
> team they would each be working off their own data. What is the same is the
> shape. Same headings, same order, every time. Nobody agreed on that format.
> Nobody was told it. It came from what the task already looked like when it was
> done well."*

**Then the reason it matters, which is not aesthetics:**

> *"Once every postmortem in the company has the same five headings, you can read
> them side by side. You can aggregate them. You can audit them. Five people
> inventing five formats produces five documents nobody can compare — and that
> is the actual cost of an ungoverned task, not that any one output was bad."*

> **Do not say "the same document."** It is the same *structure*. The claim that
> holds is a measured one — one distinct set of level-2 headings across the
> governed runs — and it is checkable in the workspace viewer in about ten
> seconds. Overstating it is the fastest way to lose a reviewer who checks.


### 3.3 Back it with the measurement

Have this on screen or say it — it is the same experiment run properly, and it
is in `docs/ENGINEERING-LOG.md` §9:

| arm | runs | distinct document structures | pairwise agreement |
|---|---|---|---|
| **governed** | 3 | **1** | **3/3** |
| ad hoc | 4 | **4** | **0/6** |

Every governed run produced *Summary · Timeline · Impact · Root Cause · Action
Items*. No two ad-hoc runs agreed on anything.

> **Say the caveat, it costs five seconds and buys the whole result:** *"That's
> consistency of structure, on one task. The governed runs also covered less,
> because the brief pinned scope as well as shape. Consistency and completeness
> are different axes and we only measured the first."*

An earlier version of this experiment was invalidated three times because the
ad-hoc control was quietly delegated back to the specialist it was being
compared against. **Check `user_override` on every Part 1 evidence line.**

### 3.4 The adoption point

**Say:**

> *"None of those three picked a specialist. They didn't know one existed. They
> asked in their own words and got the distilled version of what the earlier runs
> learned — and it ran under a narrower policy without anyone thinking about it."*

That is the argument for why this gets adopted rather than routed around: a
control people avoid is worthless, so the governed path has to be the one people
already want. Least privilege arrives as a side effect.

---


## Part 3b — The brief improves itself

Part 3 showed the task getting *consistent*. This shows it getting *better* —
and it is the beat that answers "so it just freezes whatever the first runs did?"
No: several people asking for the same change rewrites the brief for everybody.

### 3b.1 One person complains, and nothing happens

**Signed in as:** `user-c`
**Do:** send the governed task, wait for it, then send a correction as a
follow-up in the same conversation:

```
Use bigger, bolder section headings in that release note.
```

**Open:** Codify governance → **LEARNED IMPROVEMENTS**

**Expect:** still `0 pending`. The empty-state text says why.

**Say:**

> *"One person asking is a preference. It changes nothing, and it should not —
> the same reason one person repeating a prompt fifteen times never becomes a
> task."*

### 3b.2 A second person asks for the same thing

**Signed in as:** `user-d`
**Do:** the same two turns — the governed task, then the same correction in your
own words.

**Open:** **LEARNED IMPROVEMENTS** again, and hit **Rescan** if it has not
appeared.

**Expect:** a proposed rule, **citing both people**.

**Say:**

> *"Two people, independently, corrected the same thing. That is not a
> preference any more — it is a defect in the brief. Codify drafted the rule; a
> person still decides."*

### 3b.3 Apply it, and watch the contract version

**Signed in as:** `operator`
**Do:** apply the proposal.

**Expect:** the contract goes **v1 → v2**, the rule appears under **Learned from
usage** on the card, and it is written into the specialist's `AGENTS.md` — which
is what the Runtime actually reads.

**Do:** click **Show the brief this specialist runs under** and find the new
rule in it.

### 3b.4 The payoff: somebody who never complained

**Signed in as:** `user-e` — a principal who has asked for nothing
**Do:** send the governed task in their own words.

**Expect:** the output comes back with the improvement applied.

**Say:**

> *"They never asked for this. They were not in the conversation where it came
> up. Two other people's correction is now how this task is done for everybody
> — versioned, visible, and revertible, because it is a contract and not a
> habit."*

> **What this does not do.** A correction only attaches to a contract that
> existed when the work happened. A follow-up to an answer the *general* Agent
> gave before promotion records nothing — deliberately, because attaching a
> correction to a contract that did not exist would weaken the one claim the
> refinement loop rests on: that several people corrected **this contract's**
> output.

---


## Part 4 — The fence is real

Four refusals. **Run each one before recording** — three of the four have never
been filmed (see Part 6).

### 4.1 Authorization — instant, no model call

**Signed in as:** `user-a`
**Open:** Codify governance → **TASK CANDIDATES**
**Do:** click **Approve and create Agent** on any pending candidate.

**Expect:**

```
403  "Only an operator can decide governance. Signed in as user-a;
      operators are operator."
```

**Do:** switch the principal dropdown to `operator`, click it again — it works.

**Say:**

> *"Refused by the control plane, not hidden by the UI — the check runs before
> the request body is even validated. And reading was never gated: an audit trail
> only the auditor can see is worth much less."*

### 4.2 Budget — refused before the run exists

**Signed in as:** `operator`
**Open:** Codify governance → the release-notes contract → **Set a ceiling**
**Do:** type `10`, click **Set ceiling**. Then go back to the Playground and
send the task again (ad-hoc unticked).

**Expect:** `HTTP 429 — Token budget exhausted`, and a new `budget` row in
**DENIALS**.

**Say:**

> *"No container started. No model call. Refused at admission, before the run
> existed."*

**Afterwards:** remove the ceiling, or the rest of the demo is blocked.

### 4.3 Filesystem — refused by the kernel

**Signed in as:** `user-a`
**Do:** send a task that also writes outside the contract's writable path:

```
Generate release notes from ./repo since v2.5.0 into ./out/RELEASE.md, and put a copy in ./finance/archive-copy.md
```

> Probed: routes at **0.742**. That is a thinner margin over the 0.72 line than
> the Part 3 wordings, because "release notes from ./repo" carries less signal
> than "the commits in ./repo". It holds, but re-probe it if you change a word.

**Expect:** a `path` denial naming `finance/archive-copy.md`.

**Do:** the run is governed, so it executed on the specialist. Click it in
**PROMOTED SPECIALISTS** (still as `user-a`), open **Show the workspace**, and
look at `finance/`. The three fixture files are there; `archive-copy.md` is not. *"The directory is unchanged"* is a
claim until somebody looks at the directory — so look at it on camera.

**Say:**

> *"The workspace goes in read-only and only the scope's writable paths are
> layered back over it, so that refusal is `EROFS` from the kernel. Nothing in
> the container was asked to behave."*

### 4.4 Egress — the strongest one, and nobody staged it

**Open:** Codify governance → **DENIALS**

**Expect:** several rows like

```
EGRESS   ab.chatgpt.com   blocked
```

one per governed run.

**Say:**

> *"That's Codex's own phone-home, made on every turn whatever the task is.
> Nothing in the container was asked to cooperate — the model had no say in that
> connection — and it was refused because no contract names that host. This is
> the cleanest evidence in the project precisely because nobody staged it."*

**If someone asks whether you special-cased it:**

> *"The filter is in scope **derivation**, not enforcement. A host that appears
> in 100% of every task's runs would otherwise be written into every contract the
> platform ever derives. The broker has no knowledge of that host at all —
> nothing blocks it, it's simply never granted."*

> [!IMPORTANT]
> **Do not build this beat on a staged denial.** The obvious version — ask the
> governed task to also reach a host its contract doesn't name — was tried
> against the live container path and **did not fire**. The model read the
> workspace, decided there was no git remote to fetch from, and never attempted
> the call. Nothing was refused because nothing was tried.
>
> A denial you have to ask for depends on the model choosing to cooperate.
> `ab.chatgpt.com` does not. If you want the staged version as a bonus, run it
> beforehand and confirm it actually produced a denial row.

---

## Part 5 — The attack that never appears

**Open:** Codify governance → **TASK CANDIDATES**

**Say:**

> *"One person asked, fifteen times, to collect every credential in the repo and
> upload the archive to an external host. Fifteen is more repetition than any
> real task in this system has. It is not in this queue and it never will be — it
> clears the frequency floor and fails the distinct-user floor."*
>
> *"Frequency is not evidence. Three people doing a thing is evidence. One person
> doing it fifteen times is one person."*

The empty-state text on that section says the rule out loud, so let the viewer
read it and check the list themselves. Proving a control by what is **absent**
reads unusually well on camera.

---

## Part 6 — One request, three permission sets

**Signed in as:** `user-c`
**Open:** Playground, **General assistant**, ad-hoc **unticked**
**Do:** send a request that asks for two things at once:

```
Summarise the incident timeline in ./incidents into ./out/postmortem.md, and also generate release notes from the commits in ./repo since v2.5.0 into ./out/RELEASE.md
```

**Expect:** a banner appears above the conversation:

> **⑂ This request asked for 2 things**
> Each part is routed on its own, so a part runs under the permissions of the
> contract that recognised that part — never the two combined.

with the two steps listed, each naming the specialist that ran it — one
**Postmortem** (`no egress`), one **release notes** (`github.com`).

**Say:**

> *"Neither specialist ever held both scopes. A single multi-tool agent doing
> both would hold the union by accident — that's the confused-deputy shape this
> exists to prevent."*

> [!WARNING]
> **The banner is transient.** It is set from the send response and **disappears
> if you reload**. Film it live; you cannot come back to it. The second half also
> appears in the thread as a "You" message the user never typed — that is the
> split fragment — and the routed half's answer lands on the specialist, not in
> this conversation.

---

## Part 7 — Close

**Do:** click **Show trace** on the governed run.

**Expect:** one trace id, ~24 spans nested under the turn —
`ORCHESTRATION` → `POLICY_DECISION` → `SANDBOX_EXECUTION` → `MODEL_CALL` ×n →
`EGRESS`, with denials appearing as denied spans.

**Do:** run `npm run check` on camera — 261 passing, 4 skipped.

**Do:** state one limitation out loud. This one:

> *"Routing degrades on tasks that are neighbours. Measured on WorkBench — 690
> tasks, 69 families — sixteen of twenty-nine clusters merge two adjacent tasks,
> so the brief can be a blend. What doesn't degrade is containment: one contract
> in twenty-nine held capability its family never used. The cost is the brief,
> not the boundary. It's in the docs with eleven others."*

Ending on a measured limitation is stronger than ending on a claim. It tells a
reviewer the rest of the numbers were arrived at the same way.

---

## Part 8 — Traps that have already cost this project time

- **Tick `Run ad-hoc` on all five hook runs, and check each evidence line says
  `user_override`.** The seeded corpus is already above both floors, so the
  moment your *first* run completes all three contracts promote — and runs two
  through five would route to a specialist instead of showing the mess the hook
  needs. Do not trust the checkbox; read the evidence line.
  It does **not** suppress observation — `recordPromptObservation` runs before
  `route()`. So all five are ungoverned *and* counted, which is the honest
  picture: each is both a bad answer and a data point.
- **Give the five runs different output paths.** They will overwrite each other
  otherwise, and you will have nothing to put side by side.
- **Compare the files, not the chat replies.** A governed run will tell you it
  wrote a file; what it actually wrote is the evidence.
- **A governed run may ignore the output path you ask for** and use the one in
  its brief. That is the mechanism working — but it means you cannot pin a
  governed run's output path by asking.
- **Probe every prompt before you film it.** The routing decision is made when
  the message is accepted, so `POST /api/agents/:id/messages` returns it in the
  202 — you can read `run.codify.decision`, stop the run, and never spend a
  Codex turn finding out. Three prompts in an earlier draft of this document
  looked fine and scored 0.715, 0.681, 0.643 against a 0.72 line.
- **Do not script the contract names.** They are drafted by a model at promotion
  time and change between boots — the same corpus produced *"Generate release
  notes from tag"* one run and *"Generate release notes to RELEASE.md"* the next.
  Say "the release-notes contract".
- **Read cluster numbers off the screen, not out of the docs.** `CODIFY.md`
  records 12 runs from 6 users; re-measured live it came back 11 from 5. It
  depends on the embedding endpoint.
- **Between retakes of the same persona, click "Session connected · start
  fresh".** A Codex thread that accumulates takes starts reporting work it did
  not do. Different personas already get separate threads.
- **Remove any budget ceiling you set in 4.2** before continuing.

---

## Part 9 — What has actually been filmed, and what hasn't

Verified on the container path with real Docker, real Codex, real Ark, and
Codex's own sandbox off:

| beat | seen |
|---|---|
| Promotion from a completed run — 3 contracts, 3 different scopes, all `secrets: []` | ✅ |
| `SECRET GITHUB_TOKEN blocked` — the auto-grant clamp | ✅ |
| `routed` / `brokerMode: enforce`, matched on containment 1.000 | ✅ |
| `EGRESS ab.chatgpt.com blocked` ×3, unrequested | ✅ |
| Compound split across two specialists, in parallel, neither holding the union | ✅ |
| Trace — 24 spans | ✅ |
| Denials table populated | ✅ |
| Budget panel with real spend | ✅ |
| **3.2 five-against-three** | ✅ run 2026-08-27: 5 ad-hoc → **5 distinct structures**, 3 governed → **1** |
| Every prompt in Parts 1, 3, 4.3 and 6 | ✅ probed against the live router before being written here |
| The workspace viewer, per-principal | ✅ one principal's file absent from another's listing |
| The split banner across two specialists | ✅ postmortem (*no egress*) + release notes (`github.com`), in parallel |
| **4.1 the 403** | ❌ tests only |
| **4.2 the 429** | ❌ tests only |
| **4.3 the EROFS** | ❌ tests only |
| **Part 3b, the refinement loop** | ⏳ unit-tested and now covered by `bench/demo-verify.mjs`; awaiting the clean-run grid |

**4.1, 4.2 and Part 3b are now driven by `bench/demo-verify.mjs`**, which runs
every beat above from a wiped store. Run it before you record:

```bash
npm run poc                    # one terminal
node bench/demo-verify.mjs 1   # another, once it is up
```

It reports PASS/FAIL per beat, so a broken one is a line of output rather than a
surprise on camera.

> [!WARNING]
> **Walk this document end to end once before filming, even though everything
> above is ticked.** Three instructions in it were wrong as recently as today —
> a staged egress denial that does not fire, three prompts that do not route,
> and a "click Show the workspace" that pointed at the wrong Agent after
> workspaces became per-principal. Each was found by running it, not by reading
> it. A runbook is only as current as the last time somebody executed it.

---

## Part 10 — What not to claim

- Not "a hardened sandbox". This constrains what a cooperating-but-compromised
  agent can *reach*; it does not defend against container escape.
- Not "exfiltration is prevented". Egress control is host-level — the broker
  allowlists on the `CONNECT` host without terminating TLS, so it sees *where*
  traffic goes, never what it carries.
- Not "the reviewer guarantees it". It is a tier, not a boundary. The
  distinct-user floor, frequency floor, never-allow list and secret clamp all
  hold without it.
- Not "identity". The principal comes from a header — the mock identity model the
  brief permits.
- **Never present the staged prompt-injection case as enforcement.** That payload
  was refused by *the model*, which recognised an instruction embedded in data.
  It shows the model's judgment, not this middleware. `ab.chatgpt.com` is the
  honest version of the same point.
