const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BrowserHost } = require("../electron/browser-host.cjs");

// Execute the production handlers with fake resources; never start an account or user service.
const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
const quitSource = source.slice(source.indexOf("async function requestQuit()"), source.indexOf("async function start()"));

function quitFixture(browserOperation, runtimeOperation = null) {
  const calls = [];
  const context = vm.createContext({
    shutdownInProgress: false,
    exitCommitted: false,
    quitting: false,
    runtimeHost: {
      cancelPasskeyLogin: async () => { calls.push("cancel-passkey"); },
      currentOperation: () => runtimeOperation,
    },
    runtimeSupervisor: { shutdown: async () => { calls.push("stop-runtime"); } },
    browserHost: {
      currentOperation: () => browserOperation,
      persistSession: async () => { calls.push("persist-session"); },
      destroy: () => { calls.push("destroy-browser"); },
    },
    browserControl: { close: async () => { calls.push("close-control"); } },
    browserDebugging: { close: async () => { calls.push("close-debugger"); } },
    stopCatalogVerificationMonitor: () => calls.push("stop-monitor"),
    showMainWindow: () => calls.push("show-window"),
    publishOperation: operation => calls.push(operation.message),
    app: { quit: () => calls.push("quit") },
  });
  vm.runInContext(quitSource, context);
  return { context, calls };
}

test("Quit works while embedded sign-in or saved-session refresh is waiting", async () => {
  for (const operation of ["ChatGPT login", "session refresh"]) {
    const { context, calls } = quitFixture(operation);
    assert.equal((await context.requestQuit()).ok, true);
    assert.deepEqual(calls, ["cancel-passkey", "stop-runtime", "stop-monitor", "persist-session",
      "destroy-browser", "close-control", "close-debugger", "quit"]);
    assert.equal(context.exitCommitted, true);
  }
});

test("Quit cancels passkey sign-in before checking for protected runtime operations", async () => {
  const { context, calls } = quitFixture("ChatGPT passkey login", "passkey-login");
  context.runtimeHost.cancelPasskeyLogin = async () => {
    calls.push("cancel-passkey");
    context.runtimeHost.currentOperation = () => null;
  };
  assert.equal((await context.requestQuit()).ok, true);
  assert.equal(calls.at(-1), "quit");
});

test("Quit still protects an in-flight installation transaction", async () => {
  const { context, calls } = quitFixture(null, "setup");
  assert.equal((await context.requestQuit()).ok, false);
  assert.equal(calls.includes("destroy-browser"), false);
  assert.equal(calls.includes("stop-runtime"), false);
  assert.match(calls.at(-1), /Wait for setup/);
});

test("simultaneous Quit requests clean up resources only once", async () => {
  const { context, calls } = quitFixture("ChatGPT login");
  let finish;
  context.runtimeSupervisor.shutdown = () => new Promise(resolve => { finish = resolve; });
  const first = context.requestQuit();
  await Promise.resolve();
  assert.equal((await context.requestQuit()).ok, false);
  finish();
  assert.equal((await first).ok, true);
  assert.equal(calls.filter(call => call === "destroy-browser").length, 1);
});

test("closing an unfinished setup exits; completed setup preserves the background preference", () => {
  const handlerSource = /window\.on\("close", (\(event\) => \{[\s\S]*?\n  \})\);/.exec(source)?.[1];
  assert.ok(handlerSource);
  for (const [coreSetupComplete, keepRunningOnClose, tray, expected] of [
    [false, true, {}, "quit"], [undefined, true, {}, "quit"],
    [true, true, {}, "hide"], [true, false, {}, "quit"], [true, true, null, "quit"],
  ]) {
    const calls = [];
    const context = vm.createContext({
      quitting: false, tray,
      stateStore: { read: () => ({ coreSetupComplete, keepRunningOnClose }) },
      window: { hide: () => calls.push("hide") },
      requestQuit: () => calls.push("quit"),
    });
    const handler = vm.runInContext(`(${handlerSource})`, context);
    handler({ preventDefault: () => calls.push("prevent-default") });
    assert.deepEqual(calls, ["prevent-default", expected]);
  }
});

test("destroyed browser cancels an outstanding authentication wait immediately", async () => {
  await assert.rejects(BrowserHost.prototype.waitForAuthenticated.call({
    destroyed: true,
    probeAuthentication: async () => { throw new Error("must not probe a closed browser"); },
  }, 5), /cancelled.*closed/);
});

test("queued browser work cannot start after the launcher destroys its views", async () => {
  let activated = false;
  const fixture = {
    destroyed: false,
    ready: async () => { fixture.destroyed = true; },
    activateHomeSurface: () => { activated = true; },
  };
  await assert.rejects(BrowserHost.prototype.withManualOperation.call(fixture, "ChatGPT login", async () => {}), /closed/);
  assert.equal(activated, false);
});

test("quitting during authentication refresh skips startup and route-recovery side effects", async () => {
  const prefix = "} else void ";
  const start = source.indexOf(`${prefix}(async () => {`);
  const end = source.indexOf('\n\n  app.on("activate"', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = vm.createContext({
    startupAuthenticationRefresh: Promise.resolve(),
    shutdownInProgress: true,
    exitCommitted: false,
    runtimeHost: { upgradeManagedRuntime: async () => { calls.push("upgrade"); } },
    restoreCodexRouteAfterRuntimeFailure: async () => { calls.push("restore-route"); return {}; },
    stateStore: { update: () => { calls.push("update-state"); return {}; } },
    logger: { error: () => calls.push("error") },
    send: () => calls.push("send"),
    publishOperation: () => calls.push("publish"),
  });
  await vm.runInContext(source.slice(start + prefix.length, end), context);
  assert.deepEqual(calls, []);
});
