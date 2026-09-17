import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each process gets a fresh module cache and an isolated application home. No account or
// installed Codex state is read or written by these continuation-cache tests.
function withStateHome(check: (run: (script: string) => void) => void): void {
  const home = mkdtempSync(join(tmpdir(), "cgw-response-privacy-"));
  try {
    check(script => {
      const result = Bun.spawnSync([process.execPath, "--eval", `
        import assert from "node:assert/strict";
        import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { expandPreviousResponseInput as expand, flushResponseState as flush,
          rememberResponseState as remember } from ${JSON.stringify(new URL("../src/responses/state.ts", import.meta.url).href)};
        const path = join(process.env.CODEX_CHATGPT_WEB_HOME, "responses-state.json");
        const ttl = 60 * 60 * 1000;
        const reply = id => ({ id, output: [{ role: "assistant", content: "answer" }], status: "completed" });
        const disk = () => JSON.parse(readFileSync(path, "utf8"));
        ${script}
      `], {
        env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("forced store:false and unspecified storage replay in memory without writing content", () => {
  withStateHome(run => run(`
    remember({ store: false, input: "private prompt" }, reply("private"), { force: true });
    remember({ input: "default prompt" }, reply("default"));
    assert.deepEqual(expand({ previous_response_id: "private", input: "continue" }).input, [
      { role: "user", content: "private prompt" }, { role: "assistant", content: "answer" },
      { role: "user", content: "continue" },
    ]);
    assert.equal(expand({ previous_response_id: "default", input: [] }).input.length, 2);
    flush();
    assert.equal(existsSync(path), false);
  `));
});

test("explicitly stored responses survive restart without including memory-only siblings", () => {
  withStateHome(run => {
    run(`
      remember({ store: true, input: "saved" }, reply("saved"));
      remember({ store: false, input: "private" }, reply("private"), { force: true });
      flush();
      assert.deepEqual(disk().states.map(([id]) => id), ["saved"]);
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    `);
    run(`
      assert.equal(expand({ previous_response_id: "saved", input: [] }).input[0].content, "saved");
      assert.deepEqual(expand({ previous_response_id: "private", input: [] }).input, []);
    `);
  });
});

test("store:true descendants cannot persist history from a memory-only ancestor", () => {
  withStateHome(run => run(`
    remember({ store: false, input: "private ancestor" }, reply("private"), { force: true });
    const child = expand({ store: true, previous_response_id: "private", input: "child" });
    // An in-flight request retains its privacy provenance even after the parent is evicted.
    const startedAt = Date.now();
    Date.now = () => startedAt + ttl;
    expand({ previous_response_id: "private", input: [] });
    remember(child, reply("child"));
    const grandchild = expand({ store: true, previous_response_id: "child", input: "grandchild" });
    remember(grandchild, reply("grandchild"));
    flush();
    assert.equal(existsSync(path), false);
    assert.equal(expand({ previous_response_id: "grandchild", input: [] }).input[0].content, "private ancestor");
  `));
});

test("legacy snapshots without storage consent are removed rather than restored", () => {
  withStateHome(run => run(`
    writeFileSync(path, JSON.stringify({ version: 1, states: [["old", {
      createdAt: Date.now(), items: [{ role: "user", content: "old private content" }],
    }]] }));
    assert.deepEqual(expand({ previous_response_id: "old", input: [] }).input, []);
    assert.equal(existsSync(path), false);
  `));
});

test("loading a snapshot removes expired entries and entries without explicit storage consent", () => {
  withStateHome(run => run(`
    const record = (createdAt, persist) => ({ createdAt, persist, items: [{ role: "user", content: "test" }] });
    writeFileSync(path, JSON.stringify({ version: 2, states: [
      ["expired", record(Date.now() - ttl, true)],
      ["private", record(Date.now(), false)],
      ["unspecified", record(Date.now(), undefined)],
      ["future", record(Date.now() + ttl, true)],
      ["valid", record(Date.now(), true)],
    ] }));
    assert.deepEqual(expand({ previous_response_id: "expired", input: [] }).input, []);
    assert.deepEqual(disk().states.map(([id]) => id), ["valid"]);
    assert.equal(expand({ previous_response_id: "valid", input: [] }).input.length, 1);
  `));
});

test("expired snapshots are deleted while idle without requiring another request", () => {
  withStateHome(run => run(`
    writeFileSync(path, JSON.stringify({ version: 2, states: [["expiring", {
      createdAt: Date.now() - ttl + 200, persist: true, items: [{ role: "user", content: "test" }],
    }]] }));
    assert.equal(expand({ previous_response_id: "expiring", input: [] }).input.length, 1);
    assert.equal(existsSync(path), true);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(existsSync(path), false);
  `));
});

test("a pending write cannot reintroduce expired response content", () => {
  withStateHome(run => run(`
    remember({ store: true, input: "expires before flush" }, reply("expired"));
    const recordedAt = Date.now();
    Date.now = () => recordedAt + ttl;
    flush();
    assert.equal(existsSync(path), false);
    assert.deepEqual(expand({ previous_response_id: "expired", input: [] }).input, []);
  `));
});

test("failed and filtered output cannot enter replay history", () => {
  withStateHome(run => run(`
    remember({ store: true, input: "failed" }, { ...reply("failed"), status: "failed" });
    remember({ store: true, input: "filtered" }, {
      ...reply("filtered"), status: "incomplete", incomplete_details: { reason: "content_filter" },
    });
    remember({ store: false, input: "partial" }, {
      ...reply("partial"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    }, { force: true });
    assert.deepEqual(expand({ previous_response_id: "failed", input: [] }).input, []);
    assert.deepEqual(expand({ previous_response_id: "filtered", input: [] }).input, []);
    assert.equal(expand({ previous_response_id: "partial", input: [] }).input.length, 2);
    flush();
    assert.equal(existsSync(path), false);
  `));
});
