/**
 * The claim the demo rests on, actually run.
 *
 *   npm run poc                       # in one terminal, with real Ark credentials
 *   npm run bench:consistency         # in another, once contracts exist
 *
 * It drives the live platform over HTTP rather than the service in-process,
 * because what is being measured is what a person would see: eight real Codex
 * turns, and the files they leave behind.
 *
 * Five ad-hoc turns from five people, then three governed turns from three
 * more. Capture the file each produced — not the chat message about it — and
 * compare the set of level-2 headings, which is the metric the engineering log
 * uses.
 */
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.argv[2] ?? "./consistency-out";
await mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options = {}, user = "user-a") {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { "content-type": "application/json", "x-codify-user": user, ...(options.headers ?? {}) },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

const agents = (await api("/api/agents")).agents ?? [];
const general = agents.find((a) => a.name === "General assistant") ?? agents[0];
console.log("agent:", general.name, general.id);

async function turn(user, content, forceAdHoc) {
  const sent = await api(
    "/api/agents/" + general.id + "/messages",
    { method: "POST", body: JSON.stringify({ content, forceAdHoc }) },
    user,
  );
  const run = sent.run;
  if (!run) return { error: JSON.stringify(sent).slice(0, 200) };
  for (let i = 0; i < 60; i += 1) {
    await sleep(6000);
    const state = (await api("/api/runs/" + run.id)).run;
    if (state && state.status !== "queued" && state.status !== "running") {
      return { run: state, decision: state.codify?.decision, agentId: state.agentId };
    }
  }
  return { error: "timed out" };
}

async function readFile(agentId, file) {
  const r = await api("/api/agents/" + agentId + "/workspace/file?path=" + encodeURIComponent(file));
  return r.content ?? null;
}

/** The metric: level-2 headings, normalised. */
const headings = (text) =>
  (text ?? "")
    .split("\n")
    .filter((l) => /^##\s+/.test(l) && !/^###/.test(l))
    .map((l) => l.replace(/^##\s+/, "").replace(/[^a-z0-9 ]/gi, "").trim().toLowerCase())
    .filter(Boolean);

const AD_HOC = [
  ["user-a", "Generate release notes from the commits in ./repo since v1.4.0 and write them to ./out/adhoc-a.md", "out/adhoc-a.md"],
  ["user-b", "Draft the changelog for ./repo covering everything shipped since the v2.4.0 tag; put it in ./out/adhoc-b.md", "out/adhoc-b.md"],
  ["user-c", "What shipped in ./repo since v2.5.0? Summarise it as version notes in ./out/adhoc-c.md", "out/adhoc-c.md"],
  ["user-d", "I need the changelog for our next release. Use ./repo commits after v2.6.0. Write ./out/adhoc-d.md", "out/adhoc-d.md"],
  ["user-e", "Summarise ./repo's commit history since v2.7.0 into release notes at ./out/adhoc-e.md", "out/adhoc-e.md"],
];

const GOVERNED = [
  ["user-f", "Turn the commits in ./repo since v2.7.0 into release notes and drop them in ./out/RELEASE.md"],
  ["user-a", "Summarise every commit in ./repo after the v2.4.0 tag as release notes in ./out/RELEASE.md"],
  ["user-b", "I need the changelog for ./repo built from commits since v2.2.0, written to ./out/RELEASE.md"],
];

const results = { adhoc: [], governed: [] };

console.log("\n=== AD HOC (forceAdHoc: true) ===");
for (const [user, prompt, file] of AD_HOC) {
  const t = await turn(user, prompt, true);
  if (t.error) { console.log(user, "ERROR", t.error); continue; }
  const content = await readFile(t.agentId, file);
  const h = headings(content);
  results.adhoc.push({ user, file, decision: t.decision, headings: h, content });
  await writeFile(OUT + "/adhoc-" + user + ".md", content ?? "(no file)", "utf8");
  console.log(user, "|", t.decision, "|", h.length, "headings:", h.join(" / ").slice(0, 90));
}

console.log("\n=== GOVERNED (routed) ===");
for (const [user, prompt] of GOVERNED) {
  const t = await turn(user, prompt, false);
  if (t.error) { console.log(user, "ERROR", t.error); continue; }
  // A governed run writes to the path in its brief, on the specialist's
  // workspace - so list that workspace and take the newest markdown in ./out.
  const listing = await api("/api/agents/" + t.agentId + "/workspace");
  const candidates = (listing.files ?? [])
    .filter((f) => f.path.startsWith("out/") && f.path.endsWith(".md"))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const file = candidates[0]?.path;
  const content = file ? await readFile(t.agentId, file) : null;
  const h = headings(content);
  results.governed.push({ user, file, decision: t.decision, headings: h, content });
  await writeFile(OUT + "/governed-" + user + ".md", content ?? "(no file)", "utf8");
  console.log(user, "|", t.decision, "|", file, "|", h.length, "headings:", h.join(" / ").slice(0, 90));
}

const distinct = (rows) => new Set(rows.map((r) => JSON.stringify(r.headings))).size;
console.log("\n=== RESULT ===");
console.log("ad hoc   : " + results.adhoc.length + " runs, " + distinct(results.adhoc) + " distinct structures");
console.log("governed : " + results.governed.length + " runs, " + distinct(results.governed) + " distinct structures");
await writeFile(OUT + "/summary.json", JSON.stringify(results, null, 2), "utf8");
console.log("files written to", OUT);
