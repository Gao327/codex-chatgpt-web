const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const updaterPath = path.resolve(__dirname, "../electron/update.cjs");
const updaterSource = fs.readFileSync(updaterPath, "utf8");
const releaseApi = "https://api.github.com/repos/Gao327/codex-chatgpt-web/releases/latest";
const assetName = "codex-web-gpt-1.2.0-win-x64.exe";
const releaseBase = "https://github.com/Gao327/codex-chatgpt-web/releases/download/v1.2.0/";
const assetUrl = `${releaseBase}${assetName}`;
const checksumUrl = `${releaseBase}checksums.txt`;
const assetBody = Buffer.from("synthetic fork update; never executable");
const checksumBody = `${crypto.createHash("sha256").update(assetBody).digest("hex")}  ${assetName}\n`;
const cdnBase = "https://release-assets.githubusercontent.com/github-production-release-asset/1357573628/";
const checksumCdn = `${cdnBase}11111111-1111-1111-1111-111111111111?se=synthetic&sig=test%2Bsignature`;
const assetCdn = `${cdnBase}22222222-2222-2222-2222-222222222222?se=synthetic&sig=test%2Bsignature`;

function releaseMetadata(overrides = {}) {
  return JSON.stringify({
    tag_name: "v1.2.0",
    assets: [
      { name: assetName, browser_download_url: overrides.assetUrl ?? assetUrl },
      { name: "checksums.txt", browser_download_url: overrides.checksumUrl ?? checksumUrl },
    ],
  });
}

function harness(t, routes, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-updater-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requested = [];
  const spawned = [];
  const fakeHttps = {
    get(url, options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => request.emit("error", error);
      const address = url.toString();
      requested.push(address);
      assert.equal(options.headers["User-Agent"], "codex-web-gpt-launcher-updater");
      queueMicrotask(() => {
        const reply = routes[address];
        if (!reply) {
          request.emit("error", new Error(`Unexpected network request: ${address}`));
          return;
        }
        const response = Readable.from([Buffer.from(reply.body ?? "")]);
        response.statusCode = reply.status ?? 200;
        response.headers = reply.location ? { location: reply.location } : {};
        callback(response);
      });
      return request;
    },
  };
  const updaterModule = { exports: {} };
  const load = vm.runInNewContext(
    `(function(require, module, exports, __dirname) {\n${updaterSource}\n})`,
    {
      Buffer,
      URL,
      Error,
      process: { ...process, env: { ...process.env, ...env } },
    },
    { filename: updaterPath },
  );
  load((name) => {
    if (name === "node:https") return fakeHttps;
    if (name === "node:os") return { ...os, tmpdir: () => root };
    if (name === "node:child_process") {
      return {
        spawn() { throw new Error("Tests must never execute an installer"); },
        spawnSync() { throw new Error("Tests must never execute an installer"); },
      };
    }
    return require(name);
  }, updaterModule, updaterModule.exports, path.dirname(updaterPath));
  const controller = updaterModule.exports.createUpdateController({
    currentVersion: "1.1.4",
    platform: "win32",
    arch: "x64",
    packaged: true,
    executablePath: path.join(root, "installed-launcher.exe"),
    runtimeExecutable: path.join(root, "bun.exe"),
    logsDirectory: path.join(root, "logs"),
    dependencies: {
      spawnWorker(runtime, worker, jobPath) {
        const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        spawned.push({ runtime, worker, job });
        return { pid: 123, unref() {}, kill() {} };
      },
    },
  });
  return { controller, requested, spawned, root };
}

test("default updater ignores repository and release URL environment overrides", async (t) => {
  const { controller, requested } = harness(t, {
    [releaseApi]: { body: releaseMetadata() },
  }, {
    CODEX_WEB_GPT_REPOSITORY: "miuuyy/codex-chatgpt-web",
    CODEX_CHATGPT_WEB_REPOSITORY: "attacker/codex-chatgpt-web",
    CODEX_WEB_GPT_UPDATE_URL: "https://example.com/release.json",
  });
  assert.equal((await controller.checkOnce()).status, "available");
  assert.deepEqual(requested, [releaseApi]);
});

test("metadata redirects and missing releases fail closed without fallback", async (t) => {
  for (const [name, reply] of [
    ["upstream redirect", { status: 302, location: "https://api.github.com/repos/miuuyy/codex-chatgpt-web/releases/latest" }],
    ["same-fork redirect", { status: 307, location: releaseApi }],
    ["CDN redirect", { status: 302, location: checksumCdn }],
    ["missing release", { status: 404 }],
  ]) {
    await t.test(name, async (t) => {
      const { controller, requested, spawned } = harness(t, { [releaseApi]: reply });
      const state = await controller.checkOnce();
      assert.equal(state.status, "error");
      assert.match(state.message, /unexpected update redirect|HTTP 404/);
      assert.equal((await controller.checkOnce()).status, "error");
      await assert.rejects(controller.beginInstall(), /No launcher update is available/);
      assert.deepEqual(requested, [releaseApi]);
      assert.equal(spawned.length, 0);
    });
  }
});

test("release metadata cannot select a different asset authority or repository", async (t) => {
  const invalidUrls = [
    ["upstream repository", assetUrl.replace("Gao327", "miuuyy")],
    ["another fork", assetUrl.replace("Gao327", "attacker")],
    ["another origin", assetUrl.replace("github.com", "example.com")],
    ["lookalike origin", assetUrl.replace("github.com", "github.com.example.com")],
    ["credentials", assetUrl.replace("https://", "https://name:secret@")],
    ["different port", assetUrl.replace("github.com", "github.com:444")],
    ["query string", `${assetUrl}?download=1`],
    ["fragment", `${assetUrl}#asset`],
    ["plaintext HTTP", assetUrl.replace("https:", "http:")],
    ["another version", assetUrl.replace("/v1.2.0/", "/v1.2.1/")],
    ["another asset", `${releaseBase}other.exe`],
  ];
  for (const [name, untrustedUrl] of invalidUrls) {
    await t.test(name, async (t) => {
      const { controller, requested } = harness(t, {
        [releaseApi]: { body: releaseMetadata({ assetUrl: untrustedUrl }) },
      });
      const state = await controller.checkOnce();
      assert.equal(state.status, "error");
      assert.match(state.message, /unexpected release asset URL/);
      assert.deepEqual(requested, [releaseApi]);
    });
  }
  await t.test("checksum URL is independently bound to the fork", async (t) => {
    const { controller, requested } = harness(t, {
      [releaseApi]: { body: releaseMetadata({ checksumUrl: checksumUrl.replace("Gao327", "miuuyy") }) },
    });
    assert.equal((await controller.checkOnce()).status, "error");
    assert.deepEqual(requested, [releaseApi]);
  });
});

test("default checksum and file downloads accept the fork's single signed CDN hop", async (t) => {
  const { controller, requested, spawned } = harness(t, {
    [releaseApi]: { body: releaseMetadata() },
    [checksumUrl]: { status: 302, location: checksumCdn },
    [checksumCdn]: { body: checksumBody },
    [assetUrl]: { status: 302, location: assetCdn },
    [assetCdn]: { body: assetBody },
  });
  assert.equal((await controller.checkOnce()).status, "available");
  const launch = await controller.beginInstall();
  assert.equal(controller.getState().status, "installing");
  assert.deepEqual(requested, [releaseApi, checksumUrl, checksumCdn, assetUrl, assetCdn]);
  assert.equal(spawned.length, 1);
  assert.deepEqual(fs.readFileSync(spawned[0].job.source), assetBody);
  controller.cancelInstall(launch);
  assert.equal(fs.existsSync(launch.tempRoot), false);
});

test("both checksum and file downloads reject redirects outside the fork's CDN path", async (t) => {
  const invalidRedirects = [
    ["another repository CDN ID", `${cdnBase.replace("1357573628", "123456789")}asset?sig=test`],
    ["upstream GitHub asset", assetUrl.replace("Gao327", "miuuyy")],
    ["another origin", "https://example.com/asset"],
    ["lookalike CDN origin", checksumCdn.replace(".com/", ".com.example.com/")],
    ["plaintext HTTP", checksumCdn.replace("https:", "http:")],
    ["credentials", checksumCdn.replace("https://", "https://name:secret@")],
    ["different port", checksumCdn.replace(".com/", ".com:444/")],
    ["fragment", `${checksumCdn}#asset`],
    ["extra path segment", `${cdnBase}asset/another?sig=test`],
    ["empty asset ID", `${cdnBase}?sig=test`],
  ];
  for (const stage of ["checksums", "asset"]) {
    for (const [name, location] of invalidRedirects) {
      await t.test(`${stage}: ${name}`, async (t) => {
        const routes = {
          [releaseApi]: { body: releaseMetadata() },
          [checksumUrl]: { body: checksumBody },
          [assetUrl]: { body: assetBody },
        };
        routes[stage === "checksums" ? checksumUrl : assetUrl] = { status: 302, location };
        const { controller, requested, spawned, root } = harness(t, routes);
        assert.equal((await controller.checkOnce()).status, "available");
        await assert.rejects(controller.beginInstall(), /untrusted update URL|outside the trusted fork/);
        assert.deepEqual(requested, stage === "checksums" ? [releaseApi, checksumUrl] : [releaseApi, checksumUrl, assetUrl]);
        assert.equal(spawned.length, 0);
        assert.equal(controller.getState().status, "available");
        assert.deepEqual(fs.readdirSync(root), []);
      });
    }
  }
});

test("a second CDN redirect is rejected even when it points to the trusted fork", async (t) => {
  for (const stage of ["checksums", "asset"]) {
    await t.test(stage, async (t) => {
      const routes = {
        [releaseApi]: { body: releaseMetadata() },
        [checksumUrl]: { body: checksumBody },
        [assetUrl]: { body: assetBody },
      };
      const original = stage === "checksums" ? checksumUrl : assetUrl;
      const firstHop = stage === "checksums" ? checksumCdn : assetCdn;
      routes[original] = { status: 302, location: firstHop };
      routes[firstHop] = { status: 307, location: `${cdnBase}another-asset?sig=test` };
      const { controller, requested, spawned } = harness(t, routes);
      await controller.checkOnce();
      await assert.rejects(controller.beginInstall(), /unexpected update redirect/);
      assert.deepEqual(requested, stage === "checksums"
        ? [releaseApi, checksumUrl, firstHop]
        : [releaseApi, checksumUrl, assetUrl, firstHop]);
      assert.equal(spawned.length, 0);
    });
  }
});

test("fork downloads still require the exact published SHA-256 before worker handoff", async (t) => {
  const { controller, spawned, root } = harness(t, {
    [releaseApi]: { body: releaseMetadata() },
    [checksumUrl]: { body: checksumBody },
    [assetUrl]: { body: "tampered synthetic content" },
  });
  await controller.checkOnce();
  await assert.rejects(controller.beginInstall(), /SHA-256 verification failed/);
  assert.equal(spawned.length, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});
