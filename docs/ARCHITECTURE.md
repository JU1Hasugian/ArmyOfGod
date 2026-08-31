# Architecture

Volc Agent Launchpad is a single-node control plane for hackathon use.

```mermaid
flowchart LR
    User["Human User"] --> UI["React Web UI"]
    UI --> API["Fastify API"]
    API --> Service["AgentService"]
    Service --> Store["JSON Metadata Store"]
    Service --> WS["Per-Agent Workspace"]
    Service --> Runner{"AgentRunner<br/>Interface"}
    Runner -->|Local POC| Container["Disposable Docker,<br/>Colima, or Podman Container"]
    Runner -->|ECS Profile| Proc["Codex CLI Process"]
    Container --> Broker["Egress broker<br/>allowlist = contract domains<br/>holds the real Ark key"]
    Broker --> Ark["Volcengine Ark<br/>Responses API"]
    Proc --> Ark

    subgraph CODIFY["Codify — the middleware this team designed"]
        direction TB
        ADMIT["Admission<br/>budget at admission, over ⇒ 429<br/>operator-only decisions ⇒ 403"]
        OBSERVE["Observe and route<br/>redact · fingerprint, containment, embedding<br/>matched ⇒ specialist + brief"]
        ENFORCE["Enforce scope<br/>--internal network · workspace ro + scope rw<br/>secrets by name only"]
        LEARN["Promote and refine<br/>repetition ⇒ brief + capability scope<br/>fails closed · narrowing only"]
    end

    ADMIT -.->|integrate| API
    OBSERVE -.->|integrate| Service
    ENFORCE -.->|integrate| Runner
    Store ==>|observed runs| LEARN
    LEARN ==>|contracts| OBSERVE

    classDef box fill:#eef1fb,stroke:#7c89b8,color:#111827
    classDef diamond fill:#fdebc8,stroke:#d8a63d,color:#111827
    classDef mid fill:#eaf3ea,stroke:#6f9a6f,color:#111827
    class User,UI,API,Service,Store,WS,Container,Proc,Broker,Ark box
    class Runner diamond
    class ADMIT,OBSERVE,ENFORCE,LEARN mid
```

## Components

### Web UI

Lists Agents, manages lifecycle actions, submits prompts, and polls asynchronous
Runs. It never receives the Ark API key.

### Fastify API

Validates requests, protects remote demos with a shared bearer token, and
serves the compiled Web UI. The token is not user identity or authorization.

### AgentService

Coordinates lifecycle state, persistence, workspaces, and Runs. One Agent can
have only one active Run.

```text
ready -> busy -> ready
  |       |
  v       v
stopped  error
```

Interrupted Runs become `cancelled` after a restart.

### Storage

```text
data/launchpad.json       Agent, message, and Run metadata
workspaces/AgentID/       Agent-created files
workspaces/.deleted/      Archived deleted workspaces
codex-home/               Codex configuration and sessions
```

`JsonStore` serializes writes and atomically replaces one JSON file. It supports
one process only.

### Runtime providers

- `CodexRunner` runs Codex inside the application container for ECS.
- `ContainerCodexRunner` starts one disposable Docker, Colima, or Podman
  container for every local turn.

Both providers use argv-only process execution, bound output and time, resume
the stored Codex thread, and escalate termination after a grace period.

## Deployment profiles

| Profile | Control plane | Agent execution |
| --- | --- | --- |
| Local POC | Host Node.js | Disposable local container |
| ECS | Application container | Codex process in the same container |
| Local development | Host Node.js | Host Codex process |

## Extension seams

| Track | Primary seam | Expected change |
| --- | --- | --- |
| Glass Box | `AgentRunner`, `AgentRun` | Emit and display correlated execution events. |
| Bouncer | API routes, Agent ownership | Add identity and server-side authorization. |
| Kill Switch | `AgentRunner` | Add threat-specific policy or a stronger sandbox. |

The current container or ECS instance is the POC trust boundary. Ordinary
containers are not hardened multi-tenant isolation.
