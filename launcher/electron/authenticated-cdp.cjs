const { createServer } = require("node:http");
const { timingSafeEqual } = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

// These Network commands operate on the shared profile even through a page session.
const PROFILE_NETWORK_COMMANDS = new Set([
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
]);

// Use Electron's in-process debugger, never Chromium's unauthenticated TCP listener.
// Each authenticated connection sees only its leased browser surface, not the launcher UI.
class AuthenticatedCdpServer {
  constructor({ token, getWebContents }) {
    this.token = token;
    this.getWebContents = getWebContents;
    this.connections = new Map();
    this.port = 0;
    this.webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.server = createServer((request, response) => {
      if (!this.authorized(request)) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "GET" || request.url !== "/json/version") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser`,
      }));
    });
    this.server.on("upgrade", (request, socket, head) => {
      const surface = /^\/devtools\/browser\/([A-Za-z0-9_-]{32})$/.exec(request.url || "")?.[1];
      if (!this.authorized(request) || !surface) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const contents = this.getWebContents(surface);
      if (!contents || contents.isDestroyed() || this.connections.has(contents)) {
        socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, ws => this.connect(ws, contents, surface));
    });
    this.server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  }

  authorized(request) {
    if (request.headers.host !== `127.0.0.1:${this.port}` || request.headers.origin !== undefined) return false;
    const expected = Buffer.from(`Bearer ${this.token}`);
    const supplied = Buffer.from(request.headers.authorization || "");
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this;
  }

  connect(ws, contents, surface) {
    const debuggerApi = contents.debugger;
    const pageSession = "owned-page";
    const childSessions = new Map();
    let attached = false;
    let announced = false;
    let disposed = false;
    let targetInfo;
    const send = message => {
      if (this.getWebContents(surface) !== contents) { close(); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const close = () => { dispose(); ws.close(1001, "Browser surface closed"); };
    const onMessage = (_event, method, params, sessionId) => {
      if (method === "Target.attachedToTarget") childSessions.set(params.sessionId, sessionId);
      if (method === "Target.detachedFromTarget") childSessions.delete(params.sessionId);
      send({ method, params, sessionId: sessionId || pageSession });
    };
    const dispose = () => {
      if (this.connections.get(contents) !== ws) return;
      disposed = true;
      this.connections.delete(contents);
      debuggerApi.off("message", onMessage);
      debuggerApi.off("detach", close);
      contents.off("destroyed", close);
      if (attached && !contents.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
    };
    this.connections.set(contents, ws);
    ws.once("close", dispose);
    ws.on("error", () => ws.terminate());
    contents.once("destroyed", close);
    debuggerApi.on("detach", close);
    debuggerApi.on("message", onMessage);
    try {
      debuggerApi.attach("1.3");
      attached = true;
    } catch {
      ws.close(1011, "Browser debugger unavailable");
      return;
    }
    const ready = debuggerApi.sendCommand("Target.getTargetInfo").then(result => {
      targetInfo = result.targetInfo;
    });
    void ready.catch(() => ws.close(1011, "Browser target unavailable"));
    ws.on("message", async (data, isBinary) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { ws.close(1008, "Invalid protocol message"); return; }
      if (isBinary || !Number.isSafeInteger(message?.id) || typeof message.method !== "string") {
        ws.close(1008, "Invalid protocol message");
        return;
      }
      const { id, method, params = {}, sessionId } = message;
      try {
        await ready;
        if (disposed || ws.readyState !== WebSocket.OPEN || this.connections.get(contents) !== ws) return;
        if (this.getWebContents(surface) !== contents) { close(); return; }
        let result;
        if (sessionId && sessionId !== pageSession && !childSessions.has(sessionId)) {
          throw new Error("Unknown browser session");
        }
        if ((method.startsWith("Browser.") && method !== "Browser.getVersion") || method.startsWith("Storage.")
          || PROFILE_NETWORK_COMMANDS.has(method)) {
          throw new Error("Browser operation is outside the leased browser surface");
        } else if (!sessionId && method === "Target.setAutoAttach") {
          if (!announced && params.autoAttach === true) {
            announced = true;
            send({ method: "Target.attachedToTarget", params: {
              sessionId: pageSession, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false,
            } });
          }
          result = {};
        } else if (method === "Target.getTargetInfo" && childSessions.has(sessionId) && !params.targetId) {
          result = await debuggerApi.sendCommand(method, params, sessionId);
        } else if (method === "Target.getTargetInfo" && (!params.targetId || params.targetId === targetInfo.targetId)) {
          result = { targetInfo };
        } else if (!sessionId && method === "Target.getTargets") {
          result = { targetInfos: [targetInfo] };
        } else if (method === "Target.detachFromTarget" && childSessions.has(params.sessionId)) {
          result = await debuggerApi.sendCommand(method, params, childSessions.get(params.sessionId));
          childSessions.delete(params.sessionId);
        } else if (method.startsWith("Target.") && method !== "Target.setAutoAttach") {
          // Do not allow a page connection to discover or attach to unrelated Electron targets.
          throw new Error("Target operation is outside the leased browser surface");
        } else if (!sessionId && method !== "Browser.getVersion") {
          throw new Error("Browser operation is outside the leased browser surface");
        } else {
          result = await debuggerApi.sendCommand(method, params, sessionId === pageSession ? undefined : sessionId);
        }
        send({ id, sessionId, result });
      } catch (error) {
        send({ id, sessionId, error: { code: -32000, message: error.message || "Browser command failed" } });
      }
    });
  }

  async close() {
    for (const ws of this.connections.values()) ws.terminate();
    await new Promise(resolve => this.webSockets.close(resolve));
    if (this.server.listening) await new Promise((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}

module.exports = { AuthenticatedCdpServer };
