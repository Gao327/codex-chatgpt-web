const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const repository = "Gao327/codex-chatgpt-web";
const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/1357573628/test-asset?token=synthetic";
const shellOptions = { skip: process.platform === "win32" ? "POSIX installers require /bin/sh" : false };
const shellInstallers = [
  { script: "install-launcher.sh", prefix: "CODEX_WEB_GPT", asset: "codex-web-gpt-1.2.3-mac-arm64.zip" },
  { script: "install.sh", prefix: "CODEX_CHATGPT_WEB", asset: "codex-chatgpt-web-darwin-arm64.tar.gz" },
];

function runInstaller(installer, routes, overrides = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fork-installer-"));
  try {
    const bin = path.join(temporary, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "uname"), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi\n', { mode: 0o755 });
    const log = path.join(temporary, "requests.jsonl");
    const routePath = path.join(temporary, "routes.json");
    fs.writeFileSync(routePath, JSON.stringify(routes));
    // A fake transport runs the real installer without internet or installation.
    // Every success path stops at checksum verification of synthetic asset data.
    fs.writeFileSync(path.join(bin, "curl"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const url = args.at(-1);
fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify({ url, args }) + "\\n");
if (args[0] !== "--disable" || args.includes("--location") || args.includes("-L")) process.exit(98);
const response = JSON.parse(fs.readFileSync(process.env.FAKE_CURL_ROUTES, "utf8"))[url];
if (!response) process.exit(99);
if (args.includes("--dump-header")) fs.writeFileSync(args[args.indexOf("--dump-header") + 1],
  "HTTP/1.1 " + response.status + "\\r\\n" + (response.location ? "Location: " + response.location + "\\r\\n" : "") + "\\r\\n");
fs.writeFileSync(args[args.indexOf("--output") + 1], response.body || "synthetic asset");
process.stdout.write(String(response.status));
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: temporary,
      FAKE_CURL_LOG: log, FAKE_CURL_ROUTES: routePath,
      CODEX_WEB_GPT_REPOSITORY: "", CODEX_CHATGPT_WEB_REPOSITORY: "",
      CODEX_WEB_GPT_APPLICATIONS_DIR: path.join(temporary, "applications"),
      CODEX_CHATGPT_WEB_LIB_DIR: path.join(temporary, "lib"),
      CODEX_CHATGPT_WEB_BIN_DIR: path.join(temporary, "installed-bin"),
      CODEX_CHATGPT_WEB_DOC_DIR: path.join(temporary, "docs"),
      [`${installer.prefix}_VERSION`]: "1.2.3", ...overrides };
    const result = spawnSync("/bin/sh", [path.join(root, "scripts", installer.script)], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.error, undefined);
    const requests = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
    for (const { args } of requests) {
      assert.equal(args[args.indexOf("--proto") + 1], "=https");
      assert.equal(args[args.indexOf("--max-redirs") + 1], "0");
    }
    return { ...result, requests: requests.map(({ url }) => url) };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

for (const installer of shellInstallers) {
  const assetUrl = `https://github.com/${repository}/releases/download/v1.2.3/${installer.asset}`;
  const checksumsUrl = `https://github.com/${repository}/releases/download/v1.2.3/checksums.txt`;
  test(`${installer.script} rejects repository overrides before any network request`, shellOptions, () => {
    for (const value of ["miuuyy/codex-chatgpt-web", "another/fork", "Gao327/codex-chatgpt-web/../other"]) {
      const result = runInstaller(installer, {}, { [`${installer.prefix}_REPOSITORY`]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /repository overrides are forbidden/);
      assert.deepEqual(result.requests, []);
    }
  });

  test(`${installer.script} fetches only fork assets and still enforces checksums`, shellOptions, () => {
    const result = runInstaller(installer, {
      [assetUrl]: { status: 200 }, [checksumsUrl]: { status: 200, body: `${"0".repeat(64)}  ${installer.asset}\n` },
    }, { [`${installer.prefix}_REPOSITORY`]: repository });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 verification failed/);
    assert.deepEqual(result.requests, [assetUrl, checksumsUrl]);
  });

  test(`${installer.script} allows one redirect to this fork's release CDN`, shellOptions, () => {
    const result = runInstaller(installer, {
      [assetUrl]: { status: 302, location: cdn }, [cdn]: { status: 200 },
      [checksumsUrl]: { status: 200, body: `${"0".repeat(64)}  ${installer.asset}\n` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 verification failed/);
    assert.deepEqual(result.requests, [assetUrl, cdn, checksumsUrl]);
  });

  test(`${installer.script} rejects repository, foreign CDN, and traversal redirects`, shellOptions, () => {
    for (const location of [
      "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.3/asset.zip",
      "https://release-assets.githubusercontent.com/github-production-release-asset/12345/asset",
      "https://release-assets.githubusercontent.com/github-production-release-asset/1357573628/../12345/asset",
      "https://release-assets.githubusercontent.com/github-production-release-asset/1357573628/%2e%2e%2f12345",
      "https://release-assets.githubusercontent.com.evil.invalid/github-production-release-asset/1357573628/asset",
      "https://release-assets.githubusercontent.com@evil.invalid/github-production-release-asset/1357573628/asset",
      "https://release-assets.githubusercontent.com:8443/github-production-release-asset/1357573628/asset",
      "http://release-assets.githubusercontent.com/github-production-release-asset/1357573628/asset",
    ]) {
      const result = runInstaller(installer, { [assetUrl]: { status: 302, location } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing a release redirect/);
      assert.deepEqual(result.requests, [assetUrl]);
    }
  });

  test(`${installer.script} rejects a second redirect even from the trusted CDN`, shellOptions, () => {
    const result = runInstaller(installer, {
      [assetUrl]: { status: 302, location: cdn }, [cdn]: { status: 302, location: `${cdn}&next=1` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /further redirects are forbidden/);
    assert.deepEqual(result.requests, [assetUrl, cdn]);
  });

  test(`${installer.script} rejects version path traversal before downloading`, shellOptions, () => {
    const result = runInstaller(installer, {}, { [`${installer.prefix}_VERSION`]: "../../other" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid release version/);
    assert.deepEqual(result.requests, []);
  });
}

test("launcher installer never follows release metadata redirects or falls back after missing releases", shellOptions, () => {
  const url = `https://api.github.com/repos/${repository}/releases/latest`;
  for (const response of [
    { status: 302, location: "https://api.github.com/repos/miuuyy/codex-chatgpt-web/releases/latest" },
    { status: 302, location: cdn },
    { status: 404 },
  ]) {
    const result = runInstaller(shellInstallers[0], { [url]: response }, { CODEX_WEB_GPT_VERSION: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repository redirects are forbidden/);
    assert.deepEqual(result.requests, [url]);
  }
});

test("Windows installer fixes the repository and checks each HTTP redirect before following", () => {
  const source = fs.readFileSync(path.join(root, "scripts/install-launcher.ps1"), "utf8");
  assert.match(source, /\$Repository = "Gao327\/codex-chatgpt-web"/);
  assert.match(source, /\$env:CODEX_WEB_GPT_REPOSITORY -cne \$Repository/);
  assert.match(source, /\$Request\.AllowAutoRedirect = \$false/);
  assert.match(source, /\$Asset -and \$Hop -eq 0/);
  assert.match(source, /-cnotmatch '\^https:\/\/release-assets/);
  assert.match(source, /github-production-release-asset\/1357573628\//);
  assert.match(source, /Invoke-ForkDownload -Url "https:\/\/api\.github\.com\/repos\/\$Repository\/releases\/latest" \| ConvertFrom-Json/);
  assert.match(source, /Invoke-ForkDownload -Url "\$BaseUrl\/\$Asset" -OutFile \$Installer -TimeoutSec 900 -Asset/);
  assert.match(source, /Invoke-ForkDownload -Url "\$BaseUrl\/checksums\.txt" -OutFile \$Checksums -TimeoutSec 60 -Asset/);
  assert.doesNotMatch(source, /Invoke-WebRequest|Invoke-RestMethod/);
});
