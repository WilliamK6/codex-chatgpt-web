import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { expandUserPath } from "./config";
import { processRunning } from "./process";

export const LAUNCHER_BROWSER_HOST_KIND = "codex-web-gpt-launcher";
export type LauncherBrowserHostProfile = "production" | "development";

export class LauncherBrowserTurnCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherBrowserTurnCancelledError";
  }
}

export class LauncherRetainedConversationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherRetainedConversationUnavailableError";
  }
}

export interface LauncherBrowserHostDescriptor {
  version: 3;
  kind: typeof LAUNCHER_BROWSER_HOST_KIND;
  profile: LauncherBrowserHostProfile;
  pid: number;
  debug: {
    endpoint: string;
    token: string;
  };
  control: {
    endpoint: string;
    token: string;
  };
  helper: {
    executable: string;
    script: string;
  };
  partition: string;
  idleUrl: string;
  surfaceId: string;
  createdAt: string;
}

export interface LauncherBrowserConnection {
  descriptor: LauncherBrowserHostDescriptor;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

function assertLoopbackEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} is not a valid URL`); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error(`${label} must use http://127.0.0.1`);
  }
  if (!parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must contain only a loopback host and explicit port`);
  }
  return parsed.origin;
}

function assertPrivateDebugEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Launcher private debug endpoint is missing");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Launcher private debug endpoint is not a valid URL"); }
  if (parsed.protocol !== "tcp:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("Launcher private debug endpoint must use tcp://127.0.0.1");
  }
  if (!parsed.port || parsed.username || parsed.password
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.search || parsed.hash) {
    throw new Error("Launcher private debug endpoint must contain only a loopback host and explicit port");
  }
  return `tcp://127.0.0.1:${parsed.port}`;
}

function assertDebugLeaseToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(value)) {
    throw new Error("Launcher private debug lease token is invalid");
  }
  return value;
}

function assertDescriptorShape(value: unknown): LauncherBrowserHostDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser descriptor is not an object");
  }
  const descriptor = value as Partial<LauncherBrowserHostDescriptor>;
  if (descriptor.version !== 3 || descriptor.kind !== LAUNCHER_BROWSER_HOST_KIND) {
    throw new Error("Launcher browser descriptor has an unsupported identity or version");
  }
  if (descriptor.profile !== "production" && descriptor.profile !== "development") {
    throw new Error("Launcher browser descriptor has an invalid profile");
  }
  if (!Number.isInteger(descriptor.pid) || descriptor.pid! < 1) {
    throw new Error("Launcher browser descriptor has an invalid pid");
  }
  if (!descriptor.debug || typeof descriptor.debug !== "object") {
    throw new Error("Launcher browser descriptor is missing its private debug channel");
  }
  const debugEndpoint = assertPrivateDebugEndpoint(descriptor.debug.endpoint);
  if (typeof descriptor.debug.token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(descriptor.debug.token)) {
    throw new Error("Launcher browser descriptor has an invalid private debug token");
  }
  if (!descriptor.control || typeof descriptor.control !== "object") {
    throw new Error("Launcher browser descriptor is missing its control channel");
  }
  const controlEndpoint = assertLoopbackEndpoint(descriptor.control.endpoint, "Launcher control endpoint");
  if (typeof descriptor.control.token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(descriptor.control.token)) {
    throw new Error("Launcher browser descriptor has an invalid control token");
  }
  if (!descriptor.helper || typeof descriptor.helper !== "object") {
    throw new Error("Launcher browser descriptor is missing its Node helper command");
  }
  const helperExecutable = typeof descriptor.helper.executable === "string" ? resolve(descriptor.helper.executable) : "";
  const helperScript = typeof descriptor.helper.script === "string" ? resolve(descriptor.helper.script) : "";
  if (!helperExecutable || !existsSync(helperExecutable)) {
    throw new Error("Launcher browser descriptor helper executable does not exist");
  }
  if (!helperScript || !existsSync(helperScript)) {
    throw new Error("Launcher browser descriptor helper script does not exist");
  }
  const expectedPartition = descriptor.profile === "development"
    ? "persist:codex-web-gpt-dev-chatgpt"
    : "persist:codex-web-gpt-chatgpt";
  if (descriptor.partition !== expectedPartition) {
    throw new Error("Launcher browser descriptor identifies an unexpected browser partition");
  }
  if (descriptor.idleUrl !== "about:blank#codex-web-gpt-browser-host") {
    throw new Error("Launcher browser descriptor identifies an unexpected idle surface");
  }
  if (typeof descriptor.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(descriptor.surfaceId)) {
    throw new Error("Launcher browser descriptor has an invalid owned surface id");
  }
  if (typeof descriptor.createdAt !== "string" || Number.isNaN(Date.parse(descriptor.createdAt))) {
    throw new Error("Launcher browser descriptor has an invalid creation time");
  }
  return {
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: descriptor.profile,
    pid: descriptor.pid!,
    debug: { endpoint: debugEndpoint, token: descriptor.debug.token },
    control: { endpoint: controlEndpoint, token: descriptor.control.token },
    helper: { executable: helperExecutable, script: helperScript },
    partition: descriptor.partition,
    idleUrl: descriptor.idleUrl,
    surfaceId: descriptor.surfaceId,
    createdAt: descriptor.createdAt,
  };
}

export function readLauncherBrowserHostDescriptor(configuredPath: string): LauncherBrowserHostDescriptor {
  const path = resolve(expandUserPath(configuredPath));
  if (!existsSync(path)) throw new Error(`Launcher browser host is unavailable: descriptor is missing at ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Launcher browser descriptor is not a regular file: ${path}`);
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) throw new Error(`Launcher browser descriptor has unsafe permissions: ${path}`);
    const getuid = process.getuid;
    if (typeof getuid === "function" && stat.uid !== getuid()) {
      throw new Error(`Launcher browser descriptor is not owned by the current user: ${path}`);
    }
  }
  let decoded: unknown;
  try { decoded = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    throw new Error(`Launcher browser descriptor is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const descriptor = assertDescriptorShape(decoded);
  if (!processRunning(descriptor.pid)) {
    throw new Error(`Launcher browser host process is not running (pid ${descriptor.pid})`);
  }
  return descriptor;
}

const MAX_DEBUG_FRAME_BYTES = 128 * 1024 * 1024;

export interface LauncherDebugTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  send(message: object): void;
  close(): void;
}

class PrivateLauncherDebugTransport implements LauncherDebugTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private readonly frameHeader = Buffer.alloc(4);
  private frameHeaderBytes = 0;
  private frame: Buffer | null = null;
  private frameBytes = 0;
  private closed = false;
  private ready = false;
  private readonly socket: Socket;
  private readonly abortSignal?: AbortSignal;
  private readonly abortHandler: () => void;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(
    descriptor: LauncherBrowserHostDescriptor,
    surfaceId: string,
    debugLeaseToken: string,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ) {
    const endpoint = new URL(descriptor.debug.endpoint);
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    this.abortSignal = abortSignal;
    this.abortHandler = () => this.failBeforeReady(
      new DOMException("Launcher browser connection aborted", "AbortError"),
    );
    this.socket.setNoDelay(true);
    const timer = setTimeout(
      () => this.failBeforeReady(new Error(`private debug authentication timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    abortSignal?.addEventListener("abort", this.abortHandler, { once: true });
    this.readyPromise.finally(() => {
      clearTimeout(timer);
    }).catch(() => {});
    this.socket.once("connect", () => {
      this.write({
        type: "authenticate",
        token: descriptor.debug.token,
        surfaceId,
        helperPid: process.pid,
        leaseToken: debugLeaseToken,
      });
    });
    this.socket.on("data", chunk => this.handleData(Buffer.from(chunk)));
    this.socket.on("error", error => this.failBeforeReady(
      new Error(`private debug transport failed: ${error instanceof Error ? error.message : String(error)}`),
    ));
    this.socket.on("close", () => {
      if (!this.ready) this.failBeforeReady(new Error("private debug transport closed before authentication"));
      this.finish("private debug transport closed");
    });
    if (abortSignal?.aborted) this.abortHandler();
  }

  async authenticated(): Promise<this> {
    await this.readyPromise;
    return this;
  }

  private write(value: object): void {
    if (this.closed || this.socket.destroyed) return;
    const frame = Buffer.from(JSON.stringify(value));
    if (frame.length > MAX_DEBUG_FRAME_BYTES) {
      this.finish("private debug frame is too large");
      return;
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(frame.length);
    this.socket.cork();
    this.socket.write(header);
    this.socket.write(frame);
    this.socket.uncork();
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.frame) {
        const headerBytes = Math.min(4 - this.frameHeaderBytes, chunk.length - offset);
        chunk.copy(this.frameHeader, this.frameHeaderBytes, offset, offset + headerBytes);
        this.frameHeaderBytes += headerBytes;
        offset += headerBytes;
        if (this.frameHeaderBytes < 4) return;
        const length = this.frameHeader.readUInt32BE(0);
        this.frameHeaderBytes = 0;
        if (length < 1 || length > MAX_DEBUG_FRAME_BYTES) {
          this.finish("private debug frame is too large");
          return;
        }
        this.frame = Buffer.allocUnsafe(length);
        this.frameBytes = 0;
      }
      const frameBytes = Math.min(this.frame.length - this.frameBytes, chunk.length - offset);
      chunk.copy(this.frame, this.frameBytes, offset, offset + frameBytes);
      this.frameBytes += frameBytes;
      offset += frameBytes;
      if (this.frameBytes < this.frame.length) return;
      const frame = this.frame;
      this.frame = null;
      this.frameBytes = 0;
      let message: { type?: unknown; message?: unknown; error?: unknown; reason?: unknown };
      try { message = JSON.parse(frame.toString("utf8")); }
      catch {
        this.finish("private debug transport returned invalid JSON");
        return;
      }
      if (message.type === "ready" && !this.ready) {
        this.ready = true;
        this.resolveReady();
      } else if (message.type === "cdp" && this.ready && message.message && typeof message.message === "object") {
        this.onmessage?.(message.message as object);
      } else if (message.type === "closed") {
        this.finish(typeof message.reason === "string" ? message.reason : "private debug transport closed");
        return;
      } else if (message.type === "error") {
        const detail = typeof message.error === "string" ? message.error : "rejected";
        if (!this.ready) this.failBeforeReady(new Error(`private debug authentication failed: ${detail}`));
        else this.finish(`private debug transport failed: ${detail}`);
        return;
      } else {
        this.finish("private debug transport returned an invalid frame");
        return;
      }
    }
  }

  private failBeforeReady(error: Error): void {
    if (!this.ready) this.rejectReady(error);
    this.finish(error.message);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    if (!this.ready) this.rejectReady(new Error(reason));
    this.closed = true;
    this.abortSignal?.removeEventListener("abort", this.abortHandler);
    if (!this.socket.destroyed) this.socket.destroy();
    queueMicrotask(() => this.onclose?.(reason));
  }

  send(message: object): void {
    if (!this.ready || this.closed) throw new Error("Launcher private debug transport is not connected");
    this.write({ type: "cdp", message });
  }

  close(): void {
    this.finish("closed");
  }
}

export async function connectLauncherDebugTransport(
  descriptor: LauncherBrowserHostDescriptor,
  surfaceId: string,
  debugLeaseToken: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<LauncherDebugTransport> {
  const leaseToken = assertDebugLeaseToken(debugLeaseToken);
  return await new PrivateLauncherDebugTransport(
    descriptor,
    surfaceId,
    leaseToken,
    timeoutMs,
    abortSignal,
  ).authenticated();
}

export async function selectLauncherPage(
  browser: Browser,
  descriptor: LauncherBrowserHostDescriptor,
  timeoutMs: number,
  surfaceId = descriptor.surfaceId,
  abortSignal?: AbortSignal,
): Promise<{ context: BrowserContext; page: Page }> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const candidates = browser.contexts().flatMap(context => context.pages().map(page => ({ context, page })));
    const inspected = await Promise.all(candidates.map(async candidate => ({
      ...candidate,
      surfaceId: await candidate.page.evaluate(
        () => (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: unknown })
          .__CODEX_WEB_GPT_SURFACE_ID__,
      ).catch(() => undefined),
    })));
    const owned = inspected.filter(candidate => candidate.surfaceId === surfaceId);
    if (owned.length === 1) {
      return { context: owned[0].context, page: owned[0].page };
    }
    if (owned.length > 1) {
      throw new Error(`Launcher browser host exposed ${owned.length} surfaces with the same ownership id`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Launcher browser host did not expose its owned browser surface");
}

export async function connectLauncherBrowserHost(
  descriptorPath: string,
  timeoutMs = 20_000,
  surfaceId?: string,
  debugLeaseToken?: string,
  abortSignal?: AbortSignal,
): Promise<LauncherBrowserConnection> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const requestedSurfaceId = surfaceId ?? descriptor.surfaceId;
  const authenticationTimeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, 5_000) : 5_000;
  const transport = await connectLauncherDebugTransport(
    descriptor,
    requestedSurfaceId,
    assertDebugLeaseToken(debugLeaseToken),
    authenticationTimeoutMs,
    abortSignal,
  );
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(transport, { timeout: timeoutMs, isLocal: true });
  } catch (error) {
    transport.close();
    throw new Error(`Could not connect Playwright to the launcher browser: ${error instanceof Error ? error.message : String(error)}`);
  }
  const closeOnAbort = () => { void browser.close().catch(() => {}); };
  abortSignal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const { context, page } = await selectLauncherPage(
      browser,
      descriptor,
      timeoutMs,
      requestedSurfaceId,
      abortSignal,
    );
    return { descriptor, browser, context, page };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", closeOnAbort);
  }
}

export async function inspectLauncherBrowserHost(
  descriptorPath: string,
  options: {
    detectCapabilities?: boolean;
    expectedProfile?: LauncherBrowserHostProfile;
    timeoutMs?: number;
  } = {},
): Promise<{ solAvailable?: boolean; proAvailable?: boolean; url: string }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(
      `Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`,
    );
  }
  const timeoutMs = options.timeoutMs ?? (options.detectCapabilities
    ? LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS
    : LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/session/inspect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ detectCapabilities: options.detectCapabilities === true }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    if (body.authenticated !== true || body.temporary !== true || typeof body.url !== "string") {
      throw new Error("Launcher returned invalid ChatGPT session evidence");
    }
    if (options.detectCapabilities
      && (typeof body.solAvailable !== "boolean" || typeof body.proAvailable !== "boolean")) {
      throw new Error("Launcher did not return complete ChatGPT account capability evidence");
    }
    if (options.detectCapabilities && body.proAvailable === true && body.solAvailable !== true) {
      throw new Error("Launcher returned contradictory ChatGPT account capability evidence");
    }
    return {
      url: body.url,
      ...(options.detectCapabilities ? {
        solAvailable: body.solAvailable as boolean,
        proAvailable: body.proAvailable as boolean,
      } : {}),
    };
  } catch (error) {
    const detail = timedOut
      ? `session inspection timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
    throw new Error(`Launcher ChatGPT session could not be verified: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export const LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS = 30_000;
export const LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS = 120_000;

export type LauncherTurnActivity =
  | {
      phase: "start";
      traceId: string;
      helperPid: number;
      conversationKey?: string;
      connectorIdentity?: string;
      requireRetainedConversation?: boolean;
    }
  | { phase: "heartbeat"; traceId: string; helperPid: number }
  | {
      phase: "end";
      traceId: string;
      helperPid: number;
      status: "completed" | "failed" | "aborted";
      message?: string;
      retain?: boolean;
      connectorBound?: boolean;
    };

export const LAUNCHER_TURN_START_TIMEOUT_MS = 5_000;
export const LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS = 10_000;
export const LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS = 5_000;
export const LAUNCHER_TURN_END_TIMEOUT_MS = 15_000;

export async function notifyLauncherTurn(
  descriptorPath: string,
  activity: LauncherTurnActivity,
  timeoutMs = activity.phase === "end"
    ? LAUNCHER_TURN_END_TIMEOUT_MS
    : activity.phase === "heartbeat"
      ? LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS
      : LAUNCHER_TURN_START_TIMEOUT_MS,
): Promise<{
  surfaceId?: string;
  debugLeaseToken?: string;
  reused?: boolean;
  connectorBound?: boolean;
  cancelledByUser?: boolean;
}> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/turn/${activity.phase}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(activity),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.status === 409 && body.code === "turn_cancelled") {
        throw new LauncherBrowserTurnCancelledError(
          typeof body.error === "string" ? body.error : `Browser turn ${activity.traceId} was cancelled by the user`,
        );
      }
      if (response.status === 409 && body.code === "retained_conversation_unavailable") {
        throw new LauncherRetainedConversationUnavailableError(
          typeof body.error === "string" ? body.error : "The retained ChatGPT conversation is no longer available",
        );
      }
      const detail = typeof body.error === "string" ? body.error : "";
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (activity.phase === "start") {
      if (typeof body.surfaceId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.surfaceId)) {
        throw new Error("Launcher browser control channel returned an invalid turn surface id");
      }
      if (typeof body.reused !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid reuse state");
      }
      if (typeof body.connectorBound !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid connector state");
      }
      if (typeof body.debugLeaseToken !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(body.debugLeaseToken)) {
        throw new Error("Launcher browser control channel returned an invalid private debug lease");
      }
      return {
        surfaceId: body.surfaceId,
        debugLeaseToken: body.debugLeaseToken,
        reused: body.reused,
        connectorBound: body.connectorBound,
      };
    }
    if (activity.phase === "end") {
      if (typeof body.cancelledByUser !== "boolean") {
        throw new Error("Launcher browser control channel returned an invalid turn release result");
      }
      return { cancelledByUser: body.cancelledByUser };
    }
    return {};
  } catch (error) {
    if (error instanceof LauncherBrowserTurnCancelledError
      || error instanceof LauncherRetainedConversationUnavailableError) throw error;
    throw new Error(`Launcher browser control channel failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function releaseLauncherRetainedConversation(
  descriptorPath: string,
  conversationKey: string,
  timeoutMs = LAUNCHER_TURN_END_TIMEOUT_MS,
): Promise<number> {
  if (!/^[a-f0-9]{64}$/.test(conversationKey)) {
    throw new Error("Launcher retained conversation key is invalid");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationKey }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || !Number.isSafeInteger(body.released) || Number(body.released) < 0) {
      const detail = typeof body.error === "string" ? `: ${body.error}` : "";
      throw new Error(`HTTP ${response.status}${detail}`);
    }
    return Number(body.released);
  } catch (error) {
    throw new Error(`Launcher retained conversation release failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
