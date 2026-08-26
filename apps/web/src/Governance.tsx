/**
 * The Codify governance view.
 *
 * Deliberately thin: everything here reads or triggers a decision that is made
 * and enforced on the server. The UI explains the capability model; it is never
 * the thing that applies it.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type {
  Agent,
  BudgetStatus,
  CapabilityScope,
  CoordinationSession,
  DenialEvent,
  RefinementProposal,
  TaskBudget,
  TaskCandidate,
  TaskContract,
} from "./types";

function ScopeView({
  scope,
  onToggleDomain,
  onTogglePath,
  onToggleSecret,
  editable,
}: {
  scope: CapabilityScope;
  editable?: boolean;
  onToggleDomain?: (domain: string) => void;
  onTogglePath?: (path: string) => void;
  onToggleSecret?: (secret: string) => void;
}) {
  const wholeWorkspace = scope.paths.some(
    (entry) => entry.mode === "rw" && entry.path === ".",
  );
  return (
    <div className="scope-grid">
      <div className="scope-block">
        <span className="eyebrow">Network</span>
        {scope.domains.length === 0 ? (
          <em className="scope-none">No egress. The run reaches nothing.</em>
        ) : (
          <ul>
            {scope.domains.map((domain) => (
              <li key={domain}>
                <code>{domain}</code>
                {editable && onToggleDomain && (
                  <button
                    className="scope-remove"
                    title="Revoke this domain"
                    onClick={() => onToggleDomain(domain)}
                  >
                    revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="scope-block">
        <span className="eyebrow">Filesystem</span>
        {scope.paths.length === 0 ? (
          <em className="scope-none">Workspace read-only.</em>
        ) : (
          <ul>
            {scope.paths.map((entry) => (
              <li key={entry.path + entry.mode}>
                <code>./{entry.path === "." ? "" : entry.path}</code>
                <span className={"mode-tag mode-" + entry.mode}>{entry.mode}</span>
                {editable && onTogglePath && entry.mode === "rw" && entry.path !== "." && (
                  <button
                    className="scope-remove"
                    title="Drop this writable path"
                    onClick={() => onTogglePath(entry.path)}
                  >
                    revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {wholeWorkspace && (
          <p className="scope-warn">
            The whole workspace is writable — this scope is not narrowed.
          </p>
        )}
      </div>

      <div className="scope-block">
        <span className="eyebrow">Secrets</span>
        {scope.secrets.length === 0 ? (
          <em className="scope-none">None injected.</em>
        ) : (
          <ul>
            {scope.secrets.map((secret) => (
              <li key={secret}>
                <code>{secret}</code>
                {editable && onToggleSecret && (
                  <button
                    className="scope-remove"
                    title="Revoke this secret"
                    onClick={() => onToggleSecret(secret)}
                  >
                    revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  onDecided,
  onError,
}: {
  candidate: TaskCandidate;
  onDecided: () => void;
  onError: (message: string) => void;
}) {
  const [scope, setScope] = useState<CapabilityScope>(candidate.proposedScope);
  const [name, setName] = useState(candidate.proposedName);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const narrowed =
    JSON.stringify(scope) !== JSON.stringify(candidate.proposedScope);

  const approve = async () => {
    setBusy(true);
    try {
      await api.approveCandidate(candidate.id, { name, scope });
      onDecided();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await api.rejectCandidate(candidate.id);
      onDecided();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="candidate-card">
      <header>
        <div>
          <input
            className="candidate-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Contract name"
          />
          <p className="candidate-meta">
            <strong>{candidate.occurrences}</strong> runs from{" "}
            <strong>{candidate.distinctUsers}</strong> distinct users
          </p>
        </div>
        <span className={"badge badge-" + candidate.status}>{candidate.status}</span>
      </header>

      <p className="derived-note">
        Nobody wrote this policy. It is what these runs already did.
      </p>
      <ScopeView
        scope={scope}
        editable
        onToggleDomain={(domain) =>
          setScope((current) => ({
            ...current,
            domains: current.domains.filter((entry) => entry !== domain),
          }))
        }
        onTogglePath={(path) =>
          setScope((current) => ({
            ...current,
            paths: current.paths.filter((entry) => entry.path !== path),
          }))
        }
        onToggleSecret={(secret) =>
          setScope((current) => ({
            ...current,
            secrets: current.secrets.filter((entry) => entry !== secret),
          }))
        }
      />

      {narrowed && (
        <p className="narrow-note">
          Narrowed from the derived proposal. A reviewer can only ever remove —
          adding a capability requires a recorded denial.
        </p>
      )}

      <button className="link-button" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Hide" : "Show"} the generated specification
      </button>
      {expanded && <pre className="spec-preview">{candidate.proposedPrompt}</pre>}

      {candidate.status === "pending" && (
        <footer className="candidate-actions">
          <button className="button button-primary" disabled={busy} onClick={approve}>
            Approve and create Agent
          </button>
          <button className="button" disabled={busy} onClick={reject}>
            Reject
          </button>
        </footer>
      )}
    </article>
  );
}

/**
 * Spend against a contract's ceiling.
 *
 * Shows the meter even when there is no ceiling, because "unlimited, and this
 * is what it has cost so far" is the number a reviewer needs in order to decide
 * what the ceiling should be.
 */
function BudgetPanel({
  contract,
  onChanged,
  onError,
  disabled,
}: {
  contract: TaskContract;
  onChanged: () => void;
  onError: (message: string) => void;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .budgetStatus(contract.id)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [contract.id]);

  useEffect(load, [load]);

  const apply = async (budget: TaskBudget | null) => {
    setBusy(true);
    try {
      await api.reviseContract(contract.id, { budget });
      setDraft("");
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const ceiling = contract.budget?.maxTotalTokens;
  const spent = status?.usage.totalTokens ?? 0;
  const ratio = ceiling ? Math.min(1, spent / ceiling) : 0;

  return (
    <div className="budget">
      <span className="eyebrow">Budget</span>
      <div className="budget-row">
        <strong>{spent.toLocaleString()}</strong>
        <span>
          tokens over {status?.usage.runs ?? 0} run{status?.usage.runs === 1 ? "" : "s"}
          {ceiling ? " · ceiling " + ceiling.toLocaleString() : " · no ceiling set"}
        </span>
      </div>
      {ceiling ? (
        <span className="budget-meter">
          <span
            className={"budget-fill" + (ratio >= 1 ? " over" : "")}
            style={{ width: Math.max(2, ratio * 100) + "%" }}
          />
        </span>
      ) : (
        <p className="budget-none">
          Unlimited. A runaway task is bounded only by the Runtime timeout.
        </p>
      )}
      {status && !status.allowed && <p className="budget-none">{status.reason}</p>}
      {contract.status === "active" && (
        <div className="budget-row">
          <input
            className="budget-input"
            type="number"
            min={1}
            placeholder="token ceiling"
            value={draft}
            disabled={disabled || busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            className="button button-ghost"
            disabled={disabled || busy || !draft}
            onClick={() => apply({ maxTotalTokens: Number(draft) })}
          >
            Set ceiling
          </button>
          {ceiling && (
            <button
              className="button button-ghost"
              disabled={disabled || busy}
              onClick={() => apply(null)}
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A shared session, and the turn history that makes the coordination legible.
 *
 * The two things this view has to show, per the brief, are which Agent produced
 * each message and in what order. Both come straight off the turn records — the
 * coordinator writes them before it runs anything, so what is displayed is what
 * was decided, not a reconstruction.
 */
/**
 * Open a shared session.
 *
 * Participants are picked explicitly rather than inferred from which Agents
 * have contracts: an Agent without one is a legitimate participant that simply
 * never wins a match, and hiding that would make the fallback rule invisible.
 */
function NewSession({
  agents,
  onCreated,
  onError,
}: {
  agents: Agent[];
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [maxTurns, setMaxTurns] = useState(4);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );

  const create = async () => {
    setBusy(true);
    try {
      await api.createSession({
        topic: topic.trim(),
        goal: goal.trim(),
        participantAgentIds: selected,
        maxTurns,
      });
      setTopic("");
      setGoal("");
      setSelected([]);
      onCreated();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-session">
      <input
        placeholder="Topic, e.g. the v4 release"
        value={topic}
        onChange={(event) => setTopic(event.target.value)}
        disabled={busy}
      />
      <textarea
        placeholder="What the session should achieve. Each step is routed to whichever specialist matches it."
        rows={2}
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        disabled={busy}
      />
      <div className="session-participants">
        {agents.map((agent) => (
          <label key={agent.id}>
            <input
              type="checkbox"
              checked={selected.includes(agent.id)}
              onChange={() => toggle(agent.id)}
              disabled={busy}
            />
            {agent.name}
          </label>
        ))}
      </div>
      <div className="candidate-actions">
        <label className="turn-cap">
          Turn ceiling
          <input
            type="number"
            min={1}
            max={40}
            value={maxTurns}
            disabled={busy}
            onChange={(event) => setMaxTurns(Number(event.target.value))}
          />
        </label>
        <button
          className="button"
          disabled={busy || !topic.trim() || !goal.trim() || selected.length < 2}
          onClick={() => void create()}
        >
          Open session
        </button>
      </div>
    </div>
  );
}

function SessionCard({
  session,
  onChanged,
  onError,
}: {
  session: CoordinationSession;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="contract-card">
      <header>
        <div>
          <strong>{session.topic}</strong>
          <p className="candidate-meta">
            {session.turns.length} of {session.maxTurns} turns ·{" "}
            {session.participantAgentIds.length} participants · opened by {session.createdBy}
          </p>
        </div>
        <span className={"badge badge-" + session.status}>{session.status}</span>
      </header>

      <p className="session-goal">{session.goal}</p>

      {session.stopReason && <p className="muted">{session.stopReason}</p>}

      {Object.keys(session.state).length > 0 && (
        <div className="session-state">
          <span className="eyebrow">Shared state</span>
          <ul>
            {Object.entries(session.state).map(([key, value]) => (
              <li key={key}>
                <code>{key}</code> = <code>{value}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {session.turns.length > 0 && (
        <ol className="session-turns">
          {session.turns.map((turn) => (
            <li key={turn.index} className={"session-turn turn-" + turn.status}>
              <span className="turn-index">{turn.index + 1}</span>
              <div className="turn-body">
                <div className="turn-head">
                  <strong>{turn.agentName}</strong>
                  {turn.contractName ? (
                    <span className="turn-contract">under {turn.contractName}</span>
                  ) : (
                    <span className="turn-contract unbound">no contract matched</span>
                  )}
                </div>
                <p className="turn-why">{turn.selection}</p>
                {turn.output && <p className="turn-output">{turn.output.slice(0, 400)}</p>}
                {turn.error && <p className="turn-error">{turn.error}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {session.status === "active" && (
        <div className="candidate-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() => void act(() => api.advanceSession(session.id))}
          >
            {busy ? "Running a turn…" : "Take the next turn"}
          </button>
          <button
            className="button button-ghost"
            disabled={busy}
            onClick={() => void act(() => api.stopSession(session.id))}
          >
            Stop
          </button>
        </div>
      )}
    </article>
  );
}

function ContractCard({
  contract,
  onChanged,
  onError,
}: {
  contract: TaskContract;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const revise = async (scope: CapabilityScope) => {
    setBusy(true);
    try {
      await api.reviseContract(contract.id, { scope });
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const escalate = async () => {
    setBusy(true);
    try {
      const proposal = await api.escalation(contract.id);
      if (proposal.evidence.length === 0) {
        onError("No denial has been recorded for this contract, so there is nothing to escalate.");
        return;
      }
      await api.reviseContract(contract.id, { scope: proposal.proposedScope });
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={"contract-card " + (contract.status === "deprecated" ? "faded" : "")}>
      <header>
        <div>
          <strong>{contract.name}</strong>
          <p className="candidate-meta">
            v{contract.version} ·{" "}
            {/*
              A single number was honest when there was a single channel. Showing
              only the fingerprint threshold now understates what has to be
              cleared, so the summary names the count and the tooltip carries the
              three figures a reviewer would actually check.
            */}
            <span
              title={
                "fingerprint ≥ " +
                contract.matchThreshold +
                " · containment ≥ " +
                (contract.containmentThreshold ?? 0.6) +
                " · semantic ≥ " +
                (contract.semanticThreshold ?? 0.72)
              }
            >
              three-channel match
            </span>{" "}
            · approved by {contract.createdBy}
            {contract.supersedes ? " · supersedes an earlier version" : ""}
          </p>
          {contract.reviewNote && (
            // Promoted without a person, so what the reviewer saw is shown
            // rather than left implicit — this is the whole of the oversight.
            <p className="review-note">
              <span className="eyebrow">Auto-promoted</span> {contract.reviewNote}
            </p>
          )}
        </div>
        <span className={"badge badge-" + contract.status}>{contract.status}</span>
      </header>

      {contract.refinements.length > 0 && (
        <div className="learned-rules">
          <span className="eyebrow">Learned from usage</span>
          <ul>
            {contract.refinements.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      )}

      <BudgetPanel
        contract={contract}
        onChanged={onChanged}
        onError={onError}
        disabled={busy}
      />

      <ScopeView
        scope={contract.scope}
        editable={contract.status === "active" && !busy}
        onToggleDomain={(domain) =>
          revise({
            ...contract.scope,
            domains: contract.scope.domains.filter((entry) => entry !== domain),
          })
        }
        onTogglePath={(path) =>
          revise({
            ...contract.scope,
            paths: contract.scope.paths.filter((entry) => entry.path !== path),
          })
        }
        onToggleSecret={(secret) =>
          revise({
            ...contract.scope,
            secrets: contract.scope.secrets.filter((entry) => entry !== secret),
          })
        }
      />

      {contract.status === "active" && (
        <footer className="candidate-actions">
          <button className="button" disabled={busy} onClick={escalate}>
            Escalate from recorded denials
          </button>
        </footer>
      )}
    </article>
  );
}

function RefinementCard({
  proposal,
  onDecided,
  onError,
}: {
  proposal: RefinementProposal;
  onDecided: () => void;
  onError: (message: string) => void;
}) {
  const [rule, setRule] = useState(proposal.proposedRule);
  const [busy, setBusy] = useState(false);

  const act = async (approve: boolean) => {
    setBusy(true);
    try {
      if (approve) await api.applyRefinement(proposal.id, rule);
      else await api.rejectRefinement(proposal.id);
      onDecided();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="candidate-card">
      <header>
        <div>
          <strong>Everyone keeps asking for the same thing</strong>
          <p className="candidate-meta">
            <strong>{proposal.distinctUsers}</strong> different people gave this correction
            after v{proposal.contractVersion} produced its output
          </p>
        </div>
        <span className={"badge badge-" + proposal.status}>{proposal.status}</span>
      </header>

      <div className="feedback-quotes">
        {proposal.exemplars.slice(0, 4).map((text, index) => (
          <blockquote key={index}>{text}</blockquote>
        ))}
      </div>

      <label className="rule-editor">
        <span className="eyebrow">Rule to add to the brief</span>
        <textarea
          value={rule}
          rows={2}
          onChange={(event) => setRule(event.target.value)}
        />
      </label>
      <p className="derived-note">
        Approving this bumps the contract to a new version and rewrites the specialist's
        brief, so nobody has to ask again.
      </p>

      {proposal.status === "pending" && (
        <footer className="candidate-actions">
          <button className="button button-primary" disabled={busy || !rule.trim()} onClick={() => void act(true)}>
            Add to the brief
          </button>
          <button className="button" disabled={busy} onClick={() => void act(false)}>
            Reject
          </button>
        </footer>
      )}
    </article>
  );
}

export default function Governance({
  onError,
  onAgentsChanged,
}: {
  onError: (message: string) => void;
  /**
   * Approving a candidate creates an Agent; applying a refinement rewrites
   * another's brief. The Playground holds its own copy of that list, so without
   * this it keeps showing the brief as it was before the rule was added, with
   * nothing on screen to say it is stale.
   */
  onAgentsChanged?: () => void;
}) {
  const [candidates, setCandidates] = useState<TaskCandidate[]>([]);
  const [contracts, setContracts] = useState<TaskContract[]>([]);
  const [denials, setDenials] = useState<DenialEvent[]>([]);
  const [refinements, setRefinements] = useState<RefinementProposal[]>([]);
  const [sessions, setSessions] = useState<CoordinationSession[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [candidateResult, contractResult, denialResult, refinementResult, sessionResult] =
        await Promise.all([
          api.refreshCandidates(),
          api.contracts(),
          api.denials(),
          api.refreshRefinements(),
          api.sessions(),
        ]);
      setAgents((await api.listAgents()).agents);
      onAgentsChanged?.();
      setCandidates(candidateResult.candidates);
      setContracts(contractResult.contracts);
      setDenials(denialResult.denials);
      setRefinements(refinementResult.refinements);
      setSessions(sessionResult.sessions);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onError, onAgentsChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = candidates.filter((candidate) => candidate.status === "pending");
  const pendingRefinements = refinements.filter(
    (proposal) => proposal.status === "pending",
  );

  return (
    <div className="governance">
      <header className="governance-header">
        <div>
          <h1>Learned least-privilege</h1>
          <p>
            Codify observes what recurring tasks actually do, proposes a scope derived
            from that behaviour, and enforces it at the container boundary.
          </p>
        </div>
        <button className="button" onClick={() => void refresh()}>
          Rescan observations
        </button>
      </header>

      {loading && <p className="muted">Loading…</p>}

      <section>
        <h2>
          Task candidates <span className="count">{pending.length} pending</span>
        </h2>
        {pending.length === 0 && !loading && (
          <p className="muted">
            No cluster has yet reached 5 runs from 3 distinct users. One user repeating a
            prompt never reaches this queue.
          </p>
        )}
        {pending.map((candidate) => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            onDecided={() => void refresh()}
            onError={onError}
          />
        ))}
      </section>

      <section>
        <h2>
          Shared sessions <span className="count">{sessions.length}</span>
        </h2>
        <NewSession
          agents={agents}
          onCreated={() => void refresh()}
          onError={onError}
        />
        {sessions.length === 0 && !loading && (
          <p className="muted">
            A shared session routes each step to the specialist whose contract matches it, so
            no participant ever holds more than its own task&apos;s scope.
          </p>
        )}
        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            onChanged={() => void refresh()}
            onError={onError}
          />
        ))}
      </section>

      <section>
        <h2>
          Learned improvements{" "}
          <span className="count">{pendingRefinements.length} pending</span>
        </h2>
        {pendingRefinements.length === 0 && !loading && (
          <p className="muted">
            When several people give a specialist the same correction, it appears here as a
            proposed rule. One person asking is a preference and is ignored.
          </p>
        )}
        {pendingRefinements.map((proposal) => (
          <RefinementCard
            key={proposal.id}
            proposal={proposal}
            onDecided={() => void refresh()}
            onError={onError}
          />
        ))}
      </section>

      <section>
        <h2>
          Contracts <span className="count">{contracts.length}</span>
        </h2>
        {contracts.length === 0 && !loading && (
          <p className="muted">Approve a candidate to create the first governed task.</p>
        )}
        {contracts.map((contract) => (
          <ContractCard
            key={contract.id}
            contract={contract}
            onChanged={() => void refresh()}
            onError={onError}
          />
        ))}
      </section>

      <section>
        <h2>
          Denials <span className="count">{denials.length}</span>
        </h2>
        {denials.length === 0 && !loading && (
          <p className="muted">
            Nothing has been blocked yet. Denials appear here the moment a governed run
            reaches outside its scope.
          </p>
        )}
        {denials.length > 0 && (
          <table className="denial-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Target</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {denials.map((denial) => (
                <tr key={denial.id}>
                  <td>{new Date(denial.at).toLocaleTimeString()}</td>
                  <td>
                    <span className="mode-tag">{denial.kind}</span>
                  </td>
                  <td>
                    <code>{denial.target}</code>
                  </td>
                  <td className="blocked">blocked</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
