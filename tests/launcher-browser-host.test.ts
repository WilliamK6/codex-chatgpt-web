import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_BROWSER_HOST_KIND,
  LauncherRetainedConversationUnavailableError,
  LauncherBrowserTurnCancelledError,
  connectLauncherDebugTransport,
  inspectLauncherBrowserHost,
  notifyLauncherTurn,
  readLauncherBrowserHostDescriptor,
  releaseLauncherRetainedConversation,
  selectLauncherPage,
} from "../src/launcher-browser-host";
import type { Browser, BrowserContext, Page } from "playwright-core";

const roots: string[] = [];
const DEBUG_LEASE_TOKEN = "debug-lease-token-0123456789abcdefghijklmnopqr";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(
  controlEndpoint = "http://127.0.0.1:39111",
  profile: "production" | "development" = "production",
  debugEndpoint = "tcp://127.0.0.1:39110",
): string {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile,
    pid: process.pid,
    debug: {
      endpoint: debugEndpoint,
      token: "launcher-debug-token-0123456789abcdefghijklmnopqr",
    },
    control: {
      endpoint: controlEndpoint,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: profile === "development"
      ? "persist:codex-web-gpt-dev-chatgpt"
      : "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

function framed(value: object): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

test("launcher descriptor is owner-only, loopback-only, and process-bound", () => {
  const path = descriptorFile();
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    debug: {
      endpoint: "tcp://127.0.0.1:39110",
      token: "launcher-debug-token-0123456789abcdefghijklmnopqr",
    },
    surfaceId: "launcher_surface_id_0123456789AB",
  });
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("unsafe permissions");
  }
});

test("launcher private debug transport authenticates before carrying CDP messages", async () => {
  const received: unknown[] = [];
  const server = createNetServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        received.push(message);
        if (message.type === "authenticate") socket.write(framed({ type: "ready" }));
        if (message.type === "cdp") {
          socket.write(framed({
            type: "cdp",
            message: { id: message.message.id, result: { product: "private" } },
          }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const descriptor = readLauncherBrowserHostDescriptor(descriptorFile(
      "http://127.0.0.1:39111",
      "production",
      `tcp://127.0.0.1:${address.port}`,
    ));
    const transport = await connectLauncherDebugTransport(
      descriptor,
      descriptor.surfaceId,
      DEBUG_LEASE_TOKEN,
      2_000,
    );
    const response = new Promise<object>(resolve => { transport.onmessage = resolve; });
    transport.send({ id: 7, method: "Browser.getVersion", params: {} });
    await expect(response).resolves.toEqual({ id: 7, result: { product: "private" } });
    expect(received[0]).toEqual({
      type: "authenticate",
      token: descriptor.debug.token,
      surfaceId: descriptor.surfaceId,
      helperPid: process.pid,
      leaseToken: DEBUG_LEASE_TOKEN,
    });
    expect(received[1]).toEqual({
      type: "cdp",
      message: { id: 7, method: "Browser.getVersion", params: {} },
    });
    transport.close();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher private debug transport fails promptly on malformed framing and abort", async () => {
  const malformedSockets = new Set<Socket>();
  const malformed = createNetServer(socket => {
    malformedSockets.add(socket);
    socket.once("close", () => malformedSockets.delete(socket));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0);
    socket.write(header);
  });
  await new Promise<void>((resolve, reject) => {
    malformed.once("error", reject);
    malformed.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = malformed.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const descriptor = readLauncherBrowserHostDescriptor(descriptorFile(
      "http://127.0.0.1:39111",
      "production",
      `tcp://127.0.0.1:${address.port}`,
    ));
    await expect(connectLauncherDebugTransport(descriptor, descriptor.surfaceId, DEBUG_LEASE_TOKEN, 2_000))
      .rejects.toThrow("private debug frame is too large");
  } finally {
    for (const socket of malformedSockets) socket.destroy();
    await new Promise<void>(resolve => malformed.close(() => resolve()));
  }

  const stalledSockets = new Set<Socket>();
  const stalled = createNetServer(socket => {
    stalledSockets.add(socket);
    socket.once("close", () => stalledSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    stalled.once("error", reject);
    stalled.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = stalled.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const descriptor = readLauncherBrowserHostDescriptor(descriptorFile(
      "http://127.0.0.1:39111",
      "production",
      `tcp://127.0.0.1:${address.port}`,
    ));
    const controller = new AbortController();
    const pending = connectLauncherDebugTransport(
      descriptor,
      descriptor.surfaceId,
      DEBUG_LEASE_TOKEN,
      2_000,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    for (const socket of stalledSockets) socket.destroy();
    await new Promise<void>(resolve => stalled.close(() => resolve()));
  }
});

test("launcher turn control sends authenticated lifecycle events", async () => {
  let received: { authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? `{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","debugLeaseToken":"${DEBUG_LEASE_TOKEN}","reused":true,"connectorBound":true}\n`
      : request.url === "/v1/turn/end"
        ? '{"ok":true,"cancelledByUser":false}\n'
        : '{"ok":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native2",
      requireRetainedConversation: true,
    })).resolves.toEqual({
      surfaceId: "launcher_surface_id_0123456789AB",
      debugLeaseToken: DEBUG_LEASE_TOKEN,
      reused: true,
      connectorBound: true,
    });
    expect(received.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(received.body).toEqual({
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native2",
      requireRetainedConversation: true,
    });
    await notifyLauncherTurn(path, {
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
    });
    expect(received.body).toEqual({ phase: "heartbeat", traceId: "abc123def456", helperPid: process.pid });
    await expect(notifyLauncherTurn(path, {
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
      connectorBound: true,
    })).resolves.toEqual({ cancelledByUser: false });
    expect(received.body).toEqual({
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
      connectorBound: true,
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher retained-conversation release uses its authenticated exact-key endpoint", async () => {
  let received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"released":1}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(releaseLauncherRetainedConversation(path, "b".repeat(64))).resolves.toBe(1);
    expect(received).toEqual({
      url: "/v1/turn/release",
      authorization: "Bearer launcher-control-token-0123456789abcdefghijklmnop",
      body: { conversationKey: "b".repeat(64) },
    });
    await expect(releaseLauncherRetainedConversation(path, "not-a-key"))
      .rejects.toThrow("retained conversation key is invalid");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves explicit user cancellation as a terminal signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"turn closed by user","code":"turn_cancelled"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "cancelled123",
      helperPid: process.pid,
    }).catch(cause => cause);
    expect(error).toBeInstanceOf(LauncherBrowserTurnCancelledError);
    expect((error as Error).message).toBe("turn closed by user");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves a missing retained conversation as a typed signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"retained source missing","code":"retained_conversation_unavailable"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "missing123456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      requireRetainedConversation: true,
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(LauncherRetainedConversationUnavailableError);
    expect(error.message).toContain("retained source missing");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification uses the authenticated control channel instead of Bun CDP", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectCapabilities: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      solAvailable: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    expect(await inspectLauncherBrowserHost(path, { detectCapabilities: true })).toEqual({
      solAvailable: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification reports its own deadline instead of a generic abort", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
    if (!response.destroyed) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"late"}\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(inspectLauncherBrowserHost(path, { detectCapabilities: true, timeoutMs: 5 }))
      .rejects.toThrow("session inspection timed out after 5ms");
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher descriptor rejects non-loopback browser ownership", () => {
  const path = descriptorFile();
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.debug.endpoint = "tcp://0.0.0.0:443";
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("tcp://127.0.0.1");
});

test("launcher profile checks reject cross-profile browser ownership", async () => {
  const path = descriptorFile("http://127.0.0.1:39111", "development");
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    profile: "development",
    partition: "persist:codex-web-gpt-dev-chatgpt",
  });
  await expect(inspectLauncherBrowserHost(path, { expectedProfile: "production", timeoutMs: 5 }))
    .rejects.toThrow("belongs to development");
});

test("launcher page selection uses the owned surface marker instead of URL order", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const hiddenPage = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    evaluate: async () => "another_surface_id_0123456789ABC",
  } as unknown as Page;
  const ownedPage = {
    url: () => "about:blank#codex-web-gpt-browser-host",
    evaluate: async () => descriptor.surfaceId,
  } as unknown as Page;
  const context = {
    pages: () => [hiddenPage, ownedPage],
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(await selectLauncherPage(browser, descriptor, 20)).toEqual({
    context,
    page: ownedPage,
  });
});

test("launcher page selection rejects duplicated ownership markers", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const page = () => ({
    evaluate: async () => descriptor.surfaceId,
  }) as unknown as Page;
  const context = {
    pages: () => [page(), page()],
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(selectLauncherPage(browser, descriptor, 20)).rejects.toThrow(
    "2 surfaces with the same ownership id",
  );
});

test("launcher page selection stops immediately when acquisition is aborted", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const browser = {
    contexts: () => [],
  } as unknown as Browser;
  const controller = new AbortController();
  controller.abort();

  expect(selectLauncherPage(
    browser,
    descriptor,
    60_000,
    descriptor.surfaceId,
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});
