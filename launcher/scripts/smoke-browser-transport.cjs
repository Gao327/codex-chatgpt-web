const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const electron = require("electron");
const createEffortPickerFixture = require("../tests/fixtures/effort-picker.cjs");

async function smokeEffortPicker(page, scratch) {
  const bundledSession = path.join(scratch, "chatgpt-session.cjs");
  const build = spawnSync("bun", [
    "build", path.join(__dirname, "../../src/chatgpt-session.ts"),
    "--target", "node", "--format", "cjs", "--outfile", bundledSession,
  ], { encoding: "utf8", timeout: 20_000 });
  if (build.error || build.status !== 0) {
    throw new Error(`Could not bundle the effort-picker regression: ${build.error?.message || build.stderr}`);
  }
  const { detectChatGptAccountCapabilities } = require(bundledSession);
  async function inspectFixture(options) {
    await page.setContent(createEffortPickerFixture(options));
    let timer;
    try {
      return await Promise.race([
        detectChatGptAccountCapabilities(page),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            "Effort-picker regression timed out: the closed menu must recover through click and pointerdown",
          )), 8_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  assert.deepEqual(await inspectFixture(), { solAvailable: true, proAvailable: true });
  assert.deepEqual(await page.evaluate(() => window.effortFixture), {
    clicks: 1, pointerdowns: 2, enters: 0, escapes: 3,
  });
  assert.equal(await page.locator("#effort-menu").isVisible(), false);
  assert.equal(await page.locator("#effort-control").getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator('[role="slider"]').getAttribute("aria-valuenow"), "3");

  assert.deepEqual(await inspectFixture({ ghost: false }), { solAvailable: true, proAvailable: true });
  assert.deepEqual(await page.evaluate(() => window.effortFixture), {
    clicks: 1, pointerdowns: 1, enters: 0, escapes: 1,
  });
  assert.equal(await page.locator("#effort-menu").isVisible(), false);

  await assert.rejects(inspectFixture({ ghost: false, max: 6 }), /ChatGPT model controls are unavailable/);
  assert.equal(await page.locator("#effort-menu").isVisible(), false);
  assert.equal(await page.locator("#effort-control").getAttribute("aria-expanded"), "false");
  console.log("EFFORT_PICKER_SMOKE_OK: normal and ghost activation; owned visible slider overrides hidden model rows; invalid range rejected; menus closed");
}

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
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.deepEqual(viewport, { width: 800, height: 600 }, "The transport fixture must expose a real renderer viewport");
    const screenshot = await page.screenshot({ type: "png", scale: "css" });
    assert.equal(screenshot.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual({ width: screenshot.readUInt32BE(16), height: screenshot.readUInt32BE(20) }, viewport,
      "The authenticated transport must capture the complete renderer viewport");
    await browsers.shift().close();
    const reconnected = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/devtools/browser/${"a".repeat(32)}`, {
      noDefaults: true, timeout: 10_000, headers: { authorization: `Bearer ${token}` },
    });
    browsers.push(reconnected);
    assert.equal(await reconnected.contexts()[0].pages()[0].inputValue("#text"), "Only the first surface");
    console.log("AUTHENTICATED_BROWSER_SMOKE_OK: unauthorized access rejected; isolated surfaces, input, upload, screenshot, reconnect verified");
    await smokeEffortPicker(reconnected.contexts()[0].pages()[0], scratch);
  } finally {
    await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
    child.kill("SIGTERM");
    await exited;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
