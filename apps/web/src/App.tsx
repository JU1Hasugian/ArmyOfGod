import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken, setPrincipal } from "./api";
import Governance from "./Governance";
import type {
  Agent,
  AgentRun,
  CoordinationSession,
  MatchChannel,
  Message,
  RunTrace,
  SystemInfo,
  TaskContract,
} from "./types";

/** Mock principals, as the brief permits. Authorization is server-side. */
const PRINCIPALS = ["user-a", "user-b", "user-c", "user-d", "user-e", "user-f", "operator"];

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

/**
 * What Codify decided about one turn, and what the enforcement boundary did
 * about it. Rendered from data the server recorded, never inferred here.
 */
/**
 * Name the channel that carried the match.
 *
 * Worth the words on screen: "containment 1.00" on a prompt whose fingerprint
 * scored 0.36 is the platform saying it recognised a padded task, and that is
 * the difference between a governed run and an unenforced one.
 */
function channelLabel(channel: MatchChannel | undefined): string {
  if (channel === "containment") return "containment";
  if (channel === "semantic") return "semantic match";
  return "similarity";
}

/**
 * One Run's trace, fetched on demand.
 *
 * Behind a disclosure rather than always open: the trace is the thing you go
 * looking for when a Run did something surprising, and pre-fetching one per
 * message would put a request per Run on every render of the transcript.
 */
function RunTraceView({ runId }: { runId: string }) {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || trace || error) return;
    let cancelled = false;
    api
      .runTrace(runId)
      .then((result) => {
        if (!cancelled) setTrace(result.trace);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof ApiError ? cause.message : "Could not load the trace");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, runId, trace, error]);

  // The longest span sets the scale, so every bar is read against the same
  // baseline and the slow step is the wide one.
  const longest = trace
    ? Math.max(1, ...trace.spans.map((span) => span.durationMs ?? 0))
    : 1;

  return (
    <div className="trace">
      {/*
        Reopening retries. A trace is only queryable once the turn flushes its
        spans, so a panel opened while the Run is still going gets a 404 — and
        without clearing the error here that "no trace" verdict outlived the
        Run that went on to record six spans.
      */}
      <button
        className="trace-toggle"
        onClick={() =>
          setOpen((value) => {
            if (!value) setError(null);
            return !value;
          })
        }
      >
        {open ? "Hide trace" : "Show trace"}
        {trace ? " · " + trace.spanCount + " spans" : ""}
      </button>
      {open && error && (
        <p className="trace-empty">
          {error} The spans are written when the turn finishes — close and reopen to
          retry.
        </p>
      )}
      {open && !error && !trace && <p className="trace-empty">Loading…</p>}
      {open && trace && (
        <div className="trace-body">
          <div className="trace-meta">
            <code>{trace.traceId.slice(0, 8)}</code>
            <span>{trace.durationMs} ms</span>
            {trace.denied > 0 && <span className="trace-denied">{trace.denied} denied</span>}
          </div>
          <ol className="trace-spans">
            {trace.spans.map((span) => (
              <li key={span.id} className={"trace-span span-" + span.status}>
                <span
                  className="span-name"
                  style={{ paddingLeft: (span.parentId ? 14 : 0) + "px" }}
                >
                  {span.name}
                </span>
                <span className={"span-cat cat-" + span.category}>{span.category}</span>
                <span className="span-bar-cell">
                  <span
                    className="span-bar"
                    style={{
                      width: Math.max(2, ((span.durationMs ?? 0) / longest) * 100) + "%",
                    }}
                  />
                </span>
                <span className="span-ms">{span.durationMs ?? 0} ms</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/**
 * A request that asked for more than one thing, and what happened to each part.
 *
 * Worth showing rather than hiding: the person asked for two things in one
 * sentence, and the useful answer to "did it do both?" is a list of the parts
 * with the Agent each went to. It also makes the capability story legible —
 * every step names the contract that recognised it, and the parts nothing
 * recognised say so.
 */
function SplitBanner({
  session,
  onDismiss,
}: {
  session: CoordinationSession;
  onDismiss: () => void;
}) {
  const plan = session.plan ?? [];
  if (plan.length < 2) return null;
  const turnFor = (stepIndex: number) =>
    session.turns.find((turn) => turn.stepIndex === stepIndex);
  const parallel = plan.filter((step) => step.dependsOn.length === 0).length;

  return (
    <div className="split-banner" role="status">
      <span aria-hidden="true">⑂</span>
      <div className="split-body">
        <strong>This request asked for {plan.length} things</strong>
        <p>
          Each part is routed on its own, so a part runs under the permissions of the
          contract that recognised <em>that part</em> — never the two combined.
          {parallel > 1
            ? " " + parallel + " of them do not depend on each other, so they ran at the same time."
            : " Each part waits for the one it needs."}
        </p>
        <ol className="split-steps">
          {plan.map((step, index) => {
            const turn = turnFor(index);
            return (
              <li key={index} className={"split-step split-" + (turn?.status ?? "pending")}>
                <span className="split-text">{step.text}</span>
                <span className="split-where">
                  {turn ? (
                    <>
                      <strong>{turn.agentName}</strong>
                      {turn.contractName ? (
                        <em> · {turn.contractName}</em>
                      ) : (
                        <em> · no contract yet — observed for promotion</em>
                      )}
                    </>
                  ) : (
                    <em>waiting for step {step.dependsOn.map((entry) => entry + 1).join(", ")}</em>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
        {session.status !== "active" && session.stopReason && (
          <p className="split-stop">{session.stopReason}</p>
        )}
      </div>
      <button onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

function RunEvidence({ run, enforcing }: { run: AgentRun; enforcing: boolean }) {
  const codify = run.codify;
  if (!codify) return null;
  const label =
    codify.decision === "routed"
      ? "Governed by " +
        (codify.contractName ?? "a contract") +
        " v" +
        codify.contractVersion +
        (codify.score !== undefined
          ? " · " + channelLabel(codify.matchChannel) + " " + codify.score
          : "")
      : codify.decision === "principal_bound"
        ? "Scope bound to this specialist · " +
          (codify.contractName ?? "its contract") +
          " v" +
          codify.contractVersion +
          " · the prompt was not recognised, the permissions still apply"
        : codify.decision === "user_override"
          ? "Ad-hoc by explicit request · observed, not enforced"
          : "No contract matched · observed, not enforced";

  return (
    <aside className={"run-evidence evidence-" + codify.decision}>
      {codify.delegatedToAgentName && (
        <div className="evidence-handoff">
          Handed to <strong>{codify.delegatedToAgentName}</strong> — this task has been done
          before, so it ran on the Agent built for it. You stayed here.
        </div>
      )}
      <div className="evidence-row">
        {/*
          `brokerMode` is what the contract *asks* for. Whether anything
          enforces it depends on there being a container engine to put a broker
          in front of the run — without one the scope is derived, bound and
          displayed, but nothing refuses anything. Printing "enforce" there
          claims a guarantee the runtime is not providing.
        */}
        <span
          className={
            "badge badge-" + (codify.brokerMode === "enforce" && !enforcing
              ? "observe"
              : codify.brokerMode)
          }
        >
          {codify.brokerMode === "enforce" && !enforcing ? "not enforced" : codify.brokerMode}
        </span>
        <span>{label}</span>
      </div>
      {codify.brokerMode === "enforce" && !enforcing && (
        <div className="evidence-caveat">
          Scope derived and bound, but no container engine is available, so no broker sits
          in front of this run. Nothing was refused because nothing could be.
        </div>
      )}
      {codify.scope && (
        <div className="evidence-scope">
          <span>
            egress:{" "}
            {codify.scope.domains.length > 0 ? (
              codify.scope.domains.map((domain) => <code key={domain}>{domain}</code>)
            ) : (
              <em>none</em>
            )}
          </span>
          <span>
            writable:{" "}
            {codify.scope.paths.filter((entry) => entry.mode === "rw").length > 0 ? (
              codify.scope.paths
                .filter((entry) => entry.mode === "rw")
                .map((entry) => <code key={entry.path}>./{entry.path}</code>)
            ) : (
              <em>none</em>
            )}
          </span>
          {/*
            Labelled "reads", not "readable". The mount enforces the *write*
            set — the workspace goes in read-only and writable paths are layered
            back over it — so everything in the workspace is readable whatever
            this lists. These entries are the observed read set: evidence of
            what the task actually opens, which is what makes the derived write
            scope legible. Calling them "readable" implied a restriction the
            boundary does not apply.
          */}
          <span title="Observed reads. The whole workspace is readable; the mount enforces writes.">
            reads:{" "}
            {codify.scope.paths.filter((entry) => entry.mode === "ro").length > 0 ? (
              codify.scope.paths
                .filter((entry) => entry.mode === "ro")
                .map((entry) => <code key={entry.path}>./{entry.path}</code>)
            ) : (
              <em>nothing recorded</em>
            )}
          </span>
        </div>
      )}
      {codify.domainsReached.length > 0 && (
        <div className="evidence-scope">
          <span>
            reached: {codify.domainsReached.map((host) => <code key={host}>{host}</code>)}
          </span>
        </div>
      )}
      {codify.denials > 0 && (
        <div className="evidence-denial">
          <strong>{codify.denials} denied</strong> — blocked at the broker. The target was
          never contacted.
        </div>
      )}
      <RunTraceView runId={run.id} />
    </aside>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  // Active contracts, so the sidebar can tell a promoted specialist from an
  // Agent somebody made — and show the scope it was promoted with.
  const [contracts, setContracts] = useState<TaskContract[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  // Evidence belongs to a turn, not to the conversation. A thread can now hold
  // turns governed by different contracts, so "the latest run" cannot caption
  // all of them.
  const [runsById, setRunsById] = useState<Record<string, AgentRun>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"playground" | "governance">("playground");
  const [principal, setPrincipalState] = useState(PRINCIPALS[0] as string);
  const [forceAdHoc, setForceAdHoc] = useState(false);
  const [delegationNotice, setDelegationNotice] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [splitSession, setSplitSession] = useState<CoordinationSession | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  // An Agent is a specialist when an active contract names it. Derived from the
  // contract rather than from the description text, so the label cannot drift
  // away from what actually governs the Agent.
  const { ownAgents, specialists } = useMemo(() => {
    const byAgent = new Map(
      contracts
        .filter((contract) => contract.status === "active")
        .map((contract) => [contract.agentId, contract] as const),
    );
    return {
      ownAgents: agents.filter((agent) => !byAgent.has(agent.id)),
      specialists: agents
        .filter((agent) => byAgent.has(agent.id))
        .map((agent) => ({ agent, contract: byAgent.get(agent.id) as TaskContract })),
    };
  }, [agents, contracts]);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      api.system().then(setSystem),
      api
        .contracts()
        .then((result) => setContracts(result.contracts))
        .catch(() => {
          /* Governance is optional; the catalogue simply stays flat. */
        }),
    ]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  // `principal` is a dependency because the transcript is scoped to it
  // server-side: switching who you are signed in as must refetch, or the page
  // keeps showing the previous principal's conversation.
  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      setRunsById({});
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        setRunsById(Object.fromEntries(result.runs.map((entry) => [entry.id, entry])));
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId, principal]);

  // Whether you may decide governance depends on who you are signed in as, and
  // the backend is the authority on that — so re-ask it when the principal
  // changes rather than inferring it in the client.
  useEffect(() => {
    void api
      .system()
      .then(setSystem)
      .catch(() => {
        /* The banner already covers an unreachable control plane. */
      });
  }, [principal]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  /**
   * Follow a split request until every step has run.
   *
   * The steps execute on the server after the first one is dispatched, so the
   * only way the page learns a later step finished is to ask.
   */
  const pollSession = async (sessionId: string) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (!mountedRef.current) return;
      try {
        const { session } = await api.session(sessionId);
        setSplitSession((current) => (current?.id === sessionId ? session : current));
        if (session.status !== "active") {
          await refreshAgents();
          return;
        }
      } catch {
        return;
      }
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content, forceAdHoc);
      setSplitSession(result.session ?? null);
      if (result.session) {
        // The request was split, so it produced no run in *this* conversation:
        // each step runs on the Agent its own fragment matched. The request
        // itself still belongs here and is shown, but there is no run to follow
        // and this Agent is not the one that got busy — the banner tracks the
        // steps instead.
        if (selectedIdRef.current === selected.id) {
          setMessages((current) => [...current, result.message]);
        }
        void pollSession(result.session.id);
        await refreshAgents();
        return;
      }
      if (result.delegatedTo) {
        // The platform recognised the task and handed it to the specialist —
        // but the conversation stays where it was typed. Moving the reader to
        // another card fragmented their history across agents and made them
        // pick the right one before a follow-up would even be heard. The turn
        // is filed here and labelled with who actually ran it.
        setDelegationNotice({
          from: selected.name,
          to: result.delegatedTo.name,
        });
        await refreshAgents();
        if (selectedIdRef.current === selected.id) {
          setMessages((current) => [...current, result.message]);
          setActiveRun(result.run);
        }
      } else if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <label className="principal-switch">
          <span className="eyebrow">Signed in as</span>
          <select
            value={principal}
            onChange={(event) => {
              setPrincipalState(event.target.value);
              setPrincipal(event.target.value);
            }}
          >
            {PRINCIPALS.map((user) => (
              <option key={user} value={user}>
                {user}
              </option>
            ))}
          </select>
        </label>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
            setView("playground");
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <button
          className={"button nav-button " + (view === "governance" ? "nav-active" : "")}
          onClick={() => setView((current) => (current === "governance" ? "playground" : "governance"))}
        >
          <span>⛨</span> Codify governance
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {/*
            Split, because the platform stopped moving people between Agents.
            A specialist receives routed work; you do not open it to use it. It
            stays selectable — the Starter Kit's lifecycle and the acceptance
            checklist both require that an Agent can be inspected and tested
            from the frontend — but it is presented as a catalogue entry rather
            than as somewhere to start a conversation.
          */}
          {ownAgents.length > 0 && <div className="agent-group">Your agents</div>}
          {ownAgents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => {
                setSelectedId(agent.id);
                setView("playground");
                setDelegationNotice(null);
              }}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}

          {specialists.length > 0 && (
            <div className="agent-group">
              Promoted specialists
              <span>routed to automatically — no need to open one</span>
            </div>
          )}
          {specialists.map(({ agent, contract }) => (
            <button
              className={
                "agent-card agent-specialist " + (agent.id === selectedId ? "selected" : "")
              }
              key={agent.id}
              onClick={() => {
                setSelectedId(agent.id);
                setView("playground");
                setDelegationNotice(null);
              }}
            >
              <div className="agent-avatar">⚙</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span className="agent-scope">
                  v{contract.version} ·{" "}
                  {contract.scope.domains.length > 0
                    ? contract.scope.domains.join(", ")
                    : "no egress"}
                </span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}

          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
          <span className={system?.codifyEnforcing ? "codify-on" : "codify-off"}>
            {system?.codifyEnforcing
              ? "Codify enforcing at the container boundary"
              : "Codify observing only (container runtime required)"}
          </span>
        </div>
      </aside>

      <main className="main">
        {view === "governance" ? (
          <Governance
            onError={setError}
            onAgentsChanged={() => void refreshAgents()}
            isOperator={system?.isOperator === true}
            principal={principal}
          />
        ) : (
          <>
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              {delegationNotice && (
                <div className="delegation-banner" role="status">
                  <span>⇥</span>
                  <div>
                    <strong>Routed to a specialist</strong>
                    <p>
                      This task has been done before, so{" "}
                      <em>{delegationNotice.from}</em> handed it to{" "}
                      <em>{delegationNotice.to}</em> — the Agent promoted for it, running
                      the brief distilled from every past run.
                    </p>
                  </div>
                  <button onClick={() => setDelegationNotice(null)}>×</button>
                </div>
              )}

              {splitSession && (
                <SplitBanner session={splitSession} onDismiss={() => setSplitSession(null)} />
              )}

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => {
                    const ranElsewhere = message.executedByAgentId
                      ? agents.find((agent) => agent.id === message.executedByAgentId)
                      : undefined;
                    return (
                      <article className={"message message-" + message.role} key={message.id}>
                        <div className="message-meta">
                          <strong>
                            {message.role === "user"
                              ? "You"
                              : (ranElsewhere?.name ?? selected.name)}
                          </strong>
                          {message.role === "assistant" && ranElsewhere && (
                            <span className="message-router" title="Routed by Codify">
                              ⇢ specialist for this task
                            </span>
                          )}
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <div className="message-body">{message.content}</div>
                        {message.role === "assistant" &&
                          runsById[message.runId]?.codify &&
                          runsById[message.runId]?.id !== activeRun?.id && (
                            <RunEvidence
                              run={runsById[message.runId] as AgentRun}
                              enforcing={system?.codifyEnforcing === true}
                            />
                          )}
                      </article>
                    );
                  })
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                {activeRun && activeRun.codify && (
                  <RunEvidence run={activeRun} enforcing={system?.codifyEnforcing === true} />
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <label className="adhoc-toggle" title="Bypass contract routing for this turn. Recorded as a user override.">
                    <input
                      type="checkbox"
                      checked={forceAdHoc}
                      onChange={(event) => setForceAdHoc(event.target.checked)}
                    />
                    Run ad-hoc
                  </label>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
          </>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
