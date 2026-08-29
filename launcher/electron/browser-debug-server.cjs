const { randomBytes, timingSafeEqual } = require("node:crypto");
const net = require("node:net");

// A valid 50 MB image upload expands to roughly 67 MB when Playwright base64-encodes it in CDP.
// Leave enough room for the JSON envelope and future protocol overhead without making frames
// unbounded.
const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const MAX_AUTH_FRAME_BYTES = 4 * 1024;
const MAX_CONNECTIONS = 32;
const AUTH_TIMEOUT_MS = 5_000;
const CDP_VERSION = "1.3";
const ALLOWED_ROOT_METHODS = new Set([
  "Browser.getVersion",
]);
const ALLOWED_PAGE_BROWSER_METHODS = new Set([
  "Browser.getWindowBounds",
  "Browser.getWindowForTarget",
]);
const BLOCKED_GLOBAL_DOMAINS = new Set([
  "Autofill",
  "CacheStorage",
  "Database",
  "DeviceAccess",
  "DOMStorage",
  "Extensions",
  "FedCm",
  "IndexedDB",
  "Memory",
  "PWA",
  "Security",
  "ServiceWorker",
  "Storage",
  "SystemInfo",
  "Tethering",
  "Tracing",
  "WebAuthn",
]);
const BLOCKED_GLOBAL_NETWORK_METHODS = new Set([
  "Network.clearBrowserCache",
  "Network.clearBrowserCookies",
  "Network.deleteCookies",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
]);

function tokenMatches(expected, supplied) {
  if (typeof supplied !== "string") return false;
  const actual = Buffer.from(supplied);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function protocolError(error) {
  return {
    code: Number.isInteger(error?.code) ? error.code : -32_000,
    message: error instanceof Error ? error.message : String(error),
  };
}

class BrowserDebugConnection {
  constructor({ socket, token, getBrowserHost, logger, claimSurface, onClose }) {
    this.socket = socket;
    this.token = token;
    this.getBrowserHost = getBrowserHost;
    this.logger = logger;
    this.claimSurface = claimSurface;
    this.onClose = onClose;
    this.frameHeader = Buffer.alloc(4);
    this.frameHeaderBytes = 0;
    this.frame = null;
    this.frameBytes = 0;
    this.authorized = false;
    this.authenticating = false;
    this.closed = false;
    this.debuggerApi = null;
    this.contents = null;
    this.surfaceId = null;
    this.helperPid = null;
    this.leaseToken = null;
    this.pageSessionId = null;
    this.targetInfo = null;
    this.pageAttached = false;
    this.childSessions = new Map();
    this.authTimer = setTimeout(() => this.rejectAndClose("authentication_timeout"), AUTH_TIMEOUT_MS);
    this.authTimer.unref?.();
    socket.setNoDelay(true);
    socket.on("data", chunk => this.onData(Buffer.from(chunk)));
    socket.on("error", error => {
      if (!this.closed) {
        this.logger.warn("browser.debug_connection_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      this.close();
    });
    socket.on("close", () => this.close());
  }

  write(value) {
    if (this.closed || this.socket.destroyed) return;
    const encoded = Buffer.from(JSON.stringify(value));
    if (encoded.length > MAX_FRAME_BYTES) {
      this.rejectAndClose("frame_too_large");
      return;
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(encoded.length);
    this.socket.cork();
    this.socket.write(header);
    this.socket.write(encoded);
    this.socket.uncork();
  }

  rejectAndClose(reason = "unauthorized") {
    if (!this.closed && !this.socket.destroyed) {
      this.write({ type: "error", error: reason });
    }
    this.socket.destroy();
    this.close();
  }

  onData(chunk) {
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
        const frameLimit = this.authorized ? MAX_FRAME_BYTES : MAX_AUTH_FRAME_BYTES;
        if (length < 1 || length > frameLimit) {
          this.rejectAndClose("frame_too_large");
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
      let message;
      try { message = JSON.parse(frame.toString("utf8")); }
      catch {
        this.rejectAndClose("invalid_frame");
        return;
      }
      if (!this.authorized) {
        if (this.authenticating) {
          this.rejectAndClose("authentication_in_progress");
          return;
        }
        this.authenticating = true;
        void this.authenticate(message);
        if (offset < chunk.length) this.rejectAndClose("authentication_in_progress");
        return;
      }
      if (!message || message.type !== "cdp" || !message.message || typeof message.message !== "object") {
        this.rejectAndClose("invalid_frame");
        return;
      }
      void this.handleCommand(message.message);
    }
  }

  async authenticate(message) {
    if (!message
      || message.type !== "authenticate"
      || !tokenMatches(this.token, message.token)
      || typeof message.surfaceId !== "string"
      || !/^[A-Za-z0-9_-]{32}$/.test(message.surfaceId)
      || !Number.isInteger(message.helperPid)
      || message.helperPid < 1
      || typeof message.leaseToken !== "string"
      || !/^[A-Za-z0-9_-]{40,}$/.test(message.leaseToken)) {
      this.rejectAndClose();
      return;
    }
    try {
      const host = this.getBrowserHost();
      if (!host) throw new Error("browser host is unavailable");
      const contents = host.resolveDebugSurface(message.surfaceId, message.helperPid, message.leaseToken);
      if (!contents || contents.isDestroyed()) throw new Error("browser surface is unavailable");
      this.contents = contents;
      this.surfaceId = message.surfaceId;
      this.helperPid = message.helperPid;
      this.leaseToken = message.leaseToken;
      this.claimSurface(contents, this);
      this.debuggerApi = contents.debugger;
      this.debuggerApi.attach(CDP_VERSION);
      this.debuggerApi.on("message", this.onDebuggerMessage);
      this.debuggerApi.once("detach", this.onDebuggerDetach);
      const result = await this.debuggerApi.sendCommand("Target.getTargetInfo");
      if (this.closed) throw new Error("debug connection closed during authentication");
      if (!result?.targetInfo || typeof result.targetInfo.targetId !== "string") {
        throw new Error("browser surface target metadata is unavailable");
      }
      this.targetInfo = result.targetInfo;
      this.pageSessionId = `authorized-page-${randomBytes(12).toString("base64url")}`;
      this.authorized = true;
      this.authenticating = false;
      clearTimeout(this.authTimer);
      this.write({ type: "ready" });
      this.logger.info("browser.debug_authorized", { helperPid: message.helperPid });
    } catch (error) {
      this.authenticating = false;
      this.logger.warn("browser.debug_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.rejectAndClose();
    }
  }

  onDebuggerMessage = (_event, method, params, sessionId) => {
    if (!this.authorized || this.closed) return;
    if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") {
      this.childSessions.set(params.sessionId, sessionId || this.pageSessionId);
    } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
      this.childSessions.delete(params.sessionId);
    }
    this.write({
      type: "cdp",
      message: {
        method,
        params: params || {},
        sessionId: sessionId || this.pageSessionId,
      },
    });
  };

  onDebuggerDetach = (_event, reason) => {
    if (this.closed) return;
    this.write({ type: "closed", reason: reason || "debugger_detached" });
    this.socket.destroy();
    this.close();
  };

  sendResult(command, result) {
    this.write({
      type: "cdp",
      message: {
        id: command.id,
        result: result || {},
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      },
    });
  }

  sendProtocolError(command, error) {
    this.write({
      type: "cdp",
      message: {
        id: command.id,
        error: protocolError(error),
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      },
    });
  }

  async handleCommand(command) {
    if (!this.authorized || this.closed || !this.debuggerApi) return;
    if (!Number.isInteger(command.id) || typeof command.method !== "string" || !command.method) {
      this.rejectAndClose("invalid_cdp_message");
      return;
    }
    try {
      const host = this.getBrowserHost();
      if (!host) throw new Error("browser host is unavailable");
      let currentContents;
      try {
        currentContents = host.resolveDebugSurface(this.surfaceId, this.helperPid, this.leaseToken);
      } catch {
        this.rejectAndClose("lease_expired");
        return;
      }
      if (currentContents !== this.contents || !currentContents || currentContents.isDestroyed()) {
        this.rejectAndClose("lease_expired");
        return;
      }
      if (!command.sessionId && command.method === "Target.setAutoAttach") {
        this.sendResult(command, {});
        if (!this.pageAttached) {
          this.pageAttached = true;
          this.write({
            type: "cdp",
            message: {
              method: "Target.attachedToTarget",
              params: {
                sessionId: this.pageSessionId,
                targetInfo: { ...this.targetInfo, attached: true },
                waitingForDebugger: false,
              },
            },
          });
        }
        return;
      }
      if (!command.sessionId && command.method === "Target.getTargetInfo") {
        this.sendResult(command, { targetInfo: this.targetInfo });
        return;
      }
      if (command.sessionId === this.pageSessionId && command.method === "Target.getTargetInfo") {
        this.sendResult(command, { targetInfo: this.targetInfo });
        return;
      }
      // Playwright sends this browser-global bootstrap command even for a custom CDP transport.
      // The bridge never downloads browser artifacts, so acknowledge the client preference without
      // mutating other Electron surfaces that share the embedded browser process.
      if (!command.sessionId && command.method === "Browser.setDownloadBehavior") {
        this.sendResult(command, {});
        return;
      }
      if (command.method.startsWith("Target.")) {
        const allowedAutoAttach = command.method === "Target.setAutoAttach" && Boolean(command.sessionId);
        const detachSessionId = command.params?.sessionId;
        const allowedChildDetach = command.method === "Target.detachFromTarget"
          && typeof command.sessionId === "string"
          && typeof detachSessionId === "string"
          && this.childSessions.get(detachSessionId) === command.sessionId;
        if (!allowedAutoAttach && !allowedChildDetach) {
          throw new Error(`Target command is unavailable on the private surface: ${command.method}`);
        }
      } else if (!command.sessionId && !ALLOWED_ROOT_METHODS.has(command.method)) {
        throw new Error(`Root CDP command is unavailable on the private surface: ${command.method}`);
      } else if (command.method.startsWith("Browser.")) {
        const allowed = !command.sessionId
          ? ALLOWED_ROOT_METHODS.has(command.method)
          : command.sessionId === this.pageSessionId && ALLOWED_PAGE_BROWSER_METHODS.has(command.method);
        if (!allowed) throw new Error(`Browser command is unavailable on the private surface: ${command.method}`);
      } else if (BLOCKED_GLOBAL_NETWORK_METHODS.has(command.method)) {
        throw new Error(`Browser-global Network command is unavailable on the private surface: ${command.method}`);
      } else if (BLOCKED_GLOBAL_DOMAINS.has(command.method.split(".", 1)[0])) {
        throw new Error(`Browser-global command is unavailable on the private surface: ${command.method}`);
      }
      let debuggerSessionId;
      if (command.sessionId) {
        if (command.sessionId === this.pageSessionId) debuggerSessionId = undefined;
        else if (this.childSessions.has(command.sessionId)) debuggerSessionId = command.sessionId;
        else throw new Error("CDP session is outside the authorized browser surface");
      }
      const result = await this.debuggerApi.sendCommand(
        command.method,
        command.params && typeof command.params === "object" ? command.params : {},
        debuggerSessionId,
      );
      this.sendResult(command, result);
    } catch (error) {
      this.sendProtocolError(command, error);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    if (this.debuggerApi) {
      this.debuggerApi.off("message", this.onDebuggerMessage);
      this.debuggerApi.off("detach", this.onDebuggerDetach);
      try {
        if (this.debuggerApi.isAttached()) this.debuggerApi.detach();
      } catch {}
    }
    if (!this.socket.destroyed) this.socket.destroy();
    this.onClose(this);
  }
}

class BrowserDebugServer {
  constructor({ logger, getBrowserHost }) {
    this.logger = logger;
    this.getBrowserHost = getBrowserHost;
    this.token = randomBytes(32).toString("base64url");
    this.port = 0;
    this.connections = new Set();
    this.surfaceConnections = new WeakMap();
    this.server = net.createServer(socket => {
      const connection = new BrowserDebugConnection({
        socket,
        token: this.token,
        getBrowserHost: this.getBrowserHost,
        logger: this.logger,
        claimSurface: (contents, next) => {
          const current = this.surfaceConnections.get(contents);
          if (current && current !== next) current.close();
          this.surfaceConnections.set(contents, next);
        },
        onClose: closed => {
          this.connections.delete(closed);
          if (closed.contents && this.surfaceConnections.get(closed.contents) === closed) {
            this.surfaceConnections.delete(closed.contents);
          }
        },
      });
      this.connections.add(connection);
    });
    this.server.maxConnections = MAX_CONNECTIONS;
    this.server.on("error", error => {
      this.logger.error("browser.debug_server_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        this.port = address && typeof address === "object" ? address.port : 0;
        if (!this.port) reject(new Error("Browser debug server did not receive a port"));
        else resolve();
      });
    });
    this.logger.info("browser.debug_started", { port: this.port });
    return this;
  }

  descriptor() {
    if (!this.port) throw new Error("Browser debug server is not started");
    return { endpoint: `tcp://127.0.0.1:${this.port}`, token: this.token };
  }

  revokeSurface(contents) {
    const connection = contents ? this.surfaceConnections.get(contents) : null;
    if (connection) connection.rejectAndClose("lease_revoked");
  }

  async close() {
    for (const connection of [...this.connections]) connection.close();
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve());
    });
  }
}

module.exports = {
  AUTH_TIMEOUT_MS,
  BrowserDebugConnection,
  BrowserDebugServer,
  MAX_AUTH_FRAME_BYTES,
  MAX_CONNECTIONS,
  MAX_FRAME_BYTES,
  tokenMatches,
};
