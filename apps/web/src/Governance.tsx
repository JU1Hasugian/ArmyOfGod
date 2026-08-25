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
  CapabilityScope,
  DenialEvent,
  RefinementProposal,
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
      await api.reviseContract(contract.id, scope);
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
      await api.reviseContract(contract.id, proposal.proposedScope);
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
            v{contract.version} · match ≥ {contract.matchThreshold} · approved by{" "}
            {contract.createdBy}
            {contract.supersedes ? " · supersedes an earlier version" : ""}
          </p>
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

export default function Governance({ onError }: { onError: (message: string) => void }) {
  const [candidates, setCandidates] = useState<TaskCandidate[]>([]);
  const [contracts, setContracts] = useState<TaskContract[]>([]);
  const [denials, setDenials] = useState<DenialEvent[]>([]);
  const [refinements, setRefinements] = useState<RefinementProposal[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [candidateResult, contractResult, denialResult, refinementResult] =
        await Promise.all([
          api.refreshCandidates(),
          api.contracts(),
          api.denials(),
          api.refreshRefinements(),
        ]);
      setCandidates(candidateResult.candidates);
      setContracts(contractResult.contracts);
      setDenials(denialResult.denials);
      setRefinements(refinementResult.refinements);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

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
