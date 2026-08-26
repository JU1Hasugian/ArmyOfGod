/**
 * Codify Broker — the single egress path for a scoped Agent Runtime container.
 *
 * The run container attaches only to a `--internal` network, which has no route
 * off-host. This broker is dual-homed (internal network + bridge), so it is the
 * only reachable way out. It therefore does not depend on the Agent's
 * cooperation: unsetting HTTP_PROXY inside the run container removes the
 * convenience, not the control.
 *
 * Responsibilities
 *   1. CONNECT / absolute-form proxying, allowlisted on the request host only.
 *      TLS is tunnelled, never terminated — the broker sees where traffic goes,
 *      never what it carries.
 *   2. Ark credential brokering. The run container never receives the real Ark
 *      key; it gets a per-run placeholder token. This process exchanges that
 *      token for the real credential and forwards upstream over TLS.
 *   3. Append-only JSONL evidence. The control plane cannot be reached from the
 *      transit network (the POC binds loopback), so evidence crosses the
 *      boundary as a bind-mounted file rather than an HTTP callback.
 *
 * Plain JavaScript on purpose: this file is bind-mounted into a container and
 * executed by node directly, so it must not depend on the server's build output.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { appendFileSync, existsSync } from "node:fs";
import { URL } from "node:url";

const PORT = Number(process.env.CODIFY_BROKER_PORT || 8080);
const RUN_ID = process.env.CODIFY_RUN_ID || "unknown";
const CONTRACT_ID = process.env.CODIFY_CONTRACT_ID || "";
const CONTRACT_VERSION = Number(process.env.CODIFY_CONTRACT_VERSION || 0);
const MODE = process.env.CODIFY_MODE === "observe" ? "observe" : "enforce";
const EVENT_LOG = process.env.CODIFY_EVENT_LOG || "/codify/events.jsonl";
const REVOCATION_FILE = process.env.CODIFY_REVOCATION_FILE || "/codify/revoked";
const ARK_UPSTREAM = process.env.CODIFY_ARK_UPSTREAM || "";
const ARK_KEY = process.env.CODIFY_ARK_KEY || "";
const RUN_TOKEN = process.env.CODIFY_RUN_TOKEN || "";
const ALLOWED = (process.env.CODIFY_ALLOWED_DOMAINS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

/**
 * Hosts that must never be reachable regardless of a contract's allowlist.
 * Cloud instance-metadata endpoints are the canonical confused-deputy target.
 */
const NEVER_ALLOW = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "100.100.100.200",
]);

export function hostAllowed(host, allowed = ALLOWED) {
  const name = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!name) return false;
  if (NEVER_ALLOW.has(name)) return false;
  return allowed.some((rule) =>
    rule.startsWith("*.")
      ? name === rule.slice(2) || name.endsWith(rule.slice(1))
      : name === rule,
  );
}

function splitHostPort(authority, fallbackPort) {
  const value = String(authority || "");
  const match = value.match(/^\[(.+)\]:(\d+)$/) || value.match(/^\[(.+)\]$/);
  if (match) return { host: match[1], port: Number(match[2] || fallbackPort) };
  const index = value.lastIndexOf(":");
  if (index > -1 && /^\d+$/.test(value.slice(index + 1))) {
    return { host: value.slice(0, index), port: Number(value.slice(index + 1)) };
  }
  return { host: value, port: fallbackPort };
}

function record(event) {
  try {
    appendFileSync(
      EVENT_LOG,
      JSON.stringify({ runId: RUN_ID, at: new Date().toISOString(), ...event }) + "\n",
    );
  } catch {
    /* Evidence is best-effort; it must never take the egress path down. */
  }
}

function denial(kind, target, reason) {
  record({
    type: "denial",
    kind,
    target,
    reason,
    outcome: "blocked",
    ...(CONTRACT_ID ? { contractId: CONTRACT_ID, contractVersion: CONTRACT_VERSION } : {}),
  });
}

const isRevoked = () => existsSync(REVOCATION_FILE);

/** CONNECT — the path every HTTPS client takes through a proxy. */
function onConnect(request, clientSocket, head) {
  const { host, port } = splitHostPort(request.url, 443);
  clientSocket.on("error", () => clientSocket.destroy());

  if (MODE === "enforce" && !hostAllowed(host)) {
    denial("egress", host, "host is not in the contract allowlist");
    clientSocket.write(
      "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n" +
        "X-Codify-Denied: egress\r\nConnection: close\r\n\r\n" +
        "Codify denied egress to " + host + ": not in the contract's allowlist.\n",
    );
    clientSocket.destroy();
    return;
  }

  record({ type: "egress", host, port, decision: MODE === "observe" ? "observed" : "allowed" });

  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => {
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    clientSocket.destroy();
  });
}

/** Ark credential exchange: per-run placeholder in, real credential out. */
function handleArk(request, response) {
  if (!ARK_UPSTREAM || !ARK_KEY) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Codify broker has no Ark upstream configured" }));
    return;
  }

  const presented = (request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!RUN_TOKEN || presented !== RUN_TOKEN) {
    denial("secret", "ark", "run token did not match this run's brokered credential");
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Codify broker rejected the presented run token" }));
    request.resume();
    return;
  }

  if (isRevoked()) {
    denial("secret", "ark", "this run's brokered credential was revoked");
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Codify revoked this run's model credential" }));
    request.resume();
    return;
  }

  const suffix = request.url.slice("/ark".length) || "/";
  const target = new URL(ARK_UPSTREAM.replace(/\/+$/, "") + suffix);
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["proxy-connection"];
  headers.authorization = "Bearer " + ARK_KEY;
  headers.host = target.host;

  const transport = target.protocol === "http:" ? http : https;
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: target.pathname + target.search,
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      record({
        type: "model_call",
        host: target.hostname,
        status: upstreamResponse.statusCode ?? 0,
      });
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    record({ type: "model_call", host: target.hostname, status: 0, error: error.message });
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ error: "Codify broker could not reach the model provider" }));
  });
  request.pipe(upstream);
}

/** Absolute-form http:// proxying, plus the Ark origin-form endpoint. */
function onRequest(request, response) {
  if (request.url.startsWith("/ark/") || request.url === "/ark") {
    return handleArk(request, response);
  }
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ ok: true, mode: MODE, runId: RUN_ID }));
  }
  if (!/^https?:\/\//i.test(request.url)) {
    response.writeHead(404, { "content-type": "text/plain" });
    return response.end("Codify broker: use CONNECT, or the /ark credential endpoint.\n");
  }

  const target = new URL(request.url);
  if (MODE === "enforce" && !hostAllowed(target.hostname)) {
    denial("egress", target.hostname, "host is not in the contract allowlist");
    response.writeHead(403, { "content-type": "text/plain", "x-codify-denied": "egress" });
    request.resume();
    return response.end("Codify denied egress to " + target.hostname + ".\n");
  }

  record({
    type: "egress",
    host: target.hostname,
    port: Number(target.port || 80),
    decision: MODE === "observe" ? "observed" : "allowed",
  });

  const headers = { ...request.headers };
  delete headers["proxy-connection"];
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

export function createBroker() {
  const server = http.createServer(onRequest);
  server.on("connect", onConnect);
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === "file://" + process.argv[1];
if (invokedDirectly) {
  createBroker().listen(PORT, "0.0.0.0", () => {
    record({ type: "broker_started", mode: MODE, allowlist: ALLOWED });
    process.stderr.write("[codify-broker] mode=" + MODE + " port=" + PORT + "\n");
  });
}
