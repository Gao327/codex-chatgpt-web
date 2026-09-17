const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { request: httpRequest } = require("node:http");
const { WebSocket } = require("ws");
const { AuthenticatedCdpServer } = require("../electron/authenticated-cdp.cjs");

const SURFACE = "a".repeat(32);
const TOKEN = "test-secret-token";

async function fixture(t, initialTarget) {
  const commands = [];
  let initial = true;
  const debuggerApi = Object.assign(new EventEmitter(), {
    attached: false,
    attachCount: 0,
    detachCount: 0,
    attach() {
      assert.equal(this.attached, false);
      this.attached = true;
      this.attachCount++;
    },
    detach() {
      this.attached = false;
      this.detachCount++;
      this.emit("detach", {}, "target_closed");
    },
    isAttached() { return this.attached; },
    sendCommand(method, params, sessionId) {
      commands.push({ method, params, sessionId });
      if (method === "Target.getTargetInfo") {
        if (initial && initialTarget) {
          initial = false;
          return initialTarget;
        }
        return Promise.resolve({ targetInfo: { targetId: sessionId || "owned-target", type: "page" } });
      }
      return Promise.resolve({ ok: true });
    },
  });
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
  });
  let permitted = true;
  const server = await new AuthenticatedCdpServer({
    token: TOKEN,
    getWebContents: surface => permitted && surface === SURFACE ? contents : undefined,
  }).start();
  t.after(() => server.close());
  return {
    server, contents, debuggerApi, commands,
    revoke() { permitted = false; },
    url: `ws://127.0.0.1:${server.port}/devtools/browser/${SURFACE}`,
  };
}

function connect(url, headers = { authorization: `Bearer ${TOKEN}` }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(Object.assign(new Error("Upgrade rejected"), { status: response.statusCode }));
      socket.terminate();
    });
    socket.once("open", () => resolve(socket));
  });
}

async function client(f) {
  const socket = await connect(f.url);
  let id = 0;
  const pending = new Map();
  socket.on("message", data => {
    const message = JSON.parse(data.toString());
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  return {
    socket,
    command(method, params = {}, sessionId = "owned-page") {
      const commandId = ++id;
      const result = new Promise(resolve => pending.set(commandId, resolve));
      socket.send(JSON.stringify({ id: commandId, method, params, ...(sessionId ? { sessionId } : {}) }));
      return result;
    },
    async close() {
      const serverSocket = f.server.connections.get(f.contents);
      const closed = Promise.all([once(socket, "close"), serverSocket ? once(serverSocket, "close") : undefined]);
      socket.close();
      await closed;
    },
  };
}

function httpStatus(port, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/json/version", headers }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

test("HTTP discovery and WebSocket upgrades require bearer auth, exact loopback Host, and no Origin", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const authorized = { authorization: `Bearer ${TOKEN}` };
  for (const headers of [
    {},
    { authorization: "Bearer wrong-token" },
    { ...authorized, host: `localhost:${f.server.port}` },
    { ...authorized, host: `attacker.example:${f.server.port}` },
    { ...authorized, origin: "https://attacker.example" },
    { ...authorized, origin: "null" },
  ]) {
    assert.equal(await httpStatus(f.server.port, headers), 401);
    await assert.rejects(connect(f.url, headers), { status: 401 });
  }
  assert.equal(f.debuggerApi.attachCount, 0);
  assert.equal(await httpStatus(f.server.port, authorized), 200);
  const c = await client(f);
  assert.equal(f.debuggerApi.attachCount, 1);
  await c.close();
});

test("only a live leased surface accepts a single debugger connection", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(connect(f.url.replace(SURFACE, "b".repeat(32))), { status: 409 });
  await assert.rejects(connect(f.url.replace(SURFACE, "short")), { status: 401 });
  const c = await client(f);
  await assert.rejects(connect(f.url), { status: 409 });
  await c.close();
  const replacement = await client(f);
  assert.equal(f.debuggerApi.attachCount, 2);
  await replacement.close();
  f.contents.destroyed = true;
  await assert.rejects(connect(f.url), { status: 409 });
});

test("session IDs cannot bypass browser-wide or unrelated-target restrictions", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const c = await client(f);
  for (const session of [null, "owned-page"]) {
    for (const method of ["Browser.close", "Browser.getWindowForTarget", "Storage.getCookies"]) {
      const reply = await c.command(method, { targetId: "unrelated-target" }, session);
      assert.match(reply.error.message, /outside the leased browser surface/);
    }
  }
  for (const [method, params] of [
    ["Target.attachToTarget", { targetId: "unrelated-target", flatten: true }],
    ["Target.getTargetInfo", { targetId: "unrelated-target" }],
    ["Target.createTarget", { url: "about:blank" }],
    ["Target.sendMessageToTarget", { sessionId: "unrelated-session", message: "{}" }],
  ]) assert.match((await c.command(method, params)).error.message, /outside the leased browser surface/);
  assert.match((await c.command("Runtime.evaluate", {}, "unrelated-session")).error.message, /Unknown browser session/);
  assert.deepEqual((await c.command("Target.getTargets", {}, null)).result.targetInfos.map(info => info.targetId), ["owned-target"]);
  assert.deepEqual((await c.command("Runtime.evaluate", { expression: "1 + 1" })).result, { ok: true });
  assert.deepEqual(f.commands.map(command => command.method), ["Target.getTargetInfo", "Runtime.evaluate"]);
  await c.close();
});

test("Network cookie and shared cache commands cannot escape page or child scope", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const c = await client(f);
  f.debuggerApi.emit("message", {}, "Target.attachedToTarget", {
    sessionId: "child", targetInfo: { targetId: "child-target", type: "iframe" },
  });
  const profileCommands = [
    ["Network.getAllCookies", {}],
    ["Network.getCookies", {}],
    ["Network.getCookies", { urls: ["https://unrelated.example/"] }],
    ["Network.setCookie", { name: "fixture", value: "fake", url: "https://unrelated.example/" }],
    ["Network.setCookies", { cookies: [{ name: "fixture", value: "fake", domain: "unrelated.example", path: "/" }] }],
    ["Network.deleteCookies", { name: "fixture", domain: "unrelated.example" }],
    ["Network.clearBrowserCookies", {}],
    ["Network.clearBrowserCache", {}],
  ];
  for (const session of [null, "owned-page", "child"]) {
    for (const [method, params] of profileCommands) {
      const reply = await c.command(method, params, session);
      assert.match(reply.error.message, /outside the leased browser surface/, `${method} through ${session}`);
    }
  }
  assert.deepEqual(f.commands.map(command => command.method), ["Target.getTargetInfo"]);
  for (const session of ["owned-page", "child"]) {
    assert.deepEqual((await c.command("Network.enable", {}, session)).result, { ok: true });
    assert.deepEqual((await c.command("Network.setCacheDisabled", { cacheDisabled: true }, session)).result, { ok: true });
    assert.deepEqual((await c.command("Network.getResponseBody", { requestId: "page-request" }, session)).result, { ok: true });
  }
  await c.close();
});

test("commands queued before disconnect cannot reach a replacement debugger connection", { timeout: 5_000 }, async t => {
  let releaseInitial;
  const initial = new Promise(resolve => { releaseInitial = resolve; });
  const f = await fixture(t, initial);
  const first = await client(f);
  const received = once(f.server.connections.get(f.contents), "message");
  first.socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "old command" }, sessionId: "owned-page" }));
  await received;
  await first.close();
  const second = await client(f);
  releaseInitial({ targetInfo: { targetId: "owned-target", type: "page" } });
  await second.command("Runtime.evaluate", { expression: "new command" });
  assert.deepEqual(f.commands.filter(command => command.method === "Runtime.evaluate").map(command => command.params.expression), ["new command"]);
  await second.close();
});

test("tracked nested children route through their own sessions and cannot reach unrelated sessions", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const c = await client(f);
  f.debuggerApi.emit("message", {}, "Target.attachedToTarget", { sessionId: "child", targetInfo: { targetId: "child-target", type: "iframe" } });
  f.debuggerApi.emit("message", {}, "Target.attachedToTarget", { sessionId: "grandchild", targetInfo: { targetId: "grandchild-target", type: "worker" } }, "child");
  assert.equal((await c.command("Target.getTargetInfo", {}, "child")).result.targetInfo.targetId, "child");
  assert.deepEqual((await c.command("Runtime.evaluate", { expression: "1" }, "grandchild")).result, { ok: true });
  assert.match((await c.command("Storage.getCookies", {}, "child")).error.message, /outside the leased browser surface/);
  assert.match((await c.command("Target.detachFromTarget", { sessionId: "unrelated-session" })).error.message, /outside the leased browser surface/);
  await c.command("Target.detachFromTarget", { sessionId: "grandchild" }, "child");
  assert.deepEqual(f.commands.find(command => command.method === "Target.detachFromTarget"), {
    method: "Target.detachFromTarget", params: { sessionId: "grandchild" }, sessionId: "child",
  });
  assert.match((await c.command("Runtime.evaluate", {}, "grandchild")).error.message, /Unknown browser session/);
  f.debuggerApi.emit("message", {}, "Target.detachedFromTarget", { sessionId: "child" });
  assert.match((await c.command("Runtime.evaluate", {}, "child")).error.message, /Unknown browser session/);
  await c.close();
});

test("revoking a surface stops further commands and prevents reattachment", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const c = await client(f);
  await c.command("Runtime.enable");
  f.revoke();
  const closed = once(c.socket, "close");
  c.socket.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "after revocation" }, sessionId: "owned-page" }));
  await closed;
  assert.equal(f.commands.some(command => command.method === "Runtime.evaluate"), false);
  assert.equal(f.server.connections.size, 0);
  assert.equal(f.debuggerApi.isAttached(), false);
  await assert.rejects(connect(f.url), { status: 409 });
});

test("revocation also blocks outgoing debugger events and cleans up listeners", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const c = await client(f);
  await c.command("Runtime.enable");
  const received = [];
  c.socket.on("message", data => received.push(JSON.parse(data.toString())));
  f.revoke();
  const closed = once(c.socket, "close");
  f.debuggerApi.emit("message", {}, "Runtime.consoleAPICalled", { args: [{ value: "private event" }] });
  await closed;
  assert.deepEqual(received, []);
  assert.equal(f.debuggerApi.listenerCount("message"), 0);
  assert.equal(f.debuggerApi.listenerCount("detach"), 0);
  assert.equal(f.contents.listenerCount("destroyed"), 0);
  assert.equal(f.debuggerApi.detachCount, 1);
});

test("debugger detachment and server shutdown release connection ownership", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const c = await client(f);
  const detached = once(c.socket, "close");
  f.debuggerApi.attached = false;
  f.debuggerApi.emit("detach", {}, "replaced_with_devtools");
  await detached;
  assert.equal(f.server.connections.size, 0);
  assert.equal(f.debuggerApi.listenerCount("message"), 0);
  const replacement = await client(f);
  const closed = once(replacement.socket, "close");
  await f.server.close();
  await closed;
  assert.equal(f.server.connections.size, 0);
  assert.equal(f.debuggerApi.isAttached(), false);
});

test("destroying the leased contents closes the socket without touching an invalid debugger", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const c = await client(f);
  const closed = once(c.socket, "close");
  f.contents.destroyed = true;
  f.contents.emit("destroyed");
  await closed;
  assert.equal(f.server.connections.size, 0);
  assert.equal(f.debuggerApi.detachCount, 0);
  assert.equal(f.debuggerApi.listenerCount("message"), 0);
  assert.equal(f.contents.listenerCount("destroyed"), 0);
  await assert.rejects(connect(f.url), { status: 409 });
});

test("revocation during initial target discovery cancels a waiting command", { timeout: 5_000 }, async t => {
  let releaseInitial;
  const f = await fixture(t, new Promise(resolve => { releaseInitial = resolve; }));
  const c = await client(f);
  const received = once(f.server.connections.get(f.contents), "message");
  c.socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "waiting command" }, sessionId: "owned-page" }));
  await received;
  f.revoke();
  const closed = once(c.socket, "close");
  releaseInitial({ targetInfo: { targetId: "owned-target", type: "page" } });
  await closed;
  assert.equal(f.commands.some(command => command.method === "Runtime.evaluate"), false);
  assert.equal(f.server.connections.size, 0);
});
