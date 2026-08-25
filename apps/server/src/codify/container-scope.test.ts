import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import {
  buildContainerRunArgs,
  scopeCoversWholeWorkspace,
  writableScopePaths,
  type ScopedLaunch,
} from "../container-codex-runner.js";
import type { RunnerRequest } from "../types.js";

const config = loadConfig({
  NODE_ENV: "test",
  ARK_API_KEY: "real-ark-key-must-never-be-visible",
  ARK_MODEL: "ep-test",
  CODEX_HOME: "/tmp/codex-home",
  RUNTIME_PROVIDER: "container",
  CONTAINER_RUNTIME_IMAGE: "runtime:test",
  CONTAINER_USER: "1000:1000",
  RUNTIME_INSTANCE_ID: "test-instance",
});

const request: RunnerRequest = {
  agentId: "agent-1",
  workspacePath: "/tmp/workspaces/agent-1",
  prompt: "generate the release notes",
  threadId: null,
};

const launch: ScopedLaunch = {
  networkName: "codify-net-test-instance-abc123",
  proxyEnvironment: {
    HTTP_PROXY: "http://codify-broker:8080",
    HTTPS_PROXY: "http://codify-broker:8080",
  },
  scope: {
    paths: [
      { path: "out", mode: "rw" },
      { path: "repo", mode: "ro" },
    ],
    domains: ["github.com"],
    secrets: ["GITHUB_TOKEN"],
  },
  codexHome: "/tmp/codex-home/agents/agent-1",
  secretNames: ["GITHUB_TOKEN"],
};

describe("Codify scoped container launch", () => {
  it("attaches the run only to its internal network, never the bridge", () => {
    const args = buildContainerRunArgs(request, config, launch);
    expect(args).toContain("codify-net-test-instance-abc123");
    expect(args).not.toContain("bridge");
  });

  it("mounts the workspace read-only and layers writable scope paths over it", () => {
    const args = buildContainerRunArgs(request, config, launch);
    expect(args).toContain("type=bind,src=/tmp/workspaces/agent-1,dst=/workspace,readonly");
    expect(args).toContain(
      "type=bind,src=" + path.join("/tmp/workspaces/agent-1", "out") + ",dst=/workspace/out",
    );
    // `repo` is read-only, so it gets no writable mount of its own.
    expect(args.join(" ")).not.toContain("dst=/workspace/repo");
  });

  it("gives each Agent its own Codex home instead of one shared directory", () => {
    const args = buildContainerRunArgs(request, config, launch);
    expect(args).toContain("type=bind,src=/tmp/codex-home/agents/agent-1,dst=/codex-home");
    expect(args).not.toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
  });

  it("passes granted secrets by name only, so no value reaches the command line", () => {
    const args = buildContainerRunArgs(request, config, launch);
    const environmentFlags = args.filter((_, index) => args[index - 1] === "--env");
    expect(environmentFlags).toContain("GITHUB_TOKEN");
    expect(environmentFlags).toContain("ARK_API_KEY");
    expect(args.join(" ")).not.toContain("real-ark-key-must-never-be-visible");
    // A secret outside the scope is not requested at all.
    expect(environmentFlags).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("sets proxy variables as a convenience without relying on them", () => {
    const args = buildContainerRunArgs(request, config, launch);
    expect(args).toContain("HTTPS_PROXY=http://codify-broker:8080");
  });

  it("leaves the baseline invocation untouched when no scope is bound", () => {
    const args = buildContainerRunArgs(request, config);
    expect(args).toContain("bridge");
    expect(args).toContain("type=bind,src=/tmp/workspaces/agent-1,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args.join(" ")).not.toContain("readonly");
  });

  it("does not pretend to narrow a scope that leaves the workspace writable", () => {
    const wideOpen = {
      ...launch,
      scope: { paths: [{ path: ".", mode: "rw" as const }], domains: [], secrets: [] },
    };
    expect(scopeCoversWholeWorkspace(wideOpen.scope)).toBe(true);
    expect(writableScopePaths(wideOpen.scope)).toEqual([]);
    const args = buildContainerRunArgs(request, config, wideOpen);
    expect(args).toContain("type=bind,src=/tmp/workspaces/agent-1,dst=/workspace");
    expect(args.join(" ")).not.toContain("readonly");
  });
});
