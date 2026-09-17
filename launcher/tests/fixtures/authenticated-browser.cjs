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
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    windows.push(window);
    await window.loadURL(`data:text/html,<title>Transport fixture ${index}</title><input id=text><input id=file type=file>`);
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
