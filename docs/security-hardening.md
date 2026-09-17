# Security hardening for this fork

These changes were made on `security/local-session-hardening`, based on upstream commit
`9a7428a9d1fced9baaa85112994c02c011a3b7c9`. They are source changes, not evidence that an existing
upstream installer or a future release has the same protections.
The [2026-09-17 follow-up review](security-follow-up-2026-09-17.md) documents additional fixes,
including quitting before login, Luna summary retention, and content diagnostics.

## What changed

| Attack surface | Protection in this fork |
| --- | --- |
| Unauthenticated Chromium debugging could control a signed-in browser | Removed the raw debugging listener. A bearer-authenticated gateway uses Electron's in-process debugger and exposes only the requested owned browser surface. It rejects unrelated targets and browser-wide storage/control commands. |
| Other local callers could use the Responses API without a bridge credential | Added a per-installation secret URL path, exact Host checks, rejection of browser origins/fetch metadata, and JSON-only model POST requests. Native Codex authorization is preserved for upstream requests. |
| A restrictive tool choice could be accepted but ignored | Reject non-auto choices before starting or replaying a ChatGPT turn. Unsupported restrictions produce HTTP 400. |
| `store:false` conversations could enter the response snapshot | Keep default/no-store continuation in memory. Only explicit `store:true` chains without memory-only ancestors can enter the disk cache. Delete legacy snapshots on load and expire cached data after one hour. |
| Failure and stall screenshots could retain visible private content | Disable all browser diagnostic screenshots by default. Capture requires an explicit environment setting. |
| An upstream update could replace the fork's protections | Lock the updater and installers to `Gao327/codex-chatgpt-web`; reject other repositories and fail when a fork release is unavailable. |
| Compromised mutable CI actions or excessive build permissions | Pin third-party actions to commit hashes, disable persisted checkout credentials, and grant release-write permission only to the publishing job. |

## Before using this build

Quit older launchers and bridge processes before switching versions. Start the launcher from this
reviewed checkout with Bun 1.4.0 using `bun run app`. No fork release should be assumed to contain
these changes until it has been built from them and published. Do not use an upstream installer to
update this fork.

The only permitted application and core-runtime release source is
[`Gao327/codex-chatgpt-web`](https://github.com/Gao327/codex-chatgpt-web/releases). This is a fixed
policy, not a configurable default: the installers reject repository environment overrides that
select another repository, and the in-app updater rejects foreign release assets. Missing fork
releases, failed requests, or invalid assets must stop the update; there is no upstream fallback.
The launcher upgrades its managed runtime from the runtime bundled with the installed app. Release
CI builds and publishes only in `Gao327/codex-chatgpt-web`, with an explicit publication destination.

Release metadata requests must not redirect. An asset download may follow exactly one HTTPS hop
to `release-assets.githubusercontent.com/github-production-release-asset/1357573628/`, which pins
the fork's GitHub repository ID as well as its name. Other repositories, metadata redirects, and
further CDN redirects are rejected before the next request. Install/update instructions run the
local installer from a reviewed fork checkout so that these checks execute before downloading
release content; they do not bootstrap an installer by piping a redirected download into a shell.

This restriction prevents an upstream release from silently replacing these protections. It does
not establish that every future fork release is safe: review imported changes and dependencies
before publishing. GitHub-hosted release delivery still uses GitHub's asset infrastructure, and
build dependencies plus OpenAI's pinned tunnel client have their own separately reviewed sources.

The browser transport descriptor is now version 3. Old descriptors are rejected; the updated
launcher and helper must run together. Existing installations need their Codex route upgraded via
Setup or Connect, followed by a Codex restart. The authenticated route is reversible using the
existing Disconnect/Uninstall operations.

The local Responses base URL contains a secret. Do not share Codex configuration, integration
journals, or unredacted client logs. Bridge status and launcher logs redact the secret path, but
external clients may log it themselves. If it is exposed, stop the bridge, rotate its private
control key, and reconnect the route before restarting Codex.

No-store continuation survives only while the bridge process remains running and within the cache
limits. Starting a new task may be necessary after a restart. An explicit `store:true` request
does not override a no-store ancestor. Legacy response snapshots are deleted when the updated
cache first loads. Expired snapshots cannot be deleted while the application is stopped; cleanup
occurs on the next load. File deletion is best effort and does not erase filesystem backups.

Luna rolling summaries now stay in memory regardless of storage flags; old `luna-checkpoints.json`
files are no longer read but are not deleted automatically. Restarting falls back to Codex history.

`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` explicitly enables screenshots and page-content diagnostics
(full URLs, titles, UI text and error messages). Use it only for a deliberate diagnostic session.
Existing files are not deleted during an upgrade. Default diagnostics retain only structural
metadata. The cache policy does not control Codex history, the Electron profile, operating-system
caches, or OpenAI retention.

## Validation

The repository's `bun run verify` checks dependency advisories, TypeScript, root and launcher tests,
the renderer build, runtime bundling, license generation, and the compiled runtime smoke test.
`bun run launcher:smoke-browser` separately exercises the new transport in real Electron with an
empty temporary profile: unauthorized access, independent surfaces, text input, file upload,
screenshots, and reconnect. On headless Linux it requires `xvfb-run -a`.

The regression suite also covers browser-wide command bypass attempts, unrelated targets, stale
commands after reconnect, surface revocation, API authentication and Host checks, tool-choice
rejection, privacy-cache persistence/expiry, screenshot opt-in, and route upgrade/restore.

Local transport validation uses fixture pages. It does not sign in to ChatGPT and does not prove
that current account-specific login, MFA, connector, or model flows succeed. Cross-platform CI and
real-account acceptance remain separate from a local source review.

Local validation on macOS arm64 (2026-09-05): `bun run verify` passed with 646 root tests and 299
launcher tests passing (one platform-specific skip). Both dependency audits reported no known
vulnerabilities. Type checks, renderer/runtime builds, and the relocatable runtime smoke passed.
The separate authenticated Electron transport smoke also passed. `bun run app:package` and
`bun run app:smoke` passed for macOS arm64, including startup and installed-runtime integrity from
the packaged app in a temporary profile. The locally built app is ad-hoc signed and is not a
notarized publisher release. Advisory checks are a snapshot, not proof that dependencies have no
undiscovered vulnerabilities.

The fork-only update follow-up on 2026-09-17 passed `bun run verify`: 650 core tests and
371 launcher tests passed, with one platform-specific skip; both dependency audits were clear.
The tests exercise real updater download/checksum code with a fake HTTPS transport and run the
POSIX installers with fake network responses. They cover fixed sources, repository overrides,
missing releases, foreign/second redirects, and checksum rejection without installing an update.
The Windows installer has source-contract coverage; native PowerShell execution was not available
on this Mac. The rebuilt macOS arm64 package passed `bun run app:smoke`, and its embedded updater
was extracted and compared byte-for-byte with the reviewed local source. No installed app was
replaced and no GitHub release was published.

## Remaining trust

Signing in gives this application control of an authenticated browser session. The launcher,
runtime, their dependencies, and programs running as your OS user must still be trusted. These
changes remove concrete unauthenticated access paths; they do not make the application immune to
session theft or malicious future code.

Full harness mode lets model output request powerful Codex tools. Prompt injection remains a risk;
Codex's sandbox and approval settings still define what those tools may do. Browser-only mode
avoids that tool path but still grants this application access to the signed-in page.

Release checksums from the same publisher detect corruption, not a compromised publisher. This
work does not establish independently signed release provenance. Review future updates before
trusting them with a valuable account.
