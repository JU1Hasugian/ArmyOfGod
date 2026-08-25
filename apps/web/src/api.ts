import type {
  Agent,
  AgentRun,
  CapabilityScope,
  DenialEvent,
  EscalationProposal,
  Message,
  RefinementProposal,
  RouteDecision,
  SystemInfo,
  TaskCandidate,
  TaskContract,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";
/**
 * Mock identity. The header is the only thing the browser controls; every
 * authorization decision is made server-side against it.
 */
let principal = "user-a";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function setPrincipal(user: string): void {
  principal = user.trim() || "user-a";
}

export function getPrincipal(): string {
  return principal;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    "x-codify-user": principal,
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string, forceAdHoc = false) =>
    request<{ run: AgentRun; message: Message; delegatedTo?: Agent }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content, forceAdHoc }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),

  candidates: () =>
    request<{ candidates: TaskCandidate[] }>("/api/codify/candidates"),
  refreshCandidates: () =>
    request<{ candidates: TaskCandidate[] }>("/api/codify/candidates/refresh", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  approveCandidate: (id: string, body: { name?: string; scope?: CapabilityScope }) =>
    request<{ candidate: TaskCandidate; contract: TaskContract; agent: Agent }>(
      "/api/codify/candidates/" + id + "/approve",
      { method: "POST", body: JSON.stringify(body) },
    ),
  rejectCandidate: (id: string) =>
    request<{ candidate: TaskCandidate }>("/api/codify/candidates/" + id + "/reject", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  contracts: () => request<{ contracts: TaskContract[] }>("/api/codify/contracts"),
  reviseContract: (id: string, scope: CapabilityScope) =>
    request<{ contract: TaskContract }>("/api/codify/contracts/" + id, {
      method: "PATCH",
      body: JSON.stringify({ scope }),
    }),
  escalation: (id: string) =>
    request<EscalationProposal>("/api/codify/contracts/" + id + "/escalation"),
  runEvidence: (id: string) =>
    request<{ run: AgentRun; decision: RouteDecision | null; denials: DenialEvent[] }>(
      "/api/codify/runs/" + id,
    ),
  denials: () => request<{ denials: DenialEvent[] }>("/api/codify/denials"),

  refinements: () =>
    request<{ refinements: RefinementProposal[] }>("/api/codify/refinements"),
  refreshRefinements: () =>
    request<{ refinements: RefinementProposal[] }>("/api/codify/refinements/refresh", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  applyRefinement: (id: string, rule?: string) =>
    request<{ contract: TaskContract; agent: Agent | null }>(
      "/api/codify/refinements/" + id + "/apply",
      { method: "POST", body: JSON.stringify(rule ? { rule } : {}) },
    ),
  rejectRefinement: (id: string) =>
    request<{ refinement: RefinementProposal }>(
      "/api/codify/refinements/" + id + "/reject",
      { method: "POST", body: JSON.stringify({}) },
    ),
};
