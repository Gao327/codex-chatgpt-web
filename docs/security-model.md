# Security model

## Trust boundaries

The user trusts the local Codex app, this loopback daemon, the launcher's private Electron browser
profile, the selected ChatGPT workspace, OpenAI's tunnel service, and the exact MCP connector they
created. Repository contents, tool output, websites, and prompt text are untrusted data.

## Full-mode capability flow

1. The daemon accepts a Codex Responses turn on `127.0.0.1` only through the installation's secret
   URL path, with an exact loopback Host and no browser Origin or fetch-site header.
2. It extracts `cwd`, workspace roots, sandbox policy, and the tool registry only from the native
   Codex wire envelope with matching turn metadata. A user-authored `<environment_context>` is not
   accepted as authority.
3. It creates a random, turn-scoped token and embeds it in that one ChatGPT browser prompt.
4. Every Codex Native action presents that same turn token. The MCP handler idempotently claims an
   internal binding plus a request-scoped activity lease and immediately dispatches the requested
   action; neither internal handle is exposed to the model. The lease is settled only after the MCP
   handler finishes, including inventory calls that need no outer Codex tool.
5. MCP can request only a callable tool advertised by the active outer Codex turn. The unrestricted
   raw orchestration `exec` gateway remains available in Full mode. Before caller-authored
   JavaScript runs, the bridge wraps its tool registry with a transparent proxy that enforces the
   exact 10-second `wait_agent` polling contract and prevents recursive raw `exec`. The generic
   inventory/call pair also provides a structured exact-name path. Codex remains responsible for
   its sandbox, approval, UI, command sessions, and tool result.
6. Before a Codex tool batch is dispatched, the browser records and acknowledges the current answer
   projection. Completion stays blocked while the tool is unresolved and then requires a new stable
   final-answer projection after that causal boundary. A two-phase broker fence then rereads the DOM
   and commits completion only if the activity revision stayed unchanged with no active invocation;
   a concurrent claim makes the candidate lose, while a claim after commit receives an explicit
   terminal rejection. Recent MCP activity may suppress a false DOM-health failure but never adds
   an idle delay to a successful completion.

The bridge transports decisions; it does not add a second planner, semantic router, or fallback
model. Every available effort uses the same MCP contract. An unavailable account route, missing
connector, or missing outer tool fails explicitly instead of becoming an effort-specific exception.
The ChatGPT adapter rejects restrictive `tool_choice` values before starting a turn, including
`none`, `required`, named tools, and subsets. It supports only omitted or `auto` selection; it must
not silently broaden a caller's requested tool restrictions.

The direct turn-token MCP schema is attached only through the `Codex Native2` connector identity.
The pre-v4 `Codex Native` connector is treated as legacy and is never selected as a fallback. This
prevents a cached legacy schema from being mistaken for the current capability contract.

## Principal risks

### Prompt injection and destructive tool use

ChatGPT sees repository content and tool results that may contain hostile instructions. Full mode
can invoke write and command tools. Use a trusted workspace, keep Codex sandbox/approval settings
appropriate, and grant only intended connector actions. Automatic per-call approval is off by
default.

### Browser session theft

The launcher's persistent Electron partition can authorize ChatGPT access. It remains in the
current OS user's private application-data directory and is never copied into a daemon prompt or
runtime descriptor. Never sync, upload, attach, or commit it. On suspected exposure, sign out or
revoke the ChatGPT session from the launcher.

Chromium's raw remote-debugging TCP/pipe switches are disabled. Automation instead uses a
loopback WebSocket gateway with a private bearer key, an exact Host check, no browser Origin, and
one explicitly owned page surface per connection. It attaches through Electron's in-process
debugger and denies browser-wide storage/control and unrelated target attachment. Manual mode
does not expose an automation surface. This closes unauthenticated browser control; the trusted
launcher and its authenticated runtime can still read and operate the signed-in page.

### Tunnel credential theft

The runtime key needs only Tunnels Read + Use. It is accepted through a hidden prompt or copied
from a file, stored with user-only permissions, referenced by file, and never placed in a command
argument or generated profile. Rotate it after suspected exposure.

### Same-user local process

The Responses endpoint is loopback-only and requires an installation-specific URL capability at
`/bridge/<secret>/v1`. The secret is derived from the private control key using a distinct HMAC
purpose, so it does not reveal the lifecycle bearer key. This keeps Codex's native Authorization
header available for official upstream requests. Plain `/v1` access is denied; browser-origin
requests and unexpected Host values are rejected as well.

Treat this base URL as a password. It is stored in private Codex configuration and reversible
integration journals. Status output redacts it, but Codex or other clients may log their own base
URL; redact those logs before sharing. An attacker running as the same OS user can read these
files or the browser profile. Run on a trusted OS account and treat same-user code execution as
inside the trust boundary. These controls do not defend against a compromised runtime.

The lifecycle endpoints are separate from the Responses surface. `/admin/drain`, `/admin/resume`,
`/admin/cancel-turn`, `/admin/cancel-turns`, and `/admin/shutdown` require a random bearer token stored in the
user-only application config. The launcher uses them to reject new work, prove that both the HTTP
request and long-lived browser/tool loop are idle, flush response state, and stop a process. The
token does not turn loopback into a hostile-local-process security boundary; it prevents accidental
or unauthenticated lifecycle control through ordinary requests.

### Browser/UI drift

ChatGPT DOM and labels are not a stable API. Selectors are narrow; Full-mode completion requires
stable completed-turn evidence and, after tools, a new final-answer projection. UI drift fails the
turn; it never chooses another model, starts another transport, or returns a fabricated success.

### Login-state isolation

The launcher keeps ChatGPT login, identity-provider navigation, and model turns in one private
Electron partition. Allowed login popups are adopted into an in-launcher `WebContentsView` that
shares that partition; unrelated external links remain outside it. A visible composer alone is not
authentication evidence: the launcher also requires a valid server session and an exact Temporary
Chat URL before setup can continue. No cookies, local storage, or browser profile are copied from an
external browser.

### Cross-turn data leakage

Browser turns use at most five independent task-bound tabs in one private login partition. Every
outer Codex task owns an exact launcher surface lease and retains its Temporary Chat only across
sequential messages in the same model/effort/compaction epoch; chats are never reused across tasks.
Closing a running tab destroys its page and terminates that turn. The five-tab limit bounds parallel
account traffic. Tool calls remain in the same ChatGPT response. The
bounded local continuation cache exists only to implement Codex `previous_response_id` replay.
Default and `store:false` continuation state stays in memory; only explicit `store:true` chains
without memory-only ancestors may be written to the private disk cache. Entries expire after one
hour. A running process removes expired disk entries; expired data left while stopped is removed
on the next cache load. Legacy snapshots without storage-consent metadata are discarded on load.
Disk deletion is best effort and is not secure erasure or backup deletion. This policy covers the
bridge's response cache, not Codex history, the browser profile, or OpenAI's data handling.
Full-mode context compaction accepts a checkpoint only through its
one-shot MCP control capability in the exact retained source chat. If that chat no longer exists, a
fresh tool-free Temporary Chat receives the canonical Codex history; the bridge never parses ordinary
assistant prose as a structured handoff.

Luna's separate rolling-checkpoint cache is memory-only, including explicit `store:true` turns.
A restart or expiry falls back to canonical Codex history. Legacy `luna-checkpoints.json` files are
not loaded or automatically deleted by this change; review any historical files separately.

Browser screenshots and content diagnostics, including full URLs, titles, UI text, and error
messages, require explicit `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1`. Opting in may capture private
account or chat content. Existing diagnostic files are not removed by an upgrade. Default
diagnostics retain counts, geometry, control state, and fixed error categories.

## Network exposure

- Responses and health listeners bind to `127.0.0.1` only.
- Browser automation also binds to `127.0.0.1` and requires a bearer key on HTTP and WebSocket.
- Full mode uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound
  firewall rule.
- The embedded browser connects to ChatGPT, the selected identity provider during explicit sign-in,
  and user-authorized attachment URLs through normal browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Electron binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
- Proving publisher trust or binary provenance from a checksum published with the same release.
  This fork's updater and installers accept application/runtime releases only from
  `Gao327/codex-chatgpt-web`, with no upstream fallback. Release CI is restricted to that repository.
  CI actions are pinned and release-write permissions are limited to publishing, but independent
  signing and review of each future fork release remain separate.
