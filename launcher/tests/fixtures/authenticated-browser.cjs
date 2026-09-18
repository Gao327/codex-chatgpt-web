const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { AuthenticatedCdpServer } = require("../../electron/authenticated-cdp.cjs");

const scratch = process.env.CODEX_CDP_TEST_HOME;
if (!scratch || !path.isAbsolute(scratch)) throw new Error("An isolated test profile is required");
app.setPath("userData", path.join(scratch, "profile"));
app.commandLine.removeSwitch("remote-debugging-port");
let server;
const windows = [];
app.whenReady().then(async () => {
  for (let index = 0; index < 2; index++) {
    const window = new BrowserWindow({
      width: 800,
      height: 600,
      show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    windows.push(window);
    await window.loadURL(`data:text/html,<title>Transport fixture ${index}</title><input id=text><input id=file type=file>`);
    // Native window bounds do not guarantee a non-zero Chromium viewport under Xvfb.
    // Match the explicit renderer sizing used for background turns in browser-host.cjs.
    window.webContents.enableDeviceEmulation({
      screenPosition: "desktop",
      screenSize: { width: 800, height: 600 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: 800, height: 600 },
      scale: 1,
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const viewport = await window.webContents.executeJavaScript(`({
        width: innerWidth, height: innerHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        visibility: document.visibilityState,
      })`);
      if (viewport.width === 800 && viewport.height === 600) break;
      if (Date.now() > deadline) throw new Error(`Transport fixture ${index} viewport did not initialize: ${JSON.stringify(viewport)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  server = await new AuthenticatedCdpServer({
    token: process.env.CODEX_CDP_TEST_TOKEN,
    getWebContents: surface => {
      const index = ["a".repeat(32), "b".repeat(32)].indexOf(surface);
      return windows[index]?.webContents;
    },
  }).start();
  fs.writeFileSync(path.join(scratch, "ready.json"), JSON.stringify({ port: server.port }), { mode: 0o600 });
}).catch(error => { console.error(error); app.exit(1); });
process.on("SIGTERM", async () => {
  await server?.close();
  windows.forEach(window => window.destroy());
  app.quit();
});
setTimeout(() => app.exit(2), 45_000).unref();
