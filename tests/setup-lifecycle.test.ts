import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  launcherCapabilityProbeRequired,
  restoreTerminalSetupAfterFailure,
  setupProxyIsReady,
} from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup refreshes account capabilities only when missing or explicitly requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    proAvailable: false,
  };

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    proAvailable: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never, true)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never, false, "automatic")).toBe(true);
});

function serviceStatus(installed: boolean, loaded: boolean) {
  return { supported: true, installed, loaded, label: "responses" };
}

function tunnelServiceStatus(installed: boolean, loaded: boolean) {
  return { supported: true, installed, loaded, running: loaded, label: "tunnel" };
}

function rollbackOperations(
  events: string[],
  overrides: Partial<Record<string, () => unknown | Promise<unknown>>> = {},
) {
  const operation = (name: string, fallback?: () => unknown | Promise<unknown>) => (..._args: unknown[]) => {
    events.push(name);
    return overrides[name]?.() ?? fallback?.();
  };
  return {
    getServiceStatus: operation("inspect responses", () => serviceStatus(true, true)),
    uninstallService: operation("stop candidate responses", () => serviceStatus(false, false)),
    installService: operation("install previous responses", () => serviceStatus(true, true)),
    stopService: operation("stop previous responses", () => serviceStatus(true, false)),
    waitForProxy: operation("verify previous responses", async () => {}),
    getTunnelServiceStatus: operation("inspect tunnel", () => tunnelServiceStatus(true, true)),
    uninstallTunnelService: operation("stop candidate tunnel service", async () => tunnelServiceStatus(false, false)),
    stopTunnel: operation("stop candidate tunnel runtime", () => {}),
    bootstrapTunnelProfile: operation("restore previous tunnel profile", async () => {}),
    installTunnelService: operation("install previous tunnel service", () => tunnelServiceStatus(true, true)),
    stopTunnelService: operation("stop previous tunnel service", async () => tunnelServiceStatus(true, false)),
    waitForTunnelReady: operation("verify previous tunnel service", async () => ({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      detail: "ready",
    })),
    restoreApplicationConfig: operation("restore previous config", () => {}),
  };
}

test("terminal setup rollback stops candidate runtimes before restoring config and old services", async () => {
  const events: string[] = [];
  const existing = defaultConfig("full");
  const candidate = structuredClone(existing);
  candidate.controlToken = "candidate-control-token-0123456789abcdefghijkl";

  await restoreTerminalSetupAfterFailure({
    existing,
    candidate,
    priorConfigSnapshot: { path: "/private/old-config.json", exists: true, data: Buffer.from("old") },
    beforeService: serviceStatus(true, true),
    beforeTunnelService: tunnelServiceStatus(true, true),
    candidateServiceStarted: true,
    tunnelMutationStarted: true,
  }, rollbackOperations(events) as never);

  expect(events).toEqual([
    "inspect responses",
    "stop candidate responses",
    "inspect tunnel",
    "stop candidate tunnel service",
    "stop candidate tunnel runtime",
    "restore previous config",
    "install previous responses",
    "verify previous responses",
    "restore previous tunnel profile",
    "install previous tunnel service",
    "verify previous tunnel service",
  ]);
});

test("terminal setup rollback never restores the old capability while a candidate runtime cannot stop", async () => {
  const events: string[] = [];
  const existing = defaultConfig("browser-only");
  const candidate = structuredClone(existing);

  await expect(restoreTerminalSetupAfterFailure({
    existing,
    candidate,
    priorConfigSnapshot: { path: "/private/old-config.json", exists: true, data: Buffer.from("old") },
    beforeService: serviceStatus(false, false),
    beforeTunnelService: tunnelServiceStatus(false, false),
    candidateServiceStarted: true,
    tunnelMutationStarted: false,
  }, rollbackOperations(events, {
    "stop candidate responses": () => { throw new Error("bootout failed"); },
  }) as never)).rejects.toThrow("bootout failed");

  expect(events).toEqual(["inspect responses", "stop candidate responses"]);
  expect(events).not.toContain("restore previous config");
});

test("terminal setup rollback returns previously unloaded launchd jobs to unloaded state", async () => {
  const events: string[] = [];
  const existing = defaultConfig("full");

  await restoreTerminalSetupAfterFailure({
    existing,
    candidate: structuredClone(existing),
    priorConfigSnapshot: { path: "/private/old-config.json", exists: false },
    beforeService: serviceStatus(true, false),
    beforeTunnelService: tunnelServiceStatus(true, false),
    candidateServiceStarted: true,
    tunnelMutationStarted: true,
  }, rollbackOperations(events) as never);

  expect(events.slice(-2)).toEqual([
    "stop previous tunnel service",
    "stop previous responses",
  ]);
});
