const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const test = require("node:test");
const {
  BrowserDebugServer,
  MAX_AUTH_FRAME_BYTES,
  MAX_FRAME_BYTES,
} = require("../electron/browser-debug-server.cjs");

const DEBUG_LEASE_TOKEN = "debug-lease-token-0123456789abcdefghijklmnopqr";

function framed(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function peer(socket) {
  let buffer = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  const flush = () => {
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      messages.push(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
      buffer = buffer.subarray(4 + length);
    }
    while (messages.length > 0 && waiters.length > 0) waiters.shift()(messages.shift());
  };
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  return {
    send: value => socket.write(framed(value)),
    next: () => messages.length > 0
      ? Promise.resolve(messages.shift())
      : new Promise(resolve => waiters.push(resolve)),
    async until(predicate) {
      for (;;) {
        const message = await this.next();
        if (predicate(message)) return message;
      }
    },
  };
}

function connect(descriptor) {
  const endpoint = new URL(descriptor.endpoint);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

class FakeDebugger extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
    this.calls = [];
  }

  attach(version) {
    assert.equal(version, "1.3");
    if (this.attached) throw new Error("already attached");
    this.attached = true;
  }

  isAttached() {
    return this.attached;
  }

  detach() {
    this.attached = false;
  }

  async sendCommand(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.getTargetInfo") {
      return {
        targetInfo: {
          targetId: "authorized-target",
          type: "page",
          title: "ChatGPT",
          url: "https://chatgpt.com/?temporary-chat=true",
          attached: true,
          canAccessOpener: false,
          browserContextId: "private-partition",
        },
      };
    }
    if (method === "Browser.getVersion") {
      return { product: "Chrome/1", revision: "test", userAgent: "Chrome", jsVersion: "1" };
    }
    return { echoed: method };
  }
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

test("private debug server authenticates before resolving or attaching a surface", async () => {
  let hostCalls = 0;
  const server = await new BrowserDebugServer({
    logger: logger(),
    getBrowserHost: () => {
      hostCalls += 1;
      return { resolveDebugSurface: () => assert.fail("wrong token reached browser host") };
    },
  }).start();
  const descriptor = server.descriptor();
  const socket = await connect(descriptor);
  const client = peer(socket);
  try {
    client.send({
      type: "authenticate",
      token: "wrong-private-debug-token-0123456789abcdef",
      surfaceId: "a".repeat(32),
      helperPid: process.pid,
      leaseToken: DEBUG_LEASE_TOKEN,
    });
    assert.deepEqual(await client.next(), { type: "error", error: "unauthorized" });
    assert.equal(hostCalls, 0);
    const address = server.server.address();
    assert.equal(address.address, "127.0.0.1");
  } finally {
    socket.destroy();
  }
  const oversized = await connect(descriptor);
  const oversizedClient = peer(oversized);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_AUTH_FRAME_BYTES + 1);
  oversized.write(header);
  assert.deepEqual(await oversizedClient.next(), { type: "error", error: "frame_too_large" });
  oversized.destroy();
  await server.close();
});

test("private debug server exposes one authorized page and rejects browser-wide CDP bypasses", async () => {
  const debuggerApi = new FakeDebugger();
  const resolutions = [];
  const contents = { debugger: debuggerApi, isDestroyed: () => false };
  const server = await new BrowserDebugServer({
    logger: logger(),
    getBrowserHost: () => ({
      resolveDebugSurface(surfaceId, helperPid, leaseToken) {
        resolutions.push({ surfaceId, helperPid, leaseToken });
        return contents;
      },
    }),
  }).start();
  const descriptor = server.descriptor();
  const socket = await connect(descriptor);
  const client = peer(socket);
  const surfaceId = "b".repeat(32);
  try {
    client.send({
      type: "authenticate",
      token: descriptor.token,
      surfaceId,
      helperPid: process.pid,
      leaseToken: DEBUG_LEASE_TOKEN,
    });
    assert.deepEqual(await client.next(), { type: "ready" });
    assert.deepEqual(resolutions, [{ surfaceId, helperPid: process.pid, leaseToken: DEBUG_LEASE_TOKEN }]);

    client.send({ type: "cdp", message: { id: 1, method: "Browser.getVersion", params: {} } });
    assert.deepEqual(await client.next(), {
      type: "cdp",
      message: {
        id: 1,
        result: { product: "Chrome/1", revision: "test", userAgent: "Chrome", jsVersion: "1" },
      },
    });

    client.send({
      type: "cdp",
      message: { id: 9, method: "Browser.setDownloadBehavior", params: { behavior: "allow" } },
    });
    assert.deepEqual(await client.next(), { type: "cdp", message: { id: 9, result: {} } });
    assert.equal(debuggerApi.calls.some(call => call.method === "Browser.setDownloadBehavior"), false);

    client.send({
      type: "cdp",
      message: {
        id: 2,
        method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      },
    });
    assert.deepEqual(await client.next(), { type: "cdp", message: { id: 2, result: {} } });
    const attached = await client.next();
    assert.equal(attached.type, "cdp");
    assert.equal(attached.message.method, "Target.attachedToTarget");
    assert.equal(attached.message.params.targetInfo.targetId, "authorized-target");
    const pageSessionId = attached.message.params.sessionId;

    client.send({
      type: "cdp",
      message: { id: 3, sessionId: pageSessionId, method: "Runtime.evaluate", params: { expression: "1 + 1" } },
    });
    assert.deepEqual(await client.next(), {
      type: "cdp",
      message: { id: 3, result: { echoed: "Runtime.evaluate" }, sessionId: pageSessionId },
    });

    const forbidden = [
      { id: 4, method: "Target.getTargets", params: {} },
      { id: 5, sessionId: pageSessionId, method: "Target.getTargets", params: {} },
      { id: 6, sessionId: pageSessionId, method: "Target.attachToTarget", params: { targetId: "other" } },
      { id: 7, sessionId: pageSessionId, method: "Target.closeTarget", params: { targetId: "authorized-target" } },
      { id: 8, sessionId: pageSessionId, method: "Browser.close", params: {} },
      { id: 10, method: "Browser.cancelDownload", params: { guid: "other-surface" } },
      { id: 11, sessionId: pageSessionId, method: "Network.getAllCookies", params: {} },
      { id: 12, sessionId: pageSessionId, method: "Network.getCookies", params: {} },
      { id: 13, sessionId: pageSessionId, method: "Network.clearBrowserCookies", params: {} },
      { id: 14, sessionId: pageSessionId, method: "Network.setCookie", params: { name: "x", value: "y" } },
      { id: 15, sessionId: pageSessionId, method: "DOMStorage.getDOMStorageItems", params: {} },
      { id: 16, sessionId: pageSessionId, method: "IndexedDB.requestDatabaseNames", params: {} },
      { id: 17, sessionId: pageSessionId, method: "ServiceWorker.stopAllWorkers", params: {} },
    ];
    for (const command of forbidden) {
      client.send({ type: "cdp", message: command });
      const response = await client.until(message => message?.message?.id === command.id);
      assert.equal(response.type, "cdp");
      assert.equal(response.message.error.code, -32_000);
    }
    assert.equal(
      debuggerApi.calls.some(call => forbidden.some(command => command.method === call.method)),
      false,
    );
    assert.equal(MAX_FRAME_BYTES >= 128 * 1024 * 1024, true);

    const replacementSocket = await connect(descriptor);
    const replacement = peer(replacementSocket);
    replacement.send({
      type: "authenticate",
      token: descriptor.token,
      surfaceId,
      helperPid: process.pid,
      leaseToken: DEBUG_LEASE_TOKEN,
    });
    assert.deepEqual(await replacement.next(), { type: "ready" });
    assert.equal(debuggerApi.isAttached(), true);
    replacementSocket.destroy();
  } finally {
    socket.destroy();
    await server.close();
  }
});

test("private debug server revalidates every lease and revokes active surface connections", async () => {
  const debuggerApi = new FakeDebugger();
  const contents = { debugger: debuggerApi, isDestroyed: () => false };
  let valid = true;
  const server = await new BrowserDebugServer({
    logger: logger(),
    getBrowserHost: () => ({
      resolveDebugSurface(_surfaceId, _helperPid, leaseToken) {
        if (!valid || leaseToken !== DEBUG_LEASE_TOKEN) throw new Error("lease expired");
        return contents;
      },
    }),
  }).start();
  const descriptor = server.descriptor();
  const surfaceId = "d".repeat(32);
  const authenticate = async () => {
    const socket = await connect(descriptor);
    const client = peer(socket);
    client.send({
      type: "authenticate",
      token: descriptor.token,
      surfaceId,
      helperPid: process.pid,
      leaseToken: DEBUG_LEASE_TOKEN,
    });
    assert.deepEqual(await client.next(), { type: "ready" });
    return { socket, client };
  };
  try {
    const expired = await authenticate();
    valid = false;
    expired.client.send({ type: "cdp", message: { id: 1, method: "Browser.getVersion", params: {} } });
    assert.deepEqual(await expired.client.next(), { type: "error", error: "lease_expired" });
    expired.socket.destroy();

    valid = true;
    const revoked = await authenticate();
    server.revokeSurface(contents);
    assert.deepEqual(await revoked.client.next(), { type: "error", error: "lease_revoked" });
    revoked.socket.destroy();
  } finally {
    await server.close();
  }
});

test("private debug authentication rejects pipelined CDP before readiness and detaches", async () => {
  let releaseTargetInfo;
  const debuggerApi = new FakeDebugger();
  debuggerApi.sendCommand = async function sendCommand(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method !== "Target.getTargetInfo") return { echoed: method };
    await new Promise(resolve => { releaseTargetInfo = resolve; });
    return {
      targetInfo: {
        targetId: "slow-target",
        type: "page",
        title: "ChatGPT",
        url: "https://chatgpt.com/?temporary-chat=true",
        browserContextId: "private-partition",
      },
    };
  };
  const contents = { debugger: debuggerApi, isDestroyed: () => false };
  const server = await new BrowserDebugServer({
    logger: logger(),
    getBrowserHost: () => ({ resolveDebugSurface: () => contents }),
  }).start();
  const descriptor = server.descriptor();
  const socket = await connect(descriptor);
  const client = peer(socket);
  try {
    socket.write(Buffer.concat([
      framed({
        type: "authenticate",
        token: descriptor.token,
        surfaceId: "c".repeat(32),
        helperPid: process.pid,
        leaseToken: DEBUG_LEASE_TOKEN,
      }),
      framed({ type: "cdp", message: { id: 1, method: "Runtime.evaluate", params: {} } }),
    ]));
    assert.deepEqual(await client.next(), { type: "error", error: "authentication_in_progress" });
    assert.equal(debuggerApi.isAttached(), false);
    releaseTargetInfo();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(debuggerApi.isAttached(), false);
  } finally {
    socket.destroy();
    await server.close();
  }
});
