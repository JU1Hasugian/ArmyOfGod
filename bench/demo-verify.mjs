/**
 * Every beat of the demo, from an empty store, as many times as you ask.
 *
 *   npm run poc                      # one terminal, real Ark credentials
 *   node bench/demo-verify.mjs 5     # another, once it is up
 *
 * The reproducibility question this answers is not "does it work" but "does it
 * work again". Each iteration wipes the store, lets the platform re-seed, and
 * drives the runbook over HTTP exactly as a person would: promotion, routing,
 * the five-against-three consistency shot, and every refusal.
 *
 * Beats that need no model call are checked first, because a failure there is
 * a bug rather than a bad afternoon on the endpoint.
 */
const BASE = process.env.BASE ?? "http://localhost:3000";
const ITERATIONS = Number(process.argv[2] ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options = {}, user = "user-a") {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "content-type": "application/json", "x-codify-user": user, ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

const headings = (text) =>
  (text ?? "").split("\n")
    .filter((l) => /^##\s+/.test(l) && !/^###/.test(l))
    .map((l) => l.replace(/^##\s+/, "").replace(/[^a-z0-9 ]/gi, "").trim().toLowerCase())
    .filter(Boolean);

async function waitReady(agentId) {
  for (let i = 0; i < 120; i += 1) {
    const { body } = await api("/api/agents/" + agentId);
    if (body.agent?.status !== "busy") return;
    await sleep(2000);
  }
}

async function turn(agentId, user, content, forceAdHoc) {
  await waitReady(agentId);
  const { body } = await api(
    "/api/agents/" + agentId + "/messages",
    { method: "POST", body: JSON.stringify({ content, forceAdHoc }) },
    user,
  );
  if (!body.run) return { error: JSON.stringify(body).slice(0, 160) };
  const decision = body.run.codify?.decision;
  for (let i = 0; i < 90; i += 1) {
    await sleep(5000);
    const { body: state } = await api("/api/runs/" + body.run.id);
    const run = state.run;
    if (run && run.status !== "queued" && run.status !== "running") {
      return { run, decision, agentId: run.agentId };
    }
  }
  return { error: "timed out", decision };
}

const readFile = async (agentId, file, user) =>
  (await api("/api/agents/" + agentId + "/workspace/file?path=" + encodeURIComponent(file), {}, user))
    .body.content ?? null;

const AD_HOC = [
  ["user-a", "Generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/notes-a.md", "out/notes-a.md"],
  ["user-b", "Draft the changelog for ./repo covering everything shipped since the v2.4.0 tag; put it in ./out/notes-b.md", "out/notes-b.md"],
  ["user-c", "What shipped in ./repo since v2.5.0? Summarise it as version notes in ./out/notes-c.md", "out/notes-c.md"],
  ["user-d", "I need the changelog for our next release. Use ./repo commits after v2.6.0. Write ./out/notes-d.md", "out/notes-d.md"],
  ["user-e", "Summarise ./repo's commit history since v2.7.0 into release notes at ./out/notes-e.md", "out/notes-e.md"],
];

const GOVERNED = [
  ["user-f", "Turn the commits in ./repo since v2.7.0 into release notes and drop them in ./out/RELEASE.md"],
  ["user-a", "Summarise every commit in ./repo after the v2.4.0 tag as release notes in ./out/RELEASE.md"],
  ["user-b", "I need the changelog for ./repo built from commits since v2.2.0, written to ./out/RELEASE.md"],
];

async function iteration(n) {
  const beats = {};
  const mark = (name, ok, detail) => {
    beats[name] = { ok, detail };
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  const { body: sys } = await api("/api/system");
  if (!sys.codifyEnforcing || !sys.codexAvailable || !sys.arkConfigured) {
    mark("preflight", false, JSON.stringify(sys).slice(0, 120));
    return beats;
  }
  mark("preflight", true, `enforcing, codex, ark, semantic=${sys.codifySemanticAvailable}`);

  const { body: made } = await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({ name: "General assistant", description: "demo", instructions: "Be concise." }),
  });
  const general = made.agent.id;

  // Part 2 — promotion needs one completed run first.
  const seedRun = await turn(general, "user-z", "Generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/scratch.md", true);
  // Detection and promotion run on the evidence a finished run produces, which
  // happens *after* the run's status flips. Poll rather than check once.
  // Promotion is progressive, not atomic: each candidate costs its own model
  // call, so contracts appear one at a time over several seconds. Waiting for
  // the first is a race with the rest — wait for the count to stop moving.
  // Promotion is progressive, not atomic. Each candidate costs two model calls
  // — the scope reviewer and the brief drafter — so three contracts take
  // roughly half a minute to all appear, one at a time. Waiting for the first,
  // or for a short pause between them, both under-count.
  let contracts = [];
  let stable = 0;
  for (let i = 0; i < 60; i += 1) {
    const { body } = await api("/api/codify/contracts");
    const next = body.contracts ?? body ?? [];
    stable = next.length === contracts.length && next.length > 0 ? stable + 1 : 0;
    contracts = next;
    if (stable >= 6) break;   // 18s without a new one
    await sleep(3000);
  }
  mark("promotion: contracts exist", contracts.length >= 1, `${contracts.length} contracts after 1 run (${seedRun.error ?? seedRun.run?.status})`);
  const releaseContract = contracts.find((c) => /release|changelog/i.test(c.name));
  mark("promotion: a release-notes contract", Boolean(releaseContract), releaseContract?.name);
  mark("promotion: secrets clamped", contracts.every((c) => (c.scope?.secrets ?? []).length === 0), "every contract secrets=[]");
  mark("promotion: scopes differ", new Set(contracts.map((c) => JSON.stringify(c.scope?.domains ?? []))).size > 1,
    contracts.map((c) => JSON.stringify(c.scope?.domains)).join(" "));

  // Part 4.1 — authorization, no model call.
  const gated = contracts[0]
    ? await api(`/api/codify/contracts/${contracts[0].id}`,
        { method: "PATCH", body: JSON.stringify({ budget: { maxTotalTokens: 999999 } }) }, "user-a")
    : { status: 0 };
  const allowed = await api("/api/codify/contracts", {}, "user-a");
  mark("4.1 403 for a non-operator", gated.status === 403, "status " + gated.status + " on PATCH as user-a");
  mark("4.1 reads stay open", allowed.status === 200, "GET contracts as user-a = 200");

  // Part 1 — five ad-hoc, five structures.
  const adhoc = [];
  for (const [user, prompt, file] of AD_HOC) {
    const t = await turn(general, user, prompt, true);
    if (t.error) { adhoc.push({ user, headings: ["ERROR"] }); continue; }
    adhoc.push({ user, decision: t.decision, headings: headings(await readFile(t.agentId, file, user)) });
  }
  const adhocDistinct = new Set(adhoc.map((r) => JSON.stringify(r.headings))).size;
  mark("1. five ad-hoc are user_override", adhoc.every((r) => r.decision === "user_override"), adhoc.map((r) => r.decision).join(","));
  mark("1. five ad-hoc give distinct structures", adhocDistinct >= 4, `${adhocDistinct}/5 distinct`);

  // Part 3 — three governed, one structure.
  const governed = [];
  const governedRunIds = [];
  for (const [user, prompt] of GOVERNED) {
    const t = await turn(general, user, prompt, false);
    if (t.error) { governed.push({ user, decision: "ERROR", headings: ["ERROR"] }); continue; }
    governedRunIds.push(t.run.id);
    governed.push({ user, decision: t.decision, headings: headings(await readFile(t.agentId, "out/RELEASE.md", user)) });
  }
  const govDistinct = new Set(governed.map((r) => JSON.stringify(r.headings))).size;
  mark("3. three governed all route", governed.every((r) => r.decision === "routed"), governed.map((r) => r.decision).join(","));
  mark("3. three governed give ONE structure", govDistinct === 1,
    `${govDistinct} distinct — ${governed.map((r) => r.headings.join("/")).join("  |  ")}`);
  // The comparison that matters is against the ad-hoc arm, not against
  // perfection: 2-of-3 agreeing is still a different world from 5-of-5 differing.
  mark("3. governed converge more than ad-hoc", govDistinct < adhocDistinct,
    `governed ${govDistinct} vs ad-hoc ${adhocDistinct}`);

  // Part 4.4 — the unrequested egress denial.
  const { body: denials } = await api("/api/codify/denials");
  const rows = denials.denials ?? denials ?? [];
  mark("4.4 ab.chatgpt.com refused", rows.some((d) => d.kind === "egress" && d.target === "ab.chatgpt.com"),
    `${rows.filter((d) => d.target === "ab.chatgpt.com").length} egress denials`);

  // Part 4.3 — a write outside the writable scope.
  const eroded = await turn(general, "user-a",
    "Generate release notes from ./repo since v2.5.0 into ./out/RELEASE.md, and put a copy in ./finance/archive-copy.md", false);
  const { body: after } = await api("/api/codify/denials");
  const afterRows = after.denials ?? after ?? [];
  mark("4.3 path denial recorded", afterRows.some((d) => d.kind === "path"),
    afterRows.filter((d) => d.kind === "path").map((d) => d.target).join(",") || "none (model may not have tried)");
  if (eroded.agentId) {
    const listing = (await api("/api/agents/" + eroded.agentId + "/workspace", {}, "user-a")).body.files ?? [];
    // Specifically `finance/`. The agent, refused there, often writes the copy
    // into the path it *is* allowed — so matching "archive-copy" anywhere
    // reports a containment failure that is really the boundary working.
    const inFinance = listing.filter((f) => f.path.startsWith("finance/")).map((f) => f.path);
    mark("4.3 finance/ unchanged", !inFinance.some((f) => f.includes("archive-copy")),
      `finance/ holds ${inFinance.length} files: ${inFinance.join(", ")}`);
    const fallback = listing.find((f) => f.path.includes("archive-copy"));
    if (fallback) mark("4.3 refused write redirected into scope", true, "wrote " + fallback.path + " instead");
  }

  // Part 4.2 — budget refused at admission. Cap the contract the prompt
  // actually routes to, not the first one whose name looks right: several
  // release-notes contracts can coexist and only one of them wins the match.
  const routedId = (await api("/api/codify/runs/" + (governedRunIds[0] ?? "x"))).body?.decision?.contractId;
  const target = contracts.find((c) => c.id === routedId) ?? releaseContract;
  if (target) {
    await api(`/api/codify/contracts/${target.id}`, { method: "PATCH", body: JSON.stringify({ budget: { maxTotalTokens: 10 } }) }, "operator");
    await waitReady(general);
    const over = await api("/api/agents/" + general + "/messages",
      { method: "POST", body: JSON.stringify({ content: GOVERNED[0][1] }) }, "user-f");
    mark("4.2 429 at admission", over.status === 429, "status " + over.status);
    await api(`/api/codify/contracts/${target.id}`, { method: "PATCH", body: JSON.stringify({ budget: null }) }, "operator");
  }

  // Part 5b — learned improvements. Two people give the specialist the same
  // correction; one person asking is a preference and must be ignored.
  if (target) {
    const CORRECTION = "Use bigger, bolder section headings in that release note.";
    for (const user of ["user-c", "user-d"]) {
      await turn(general, user, GOVERNED[0][1], false);
      await turn(general, user, CORRECTION, false);
    }
    const { body: props } = await api("/api/codify/refinements/refresh", { method: "POST", body: "{}" }, "operator");
    const proposals = (props.refinements ?? props ?? []).filter((r) => r.status === "pending");
    mark("5b a correction from two people becomes a proposal", proposals.length > 0,
      proposals[0]?.proposedRule?.slice(0, 70) ?? "none raised");

    if (proposals[0]) {
      const before = (await api("/api/codify/contracts")).body.contracts ?? [];
      const applied = await api(`/api/codify/refinements/${proposals[0].id}/apply`, { method: "POST", body: "{}" }, "operator");
      const after = (await api("/api/codify/contracts")).body.contracts ?? [];
      const versioned = after.some((c) => c.version > 1 && c.refinements?.length > 0);
      mark("5b applying it versions the contract", applied.status === 200 && versioned,
        `v${before[0]?.version ?? "?"} -> ${after.find((c) => c.version > 1)?.version ?? "?"}`);
      mark("5b the rule is on the new version", after.some((c) => (c.refinements ?? []).length > 0),
        (after.find((c) => (c.refinements ?? []).length)?.refinements ?? []).join("; ").slice(0, 70));
    }
  }

  return beats;
}

const all = [];
for (let n = 1; n <= ITERATIONS; n += 1) {
  console.log(`\n══════ ITERATION ${n} of ${ITERATIONS} ══════`);
  try {
    all.push(await iteration(n));
  } catch (cause) {
    console.log("  ITERATION THREW:", cause instanceof Error ? cause.message : String(cause));
    all.push({});
  }
}

console.log("\n══════ SUMMARY ══════");
const names = [...new Set(all.flatMap((b) => Object.keys(b)))];
for (const name of names) {
  const passes = all.filter((b) => b[name]?.ok).length;
  console.log(`${passes}/${all.length}  ${name}`);
}
