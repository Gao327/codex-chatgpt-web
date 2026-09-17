# Security follow-up and signed-out exit fix — 2026-09-17

This review covers the local `security/local-session-hardening` worktree, based on
`9a7428a9d1fced9baaa85112994c02c011a3b7c9`, including the earlier uncommitted
hardening changes. Its conclusions do not cover unverified upstream installers or
future updates. The review did not use a real ChatGPT account, read or delete
historical account files, or push code.

This follow-up confirmed several previously missed issues and fixed them in the
source. No implementation that could be confirmed to send credentials to the
author's private server was found. A limited code review and isolated tests cannot
prove that no backdoors or unknown vulnerabilities exist.

## Confirmed issues and fixes

### 1. Medium: a pending login prevented the application from quitting

The original `requestQuit()` treated browser login and session checks as
non-interruptible operations, alongside installation transactions. An ordinary
login wait could last 180 seconds, during which quit requests were rejected. The
initial setup also enabled “keep running in the background” by default, so closing
the window could merely hide it. This matched the reported behavior, and the
regression tests failed before the fix.

After the fix, closing the window before setup is complete exits the application,
and an ordinary browser login no longer blocks quitting. Cancelling passkey login
terminates its own temporary child process and waits for cleanup: a five-second
grace period is followed by forced termination and a two-second cleanup deadline.
Installation transactions remain protected. Destroying the browser stops the login
wait and rejects queued browser operations. The asynchronous startup chain also
checks shutdown state to avoid starting services or restoring configuration during
exit.

Evidence and implementation: `launcher/electron/main.cjs:349,862`;
`launcher/electron/browser-host.cjs:2669,2792,2843`;
`launcher/electron/runtime.cjs:376`. Regression coverage is in
`launcher/tests/quit.test.cjs` and the passkey process tests.

### 2. Medium: the authenticated browser gateway still exposed profile-wide cookie and cache commands

The earlier protection rejected `Browser.*` and `Storage.*`, but continued to
forward commands such as `Network.getAllCookies` and
`Network.clearBrowserCookies`. Tests using a temporary Electron profile and fake
cookies reproduced the issue: one surface could read another surface's cookies in
the shared profile and clear cookies globally.

An attacker would first need a valid random bearer token and surface ID. This was
not an unauthenticated remote entry point, and it is not evidence of a backdoor.
The gateway now rejects seven profile-wide cookie and cache commands across root,
page, and child sessions. Page network observation, input, uploads, screenshots,
and reconnection remain available. Implementation:
`launcher/electron/authenticated-cdp.cjs:5`; regression tests:
`launcher/tests/authenticated-cdp.test.cjs`.

Browser tabs still share a login session, and authorized automation can still
operate its own page. These restrictions do not provide complete account
isolation from a bearer-token holder.

### 3. Medium: Luna continuation summaries bypassed the primary cache's no-store fix

Luna rolling checkpoints separately wrote to `runtime/luna-checkpoints.json`.
Their summaries could contain task goals, evidence, and private content, but the
commit path did not check `store:false`. The checkpoint cache is now entirely
memory-only. A later `store:true` request cannot write earlier private summaries to
disk. After a restart, expiry, or parent-answer mismatch, the adapter falls back to
the complete Codex history.

Implementation: `src/adapters/chatgpt-web/rolling-checkpoint.ts:235`, together with
removal of the related adapter and configuration paths. Regression tests:
`tests/rolling-checkpoint.test.ts` and `tests/chatgpt-web-harness.test.ts`.
Old checkpoint files are no longer read, but this review did not scan for or delete
them.

### 4. Medium: diagnostic text could retain private content even with screenshots disabled

Diagnostic JSON previously recorded full URLs, titles, menu, overlay, and status
text, and error messages that could quote page content by default. The existing
`CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` switch now controls collection of all
this content. The default output retains counts, geometry, control state, and
fixed error categories. Implementation:
`src/adapters/chatgpt-web/browser-worker.ts:1682`.

Regression tests execute the actual page collection callback and inspect the
written JSON and PNG files. They cover default behavior, explicit opt-in, and
collection failures. Changing the code does not automatically remove existing
diagnostic files or screenshots.

### 5. Dependency advisories: minimal version upgrades, with no confirmed exploit path through login

- Hono was upgraded from 4.12.34 to 4.13.5 to address three moderate advisories
  identified in this audit. The application uses the SDK through MCP stdio and
  serves HTTP through `Bun.serve`; no call path to the affected Hono routing,
  form-parsing, or SSG features was found. See the official
  [form-parsing advisory](https://github.com/honojs/hono/security/advisories/GHSA-g6gw-c38x-mqfc),
  [SSG advisory](https://github.com/honojs/hono/security/advisories/GHSA-gqvv-2mrq-wpjv),
  and [query-parsing advisory](https://github.com/honojs/hono/security/advisories/GHSA-crvj-82cr-hjcx).
- js-yaml was upgraded from 4.3.1 to 4.3.2 to address a high-severity advisory
  concerning CPU consumption from empty merge sources. It is introduced by
  electron-builder's build dependencies; no runtime entry point accepting
  user-supplied YAML was found. See the
  [official advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh).

Only the relevant dependency versions and lockfile records were updated. An
advisory's severity does not establish an equally severe exploitable path in this
application.

## Validation scope

### Initial security follow-up

- The complete `bun run verify` passed: 650 core tests and 310 launcher tests
  passed, with one skipped. Both dependency audits reported no known
  vulnerabilities. Type checks, renderer and runtime builds, and the relocatable
  runtime smoke test passed.
- After the final startup and shutdown race protection was added, the entire
  launcher suite was rerun: 311 tests passed and one was skipped, including eight
  quit regression tests. The final initial-review total was **961 tests passed,
  one skipped**.
- The browser command restrictions were tested through real local WebSocket
  connections and a temporary Electron profile. Page input, uploads, screenshots,
  separate surfaces, and reconnection passed. Passkey cancellation used temporary
  Node test programs, without starting a real login.
- The macOS arm64 package built successfully, and `bun run app:smoke` returned
  `PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64`. This test starts the packaged
  application with a temporary empty profile and a simulated pending-login flag,
  follows the actual `requestQuit()` path, and confirms `will-quit`. It does not
  establish end-to-end acceptance of real account login or MFA.
- The initial-review artifacts were
  `launcher/artifacts/codex-web-gpt-5.0.1-mac-arm64.zip` and the matching `.dmg`,
  generated on 2026-09-17 at 20:49 (Asia/Singapore). They were not installed or
  published. The final `git diff --check` passed.

### Subsequent fork-only update hardening

The subsequent update-source restrictions are documented in
[Security hardening](security-hardening.md). The local verification log at
`/tmp/codex-fork-only-verify.log` records a later complete `bun run verify`:
650 core tests and 371 launcher tests passed, with one launcher test skipped and
no failures. The combined total was **1,021 tests passed, one skipped**. Both
dependency audits again reported no known vulnerabilities (106 root packages and
352 launcher packages), and the relocatable runtime smoke test passed.

These are successive validation snapshots, not cumulative test counts. The later
snapshot supersedes the initial test total for the worktree with fork-only update
hardening. Neither snapshot establishes that code was pushed or a release was
published.

## Remaining trust boundaries and limitations

1. After login, the application and its dependencies control a valid ChatGPT
   session. Malicious software running as the same OS user, a tampered installer,
   and future updates remain trust risks. Network traffic after real account
   login was not audited.
2. Full mode can invoke tools authorized by the current Codex configuration.
   Prompt-injection risk remains subject to the Codex sandbox and approval
   settings.
3. Update files and checksums come from the same publishing account. Repository
   restrictions and checksum verification cannot establish that the publisher
   has not been compromised. The local macOS build is ad-hoc signed and must not
   be treated as an independently certified or notarized release.
4. Historical Luna summaries, diagnostic text, and screenshots may remain on
   disk. They were not read or cleaned up during this review; the new policy
   governs new runs.
5. IPC could be hardened further with consistent sender validation. No actual
   exploit chain was demonstrated in this review: remote browser pages do not
   receive the main window's preload, and main-window navigation is restricted.
   This was therefore not classified as a confirmed exploitable vulnerability.

This report does not guarantee that there are no other bugs. Real account login,
MFA, connectors, and complete model-task workflows have not undergone end-to-end
acceptance testing. The evidence primarily establishes the specific fixes and the
results of isolated tests that did not use a real account.
