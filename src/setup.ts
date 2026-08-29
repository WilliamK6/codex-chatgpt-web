import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { AppConfig, RuntimeMode, SubagentProtocol } from "./config";
import {
  currentRuntimeCommand,
  configWasMigratedForSetup,
  defaultBrokerEndpoint,
  defaultConfig,
  getConfigPath,
  loadConfigForSetup,
  randomCapabilityToken,
  resolveDevSetupConnectorName,
  resolveSetupConnectorName,
  saveConfig,
} from "./config";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  loginToChatGpt,
  storedBrowserLoginCapabilities,
} from "./browser-login";
import {
  commitCodexIntegrationAndConfig,
  preflightCodexIntegration,
  readCodexSubagentProtocol,
  snapshotApplicationConfig,
} from "./codex-integration";
import { restoreFileSnapshot, type FileSnapshot } from "./codex-integration-shared";
import { inspectLauncherBrowserHost } from "./launcher-browser-host";
import {
  DEV_CONFIG_PURPOSE,
  DEV_LAUNCHER_PROFILE,
  DEV_TUNNEL_BASE_NAME,
} from "./dev-chat/constants";
import {
  assertServiceIdle,
  getServiceStatus,
  installService,
  removeLegacyRuntimeArtifacts,
  restartService,
  stopService,
  uninstallService,
} from "./service";
import { connectTunnel, createTunnelConfig, installRuntimeKey, installRuntimeKeyBytes, installTunnelClient, managedRuntimeKeyPath, stopTunnel, waitForTunnelReady } from "./tunnel";
import { getTunnelServiceStatus, installTunnelService, restartTunnelService, stopTunnelService, tunnelServiceDefinitionMatches, uninstallTunnelService } from "./tunnel-service";
import { VERSION } from "./version";

export interface SetupOptions {
  mode: RuntimeMode;
  subagentProtocol?: SubagentProtocol;
  port?: number;
  chromeExecutablePath?: string;
  browserHostDescriptorPath?: string;
  refreshAccountCapabilities?: boolean;
  appName?: string;
  forceLogin?: boolean;
  autoApproveToolCalls?: boolean;
  experimentalBiggerContext?: boolean;
  replaceCodexRoute?: boolean;
  restartService?: boolean;
  acknowledgedUnofficial?: boolean;
  tunnelId?: string;
  runtimeKeyFile?: string;
  runtimeKeyValue?: string;
}

export interface SetupResult {
  mode: RuntimeMode;
  configPath: string;
  loginCreated: boolean;
  serviceLoaded: boolean;
  tunnelReady: boolean | null;
  codexRestartRequired: true;
  connectorSetupRequired: boolean;
}

export interface DevProfileSetupResult {
  mode: RuntimeMode;
  configPath: string;
  tunnelReady: boolean | null;
  connectorSetupRequired: boolean;
}

export interface ExistingFullSetupCredentials {
  tunnelId: boolean;
  runtimeKey: boolean;
}

export function launcherCapabilityProbeRequired(
  existing: AppConfig | undefined,
  refreshAccountCapabilities = false,
): boolean {
  return refreshAccountCapabilities
    || existing?.browserHost !== "launcher"
    || typeof existing.solAvailable !== "boolean"
    || typeof existing.proAvailable !== "boolean";
}

export function existingFullSetupCredentials(existing: AppConfig | undefined): ExistingFullSetupCredentials {
  const tunnel = existing?.mode === "full" ? existing.tunnel : undefined;
  return {
    tunnelId: Boolean(tunnel?.tunnelId),
    runtimeKey: Boolean(tunnel?.runtimeKeyFile && existsSync(tunnel.runtimeKeyFile)),
  };
}

function loadExistingConfig(): AppConfig | undefined {
  if (!existsSync(getConfigPath())) return undefined;
  return loadConfigForSetup();
}

function meaningfulRuntimeChange(before: AppConfig, after: AppConfig): boolean {
  return JSON.stringify({
    mode: before.mode,
    subagentProtocol: before.subagentProtocol,
    releaseVersion: before.releaseVersion,
    host: before.host,
    port: before.port,
    contextWindow: before.contextWindow,
    appName: before.appName,
    browserHost: before.browserHost,
    browserHostDescriptorPath: before.browserHostDescriptorPath,
    chromeExecutablePath: before.chromeExecutablePath,
    storageStatePath: before.storageStatePath,
    brokerSocketPath: before.brokerSocketPath,
    headed: before.headed,
    solAvailable: before.solAvailable,
    proAvailable: before.proAvailable,
    experimentalBiggerContext: before.experimentalBiggerContext,
    autoApproveToolCalls: before.autoApproveToolCalls,
    controlToken: before.controlToken,
    responsesToken: before.responsesToken,
    runtimeCommand: before.runtimeCommand,
    tunnel: before.tunnel,
  }) !== JSON.stringify({
    mode: after.mode,
    subagentProtocol: after.subagentProtocol,
    releaseVersion: after.releaseVersion,
    host: after.host,
    port: after.port,
    contextWindow: after.contextWindow,
    appName: after.appName,
    browserHost: after.browserHost,
    browserHostDescriptorPath: after.browserHostDescriptorPath,
    chromeExecutablePath: after.chromeExecutablePath,
    storageStatePath: after.storageStatePath,
    brokerSocketPath: after.brokerSocketPath,
    headed: after.headed,
    solAvailable: after.solAvailable,
    proAvailable: after.proAvailable,
    experimentalBiggerContext: after.experimentalBiggerContext,
    autoApproveToolCalls: after.autoApproveToolCalls,
    controlToken: after.controlToken,
    responsesToken: after.responsesToken,
    runtimeCommand: after.runtimeCommand,
    tunnel: after.tunnel,
  });
}

export function tunnelWorkerRuntimeChanged(before: AppConfig | undefined, after: AppConfig): boolean {
  if (!before || before.mode !== "full" || after.mode !== "full") return false;
  return before.releaseVersion !== after.releaseVersion
    || JSON.stringify(before.runtimeCommand) !== JSON.stringify(after.runtimeCommand)
    || before.brokerSocketPath !== after.brokerSocketPath;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveAvailable, rejectAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", error => rejectAvailable(new Error(`Cannot bind ${host}:${port}: ${error.message}`)));
    server.listen(port, host, () => server.close(error => error ? rejectAvailable(error) : resolveAvailable()));
  });
}

export function setupProxyIsReady(
  health: Record<string, unknown>,
  config: Pick<AppConfig, "mode" | "releaseVersion">,
): boolean {
  return health.service === "codex-chatgpt-web"
    && health.status === "ok"
    && health.mode === config.mode
    && health.version === config.releaseVersion
    && health.accepting_turns === true;
}

async function waitForProxy(config: AppConfig, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        if (setupProxyIsReady(body, config)) return;
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(requestTimeout);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`Responses proxy did not become ready: ${lastError}`);
}

function baseConfig(existing: AppConfig | undefined, options: SetupOptions): AppConfig {
  const config = existing ? structuredClone(existing) : defaultConfig(options.mode);
  config.mode = options.mode;
  if (options.subagentProtocol) config.subagentProtocol = options.subagentProtocol;
  config.releaseVersion = VERSION;
  config.runtimeCommand = currentRuntimeCommand();
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
    config.port = options.port;
  }
  if (options.chromeExecutablePath) config.chromeExecutablePath = options.chromeExecutablePath;
  if (options.browserHostDescriptorPath) {
    config.browserHost = "launcher";
    config.browserHostDescriptorPath = options.browserHostDescriptorPath;
    config.brokerSocketPath = defaultBrokerEndpoint();
  } else if (options.chromeExecutablePath) {
    config.browserHost = "managed-chrome";
    delete config.browserHostDescriptorPath;
  }
  config.appName = resolveSetupConnectorName(existing?.appName, options.appName);
  if (options.autoApproveToolCalls !== undefined) config.autoApproveToolCalls = options.autoApproveToolCalls;
  if (options.experimentalBiggerContext !== undefined) {
    config.experimentalBiggerContext = options.experimentalBiggerContext;
  }
  if (options.acknowledgedUnofficial) config.acknowledgedUnofficialAt = new Date().toISOString();
  if (!config.acknowledgedUnofficialAt) {
    throw new Error("Setup requires explicit acknowledgement that this is unofficial browser automation. Pass --acknowledge-unofficial.");
  }
  return config;
}

async function inspectLauncherCapabilities(
  config: AppConfig,
  existing: AppConfig | undefined,
  refreshAccountCapabilities: boolean,
  expectedProfile: "production" | "development",
): Promise<{ solAvailable: boolean; proAvailable: boolean }> {
  const detectCapabilities = launcherCapabilityProbeRequired(existing, refreshAccountCapabilities);
  const inspected = await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, {
    detectCapabilities,
    expectedProfile,
  });
  return {
    solAvailable: detectCapabilities ? inspected.solAvailable === true : existing!.solAvailable,
    proAvailable: detectCapabilities ? inspected.proAvailable === true : existing!.proAvailable,
  };
}

async function configureTunnel(config: AppConfig, existing: AppConfig | undefined, options: SetupOptions): Promise<void> {
  if (config.mode === "browser-only") {
    delete config.tunnel;
    return;
  }
  const existingTunnel = existing?.mode === "full" ? existing.tunnel : undefined;
  const tunnelId = options.tunnelId ?? existingTunnel?.tunnelId;
  if (!tunnelId) {
    throw new Error("Full mode requires --tunnel-id. Create it at https://platform.openai.com/settings/organization/tunnels");
  }
  let runtimeKeyFile = existingTunnel?.runtimeKeyFile;
  if (!runtimeKeyFile && existsSync(managedRuntimeKeyPath())) runtimeKeyFile = managedRuntimeKeyPath();
  if (options.runtimeKeyFile) runtimeKeyFile = installRuntimeKey(options.runtimeKeyFile);
  if (options.runtimeKeyValue) runtimeKeyFile = installRuntimeKeyBytes(options.runtimeKeyValue);
  if (!runtimeKeyFile || !existsSync(runtimeKeyFile)) {
    throw new Error("Full mode requires a runtime key. Import it interactively or pass --runtime-key-file; create it at https://platform.openai.com/settings/organization/api-keys");
  }
  const installedBinary = await installTunnelClient();
  config.tunnel = createTunnelConfig({
    binaryPath: installedBinary,
    tunnelId,
    runtimeKeyFile,
    profileName: existingTunnel?.profileName,
    alias: existingTunnel?.alias,
  });
}

async function bootstrapTunnelProfile(config: AppConfig): Promise<void> {
  let bootstrapError: unknown;
  try {
    // `runtimes connect` writes the native profile and returns once its managed runtime is healthy.
    // Readiness follows after a successful control-plane poll, so setup proves it separately before
    // stopping the validation runtime. The launcher supervisor reconnects the committed profile.
    connectTunnel(config);
    const status = await waitForTunnelReady(config);
    if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
  } catch (error) {
    bootstrapError = error;
  }
  try {
    stopTunnel(config);
  } catch (stopError) {
    if (bootstrapError) {
      const primary = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
      const cleanup = stopError instanceof Error ? stopError.message : String(stopError);
      throw new Error(`${primary}; temporary tunnel cleanup also failed: ${cleanup}`);
    }
    throw stopError;
  }
  if (bootstrapError) throw bootstrapError;
}

interface TerminalSetupRollbackOperations {
  getServiceStatus: typeof getServiceStatus;
  uninstallService: typeof uninstallService;
  installService: typeof installService;
  stopService: typeof stopService;
  waitForProxy: typeof waitForProxy;
  getTunnelServiceStatus: typeof getTunnelServiceStatus;
  uninstallTunnelService: typeof uninstallTunnelService;
  stopTunnel: typeof stopTunnel;
  bootstrapTunnelProfile: typeof bootstrapTunnelProfile;
  installTunnelService: typeof installTunnelService;
  stopTunnelService: typeof stopTunnelService;
  waitForTunnelReady: typeof waitForTunnelReady;
  restoreApplicationConfig: (snapshot: FileSnapshot) => void;
}

const terminalSetupRollbackOperations: TerminalSetupRollbackOperations = {
  getServiceStatus,
  uninstallService,
  installService,
  stopService,
  waitForProxy,
  getTunnelServiceStatus,
  uninstallTunnelService,
  stopTunnel,
  bootstrapTunnelProfile,
  installTunnelService,
  stopTunnelService,
  waitForTunnelReady,
  restoreApplicationConfig: restoreFileSnapshot,
};

/**
 * Restore the terminal-owned runtime after setup has changed its on-disk config or launchd
 * services but has not committed the matching Codex route. Candidate runtimes are stopped while
 * their capability is still on disk; only then is the previous config restored and its services
 * explicitly reinstalled.
 */
export async function restoreTerminalSetupAfterFailure(
  state: {
    existing: AppConfig | undefined;
    candidate: AppConfig;
    priorConfigSnapshot: FileSnapshot;
    beforeService: ReturnType<typeof getServiceStatus>;
    beforeTunnelService: ReturnType<typeof getTunnelServiceStatus>;
    candidateServiceStarted: boolean;
    tunnelMutationStarted: boolean;
  },
  operations: TerminalSetupRollbackOperations = terminalSetupRollbackOperations,
): Promise<void> {
  const failures: string[] = [];
  const attempt = async (label: string, action: () => unknown | Promise<unknown>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  // If restart never completed and the old service is still loaded, keep it alive. Otherwise,
  // remove the candidate definition/runtime before replacing the capability-bearing app config.
  let responseRuntimeStopped = true;
  try {
    const current = operations.getServiceStatus();
    const currentIsCandidateOrPartial = state.candidateServiceStarted
      || (!state.beforeService.loaded && (current.installed || current.loaded))
      || (state.beforeService.loaded && !current.loaded && current.installed);
    if (currentIsCandidateOrPartial) {
      responseRuntimeStopped = await attempt(
        "stop candidate Responses service",
        () => operations.uninstallService(
          state.candidateServiceStarted ? state.candidate : (state.existing ?? state.candidate),
        ),
      );
    }
  } catch (error) {
    responseRuntimeStopped = false;
    failures.push(`inspect candidate Responses service: ${error instanceof Error ? error.message : String(error)}`);
  }

  let tunnelRuntimeStopped = true;
  if (state.tunnelMutationStarted) {
    try {
      const current = operations.getTunnelServiceStatus();
      if (current.installed || current.loaded) {
        tunnelRuntimeStopped = await attempt(
          "stop candidate tunnel service",
          () => operations.uninstallTunnelService(),
        );
      }
    } catch (error) {
      tunnelRuntimeStopped = false;
      failures.push(`inspect candidate tunnel service: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (state.candidate.mode === "full") {
      const stopped = await attempt(
        "stop candidate tunnel runtime",
        () => operations.stopTunnel(state.candidate),
      );
      tunnelRuntimeStopped = tunnelRuntimeStopped && stopped;
    }
  }

  if (!responseRuntimeStopped || !tunnelRuntimeStopped) {
    throw new Error(failures.join("; "));
  }

  const configRestored = await attempt(
    "restore previous application config",
    () => operations.restoreApplicationConfig(state.priorConfigSnapshot),
  );
  if (!configRestored) throw new Error(failures.join("; "));

  let previousServiceInstalled = true;
  if (state.beforeService.installed || state.beforeService.loaded) {
    if (!state.existing) {
      failures.push("restore previous Responses service: previous application config is unavailable");
      previousServiceInstalled = false;
    } else {
      previousServiceInstalled = await attempt(
        "restore previous Responses service",
        () => operations.installService(state.existing!),
      );
      if (previousServiceInstalled) {
        await attempt(
          "verify previous Responses service",
          () => operations.waitForProxy(state.existing!),
        );
      }
    }
  }

  let tunnelProfileRestored = true;
  if (state.tunnelMutationStarted && state.existing?.mode === "full") {
    tunnelProfileRestored = await attempt(
      "restore previous tunnel profile",
      () => operations.bootstrapTunnelProfile(state.existing!),
    );
  }

  let previousTunnelServiceInstalled = true;
  if (state.beforeTunnelService.installed || state.beforeTunnelService.loaded) {
    if (state.existing?.mode !== "full" || !tunnelProfileRestored) {
      failures.push("restore previous tunnel service: previous full-mode profile is unavailable");
      previousTunnelServiceInstalled = false;
    } else {
      previousTunnelServiceInstalled = await attempt(
        "restore previous tunnel service",
        () => operations.installTunnelService(state.existing!),
      );
      if (previousTunnelServiceInstalled) {
        await attempt("verify previous tunnel service", async () => {
          const status = await operations.waitForTunnelReady(state.existing!);
          if (!status.ok) throw new Error(status.detail);
        });
      }
    }
  }

  // install* intentionally starts launchd jobs. Return jobs that were previously installed but
  // unloaded to that exact state only after all dependent recovery checks have completed.
  if (previousTunnelServiceInstalled && state.beforeTunnelService.installed && !state.beforeTunnelService.loaded) {
    await attempt("restore previous tunnel service unloaded state", () => operations.stopTunnelService());
  }
  if (previousServiceInstalled && state.beforeService.installed && !state.beforeService.loaded && state.existing) {
    await attempt(
      "restore previous Responses service unloaded state",
      () => operations.stopService(state.existing!),
    );
  }

  if (failures.length > 0) throw new Error(failures.join("; "));
}

export async function setup(options: SetupOptions): Promise<SetupResult> {
  const priorConfigSnapshot = snapshotApplicationConfig();
  const existing = loadExistingConfig();
  const configMigrationRequired = existing ? configWasMigratedForSetup(existing) : false;
  if (existing?.purpose === DEV_CONFIG_PURPOSE) {
    throw new Error("A DEV harness configuration cannot be installed into Codex");
  }
  const config = baseConfig(existing, {
    ...options,
    subagentProtocol: options.subagentProtocol
      ?? readCodexSubagentProtocol(existing?.subagentProtocol ?? "compatibility-v1"),
  });
  delete config.purpose;
  const launcherOwned = config.browserHost === "launcher";
  if (!launcherOwned && process.platform !== "darwin") {
    throw new Error(
      "Terminal-only managed Chrome setup currently requires macOS. "
      + "Use the Codex Web GPT launcher on Windows or Linux.",
    );
  }
  preflightCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });
  const refreshTunnelWorker = tunnelWorkerRuntimeChanged(existing, config);
  if (existing && options.restartService) {
    config.controlToken = randomCapabilityToken(config.responsesToken);
  }
  const beforeService = getServiceStatus();
  const beforeTunnelService = getTunnelServiceStatus();
  if (launcherOwned && (beforeService.installed || beforeService.loaded)) {
    if (!existing) {
      throw new Error("A legacy background service exists without a verifiable configuration; refusing automatic migration");
    }
    if (!options.restartService) {
      throw new Error(
        "Launcher ownership migration must stop the legacy background service. "
        + "Retry from the launcher after the active Codex task finishes.",
      );
    }
  }
  if ((beforeService.installed || beforeService.loaded) && !existing) {
    throw new Error("A codex-chatgpt-web service exists but its configuration is missing; refusing to replace an unverifiable service");
  }
  if (beforeService.loaded && !beforeService.installed) {
    throw new Error("The codex-chatgpt-web service is loaded without its launchd definition; refusing a non-restorable setup change");
  }
  if ((beforeTunnelService.installed || beforeTunnelService.loaded) && existing?.mode !== "full") {
    throw new Error("A tunnel service exists without a matching full-mode configuration; refusing to replace an unverifiable service");
  }
  if (beforeTunnelService.loaded && !beforeTunnelService.installed) {
    throw new Error("The tunnel service is loaded without its launchd definition; refusing a non-restorable setup change");
  }

  let loginCreated = false;
  let solAvailable: boolean | undefined;
  let proAvailable: boolean | undefined;
  if (config.browserHost === "launcher") {
    if (options.forceLogin) throw new Error("Launcher browser login is owned by the launcher UI; --login cannot replace it");
    const capabilities = await inspectLauncherCapabilities(
      config,
      existing,
      options.refreshAccountCapabilities === true,
      "production",
    );
    solAvailable = capabilities.solAvailable;
    proAvailable = capabilities.proAvailable;
  } else {
    const stored = storedBrowserLoginCapabilities(config);
    solAvailable = stored.solAvailable;
    proAvailable = stored.proAvailable;
    const loginRequired = options.forceLogin || !browserLoginStateExists(config);
    const capabilityProbeRequired = !loginRequired
      && (options.refreshAccountCapabilities === true
        || solAvailable === undefined
        || proAvailable === undefined);
    if (beforeService.loaded && (loginRequired || capabilityProbeRequired) && !options.restartService) {
      throw new Error(
        "Setup must verify the browser account before changing the running daemon. "
        + "Rerun from a normal terminal with --restart-service after the active task finishes.",
      );
    }
    if (beforeService.loaded && (loginRequired || capabilityProbeRequired) && existing) await assertServiceIdle(existing);
    if (loginRequired) {
      const login = await loginToChatGpt(config);
      solAvailable = login.solAvailable;
      proAvailable = login.proAvailable;
      loginCreated = true;
    } else if (capabilityProbeRequired) {
      const inspected = await inspectBrowserLoginCapabilities(config);
      solAvailable = inspected.solAvailable;
      proAvailable = inspected.proAvailable;
    }
  }
  config.solAvailable = solAvailable === true;
  config.proAvailable = config.solAvailable && proAvailable === true;
  const explicitTunnelChange = Boolean(options.tunnelId || options.runtimeKeyFile || options.runtimeKeyValue);
  const preliminaryChange = Boolean(existing && (
    configMigrationRequired
    || meaningfulRuntimeChange(existing, config)
    || explicitTunnelChange
    || options.forceLogin
  ));
  if (beforeService.loaded && preliminaryChange && !options.restartService) {
    throw new Error(
      "The daemon is currently serving a Codex task and setup would change its runtime. "
      + "Rerun from a normal terminal with --restart-service after the active task finishes.",
    );
  }
  if (beforeService.loaded && preliminaryChange && existing) await assertServiceIdle(existing);
  await configureTunnel(config, existing, options);

  const changedWhileLoaded = Boolean(existing && beforeService.loaded && (
    configMigrationRequired || meaningfulRuntimeChange(existing, config)
  ));
  if (changedWhileLoaded && !options.restartService) {
    throw new Error(
      "The daemon is currently serving a Codex task and setup would change its runtime. "
      + "Rerun from a normal terminal with --restart-service after the active task finishes.",
    );
  }
  if (changedWhileLoaded && !preliminaryChange && existing) await assertServiceIdle(existing);
  if (!beforeService.loaded) await assertPortAvailable(config.host, config.port);

  let tunnelReady: boolean | null = null;
  let candidateServiceStarted = false;
  let tunnelMutationStarted = false;
  try {
    if (!launcherOwned) {
      saveConfig(config);
      const installed = installService(config);
      candidateServiceStarted = !beforeService.loaded && installed.loaded;
      if (changedWhileLoaded && options.restartService && existing) {
        await restartService(existing);
        candidateServiceStarted = true;
      }
      await waitForProxy(config);
    }

    if (config.mode === "browser-only" && existing?.mode === "full") {
      tunnelMutationStarted = !launcherOwned;
      const previousTunnelService = getTunnelServiceStatus();
      if (previousTunnelService.installed || previousTunnelService.loaded) await uninstallTunnelService();
      stopTunnel(existing);
    }
    if (config.mode === "full") {
      const profilePath = join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`);
      const tunnelService = getTunnelServiceStatus();
      const needsProfile = !existsSync(profilePath);
      if (launcherOwned) {
        if (tunnelService.installed || tunnelService.loaded) await uninstallTunnelService();
        if (needsProfile || refreshTunnelWorker || explicitTunnelChange) {
          await bootstrapTunnelProfile(config);
        }
      } else {
        const needsOwnershipMigration = !tunnelService.installed || !tunnelService.loaded || !tunnelServiceDefinitionMatches(config);
        if (needsOwnershipMigration || needsProfile) {
          tunnelMutationStarted = true;
          await assertServiceIdle(config);
          if (tunnelService.loaded) await stopTunnelService();
          await bootstrapTunnelProfile(config);
          installTunnelService(config);
        } else if (refreshTunnelWorker) {
          tunnelMutationStarted = true;
          await assertServiceIdle(config);
          await restartTunnelService();
        }
        const status = await waitForTunnelReady(config);
        if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
        tunnelReady = true;
      }
    }

    if (launcherOwned && (beforeService.installed || beforeService.loaded)) {
      await uninstallService(existing!);
    }

    // A terminal commit must leave the candidate capability on disk if the Codex filesystem
    // transaction fails. The outer compensation can then stop that candidate before restoring the
    // true pre-setup snapshot. Launcher setup has its own supervisor checkpoint and keeps the
    // original all-files snapshot here.
    const commitConfigSnapshot = launcherOwned ? priorConfigSnapshot : snapshotApplicationConfig();
    commitCodexIntegrationAndConfig(config, {
      replaceExistingRoute: options.replaceCodexRoute,
    }, commitConfigSnapshot);
  } catch (error) {
    if (!launcherOwned) {
      try {
        await restoreTerminalSetupAfterFailure({
          existing,
          candidate: config,
          priorConfigSnapshot,
          beforeService,
          beforeTunnelService,
          candidateServiceStarted,
          tunnelMutationStarted,
        });
      } catch (rollbackError) {
        const primary = error instanceof Error ? error.message : String(error);
        const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${primary}; terminal setup rollback also failed: ${rollback}`);
      }
    }
    throw error;
  }

  // Keep the previous terminal runtime intact through the ownership handoff. A later launcher
  // setup removes it once the launcher-owned configuration is already the established baseline.
  // Cleanup deliberately follows the Codex/config commit so a rollback never needs deleted legacy
  // binaries to restart the prior daemon.
  const migratingTerminalRuntime = Boolean(
    launcherOwned && existing && existing.browserHost !== "launcher",
  );
  if (!migratingTerminalRuntime) removeLegacyRuntimeArtifacts(config);

  return {
    mode: config.mode,
    configPath: getConfigPath(),
    loginCreated,
    serviceLoaded: launcherOwned ? false : getServiceStatus().loaded,
    tunnelReady,
    codexRestartRequired: true,
    connectorSetupRequired: config.mode === "full",
  };
}

/**
 * Configure the isolated launcher/browser/tunnel inputs used by the repository DEV harness.
 * This deliberately has no Codex integration, Responses listener, or system service; the DEV
 * launcher supervises only the isolated MCP tunnel after this transaction commits.
 */
export async function setupDevProfile(options: SetupOptions): Promise<DevProfileSetupResult> {
  const existing = loadExistingConfig();
  if (existing && existing.purpose !== DEV_CONFIG_PURPOSE) {
    throw new Error("DEV profile home contains a non-DEV configuration; refusing to repurpose it");
  }
  if (!options.browserHostDescriptorPath) {
    throw new Error("DEV profile setup requires the isolated launcher browser descriptor");
  }
  const config = baseConfig(existing, {
    ...options,
    appName: resolveDevSetupConnectorName(existing?.appName, options.appName),
  });
  if (config.browserHost !== "launcher") {
    throw new Error("DEV profile setup requires the desktop launcher browser host");
  }
  config.purpose = DEV_CONFIG_PURPOSE;
  const capabilities = await inspectLauncherCapabilities(
    config,
    existing,
    options.refreshAccountCapabilities === true,
    DEV_LAUNCHER_PROFILE,
  );
  config.solAvailable = capabilities.solAvailable;
  config.proAvailable = capabilities.solAvailable && capabilities.proAvailable;

  const explicitTunnelChange = Boolean(options.tunnelId || options.runtimeKeyFile || options.runtimeKeyValue);
  await configureTunnel(config, existing, options);
  let tunnelReady: boolean | null = null;
  if (config.mode === "full") {
    config.tunnel!.alias = DEV_TUNNEL_BASE_NAME;
    config.tunnel!.profileName = DEV_TUNNEL_BASE_NAME;
    const profilePath = join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`);
    const needsProfile = !existsSync(profilePath);
    if (needsProfile || tunnelWorkerRuntimeChanged(existing, config) || explicitTunnelChange) {
      await bootstrapTunnelProfile(config);
    }
    tunnelReady = false;
  }
  saveConfig(config);
  return {
    mode: config.mode,
    configPath: getConfigPath(),
    tunnelReady,
    connectorSetupRequired: config.mode === "full",
  };
}
