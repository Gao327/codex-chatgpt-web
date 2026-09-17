const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const electron = require("electron");

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cdp-smoke-"));
  const token = randomBytes(32).toString("base64url");
  const env = { ...process.env, CODEX_CDP_TEST_HOME: scratch, CODEX_CDP_TEST_TOKEN: token };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(__dirname, "../tests/fixtures/authenticated-browser.cjs")], {
    env, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-4_000); });
  const exited = once(child, "exit");
  const browsers = [];
  try {
    const marker = path.join(scratch, "ready.json");
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(marker)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Isolated Electron did not start: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const { port } = JSON.parse(fs.readFileSync(marker, "utf8"));
    const endpoint = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${endpoint}/json/version`)).status, 401);
    assert.equal((await fetch(`${endpoint}/json/version`, {
      headers: { authorization: "Bearer incorrect" },
    })).status, 401);
    assert.equal((await fetch(`${endpoint}/json/version`, {
      headers: { authorization: `Bearer ${token}`, origin: "https://untrusted.example" },
    })).status, 401);
    assert.equal((await fetch(`${endpoint}/json/version`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 200);
    for (const surface of ["a".repeat(32), "b".repeat(32)]) {
      const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/devtools/browser/${surface}`, {
        noDefaults: true, timeout: 10_000, headers: { authorization: `Bearer ${token}` },
      });
      browsers.push(browser);
      assert.equal(browser.contexts().length, 1);
      assert.equal(browser.contexts()[0].pages().length, 1);
    }
    const page = browsers[0].contexts()[0].pages()[0];
    const other = browsers[1].contexts()[0].pages()[0];
    await page.fill("#text", "Only the first surface");
    assert.equal(await page.inputValue("#text"), "Only the first surface");
    assert.equal(await other.inputValue("#text"), "");
    await page.setInputFiles("#file", { name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("non-sensitive fixture") });
    assert.equal(await page.locator("#file").evaluate(element => element.files[0].name), "fixture.txt");
    assert.ok((await page.screenshot()).length > 0);
    await browsers.shift().close();
    const reconnected = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/devtools/browser/${"a".repeat(32)}`, {
      noDefaults: true, timeout: 10_000, headers: { authorization: `Bearer ${token}` },
    });
    browsers.push(reconnected);
    assert.equal(await reconnected.contexts()[0].pages()[0].inputValue("#text"), "Only the first surface");
    console.log("AUTHENTICATED_BROWSER_SMOKE_OK: unauthorized access rejected; isolated surfaces, input, upload, screenshot, reconnect verified");
  } finally {
    await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
    child.kill("SIGTERM");
    await exited;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
