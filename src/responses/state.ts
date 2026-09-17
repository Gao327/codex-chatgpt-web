import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** In-memory high-water byte cap across all entries. Forced store:false continuation chains
 * store the full expanded input each turn — ~quadratic bytes per chain —
 * so a count cap alone cannot bound memory. Oldest-first eviction applies past this mark. */
const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  /** Only explicitly stored responses without memory-only ancestors may reach disk. */
  persist: boolean;
  /** Approximate in-memory size, computed locally at insert time (never trusted from disk). */
  sizeBytes?: number;
}

const states = new Map<string, StoredResponseState>();
let storedResponseBytes = 0;

/** The ONLY size computation: approximate entry weight from its items payload. */
function measuredEntry(entry: Omit<StoredResponseState, "sizeBytes">): StoredResponseState {
  let sizeBytes = 0;
  try {
    sizeBytes = JSON.stringify(entry.items).length;
  } catch {
    /* unserializable items: weightless rather than fatal */
  }
  return { ...entry, sizeBytes };
}

/** The ONLY insertion point: keeps the byte counter consistent on replacement. */
function setEntry(id: string, entry: Omit<StoredResponseState, "sizeBytes">): void {
  deleteEntry(id);
  const measured = measuredEntry(entry);
  storedResponseBytes += measured.sizeBytes ?? 0;
  states.set(id, measured);
}

/** The ONLY deletion point: TTL, count, byte, and explicit deletes all route here. */
function deleteEntry(id: string): void {
  const existing = states.get(id);
  if (!existing) return;
  storedResponseBytes -= existing.sizeBytes ?? 0;
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  states.delete(id);
}
// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. Consumers use the prefix length to bind trusted history and rolling checkpoints to the
// exact replayed portion of this request.
const replayedInputPrefixLengths = new WeakMap<object, number>();
const memoryOnlyReplays = new WeakSet<object>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

/**
 * Explicit store:true chains may survive a proxy restart. All other continuation state stays
 * in memory, including forced store:false state. Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const path = snapshotPath();
  try {
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    // Version 1 did not record storage consent and may contain store:false conversations.
    if (raw.version !== 2 || !Array.isArray(raw.states)) {
      rmSync(path, { force: true });
      return;
    }
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (!Number.isFinite(rec.createdAt) || rec.createdAt > now()
        || !Array.isArray(rec.items) || rec.persist !== true) continue;
      // Recompute sizes locally while loading; persisted sizeBytes is never trusted.
      setEntry(id, {
        createdAt: rec.createdAt,
        items: rec.items,
        persist: true,
      });
    }
    pruneResponses();
    // Remove expired or invalid content from disk as well as memory on restart.
    persistNow(path);
  } catch {
    // Corrupt snapshots can still contain sensitive content; do not retain an unreadable cache.
    try { rmSync(path, { force: true }); } catch { /* best-effort */ }
  }
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  pruneResponses();
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    // Newest-first so the most recent chains survive both caps.
    for (const entry of [...states].reverse()) {
      // sizeBytes is in-memory accounting only; keep it out of the disk snapshot.
      const [id, state] = entry;
      if (!state.persist) continue;
      const { sizeBytes: _sizeBytes, ...persistable } = state;
      const persistEntry: [string, StoredResponseState] = [id, persistable];
      const size = JSON.stringify(persistEntry).length;
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      total += size;
      entries.push(persistEntry);
    }
    entries.reverse();
    if (entries.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, JSON.stringify({ version: 2, states: entries }));
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  } finally {
    scheduleExpiry(path);
  }
}

/** Delete expired content while the process runs, even when no new requests arrive.
 * A stopped process cannot delete files; the next load removes anything that expired offline. */
function scheduleExpiry(path: string): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (states.size === 0) return;
  let expiresAt = Infinity;
  for (const state of states.values()) expiresAt = Math.min(expiresAt, state.createdAt + RESPONSE_TTL_MS);
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    persistNow(path);
  }, Math.max(1, expiresAt - now()));
  (expiryTimer as { unref?: () => void }).unref?.();
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path now: tests may swap CODEX_CHATGPT_WEB_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => persistNow(path), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled; CODEX_CHATGPT_WEB_HOME may have moved.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): boolean {
  const initialSize = states.size;
  for (const [id, state] of states) {
    if (at - state.createdAt >= RESPONSE_TTL_MS) deleteEntry(id);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
  // Byte high-water eviction, oldest-first (Map preserves insertion order).
  while (storedResponseBytes > MAX_STORED_RESPONSE_BYTES && states.size > 1) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
  return states.size !== initialSize;
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  if (pruneResponses()) persistNow(snapshotPath());
  const previous = states.get(previousId);
  if (!previous) return body;
  const expanded = {
    ...request,
    input: [...previous.items, ...inputItems(request.input)],
  };
  replayedInputPrefixLengths.set(expanded, previous.items.length);
  if (!previous.persist) memoryOnlyReplays.add(expanded);
  return expanded;
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  opts?: { force?: boolean },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally.
  // Force never permits persistence: only explicit store:true without a memory-only ancestor
  // reaches disk. Both caches expire after 1h while running; disk cleanup also runs on load.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  const previous = typeof request.previous_response_id === "string"
    ? states.get(request.previous_response_id)
    : undefined;
  setEntry(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    persist: request.store === true && !memoryOnlyReplays.has(request) && previous?.persist !== false,
  });
  pruneResponses();
  schedulePersist();
}
