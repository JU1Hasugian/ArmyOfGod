import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BROKER_ARK_BASE_URL } from "./codify/broker-session.js";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  /**
   * Endpoint ID for an Ark embedding model, used only by the semantic match
   * channel. Separate from ARK_MODEL because it is a different model family and
   * a deployment may reasonably have one without the other.
   */
  ARK_EMBED_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  CODIFY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /** Image for the broker container. Defaults to the Runtime image, which has node. */
  CODIFY_BROKER_IMAGE: z.string().optional(),
  CODIFY_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
  /**
   * Containment required to treat a prompt as an instance of a task, and the
   * channel that makes routing padding-proof. Set to 0 to disable the channel.
   */
  CODIFY_CONTAINMENT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  /**
   * Cosine required for the semantic channel. Inert unless ARK_EMBED_MODEL is
   * set, because there is nothing to compare against without an embedding.
   */
  CODIFY_SEMANTIC_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
  /**
   * Master switch for the embedding channel. Off under test so the suite never
   * reaches the network; the lexical channels are exercised on their own there.
   */
  CODIFY_SEMANTIC: z.enum(["true", "false"]).optional(),
  CODIFY_MIN_OCCURRENCES: z.coerce.number().int().min(1).default(5),
  CODIFY_MIN_DISTINCT_USERS: z.coerce.number().int().min(1).default(3),
  /**
   * Distinct people who must give the same follow-up correction before it is
   * proposed as a standing rule. Lower than the promotion floor: a correction
   * is a much cheaper, more reversible change than minting a contract.
   */
  CODIFY_MIN_REFINEMENT_USERS: z.coerce.number().int().min(1).default(2),
  /**
   * Whether promotion and refinement may make a model call to draft a brief or
   * a rule. Both callers fall back to a deterministic result when this is off,
   * so turning it off degrades quality and never breaks the flow. Defaults off
   * under test so the suite never reaches the network.
   */
  CODIFY_LLM_DRAFTING: z.enum(["true", "false"]).optional(),
  /** Fallback principal when a request carries no x-codify-user header. */
  CODIFY_DEFAULT_USER: z.string().trim().min(1).max(64).default("user-a"),
  /** Seed the observed-run corpus on first boot so the queue is not empty. */
  CODIFY_SEED_FIXTURES: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

/**
 * Credentials the platform holds on the Agent's behalf. A Runtime container
 * receives one only when the governing contract's scope names it, and the value
 * never leaves the control plane otherwise.
 *
 * Populated from `CODIFY_SECRET_<NAME>` environment variables, so
 * `CODIFY_SECRET_GITHUB_TOKEN=abc` publishes a managed secret named
 * `GITHUB_TOKEN`.
 */
function readManagedSecrets(environment: NodeJS.ProcessEnv): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith("CODIFY_SECRET_") || !value) continue;
    const name = key.slice("CODIFY_SECRET_".length);
    if (name) secrets[name] = value;
  }
  return secrets;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    arkEmbedModel: env.ARK_EMBED_MODEL?.trim() || undefined,
    nodeEnv: env.NODE_ENV,
    codifyEnabled: env.CODIFY_ENABLED,
    codifyBrokerImage: env.CODIFY_BROKER_IMAGE?.trim() || env.CONTAINER_RUNTIME_IMAGE,
    codifyMatchThreshold: env.CODIFY_MATCH_THRESHOLD,
    codifyContainmentThreshold: env.CODIFY_CONTAINMENT_THRESHOLD,
    codifySemanticThreshold: env.CODIFY_SEMANTIC_THRESHOLD,
    // Same default shape as codifyDraftingEnabled: on in normal operation, off
    // under test, and always overridable.
    codifySemanticEnabled:
      env.CODIFY_SEMANTIC === undefined
        ? env.NODE_ENV !== "test"
        : env.CODIFY_SEMANTIC === "true",
    codifyMinOccurrences: env.CODIFY_MIN_OCCURRENCES,
    codifyMinDistinctUsers: env.CODIFY_MIN_DISTINCT_USERS,
    codifyMinRefinementUsers: env.CODIFY_MIN_REFINEMENT_USERS,
    codifyDraftingEnabled:
      env.CODIFY_LLM_DRAFTING === undefined
        ? env.NODE_ENV !== "test"
        : env.CODIFY_LLM_DRAFTING === "true",
    codifyDefaultUser: env.CODIFY_DEFAULT_USER,
    codifySeedFixtures: env.CODIFY_SEED_FIXTURES,
    codifyManagedSecrets: readManagedSecrets(environment),
    /**
     * `dist/` and `src/` sit at the same depth under `apps/server`, so this
     * resolves the same way whether the server runs from a build or from tsx.
     */
    codifyBrokerScript: fileURLToPath(
      new URL("../broker/codify-broker.mjs", import.meta.url),
    ),
    codifyEventRoot: path.join(path.resolve(env.APP_DATA_DIR), "codify-events"),
  };
}

/**
 * Per-Agent Codex home.
 *
 * The baseline bind-mounts one shared `CODEX_HOME` into every Runtime
 * container, which makes it a cross-Agent channel: any Agent can read another's
 * session state or rewrite the generated `config.toml`. Giving each Agent its
 * own directory closes that without changing how sessions resume, since a
 * thread only ever resumes inside the Agent that created it.
 */
export function agentCodexHome(config: AppConfig, agentId: string): string {
  return path.join(config.codexHome, "agents", agentId);
}

/**
 * Codify only enforces at the container boundary, so it is inert for the
 * in-process runner used by `npm run dev` and the ECS profile.
 */
export function isCodifyActive(config: AppConfig): boolean {
  return config.codifyEnabled && config.runtimeProvider === "container";
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(
  config: AppConfig,
  codexHome: string = config.codexHome,
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  // Under Codify the container never holds the real key: Codex talks plain HTTP
  // to the broker inside the internal network, and the broker attaches the real
  // credential on the way upstream over TLS.
  const baseUrl = isCodifyActive(config) ? BROKER_ARK_BASE_URL : config.arkBaseUrl;
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(baseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
