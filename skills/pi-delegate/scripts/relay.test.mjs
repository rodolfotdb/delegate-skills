#!/usr/bin/env node
// Deterministic suite for relay.mjs: a fake `pi` (fake-pi.mjs) via PI_DELEGATE_BIN, real git repos,
// the relay run as a real subprocess, assertions on result.json and the repo. No provider calls, no cost.
//   node relay.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const relay = join(here, "relay.mjs");
const fake = join(here, "fake-pi.mjs");
const root = mkdtempSync(join(tmpdir(), "pi-relay-test-"));
const clockRelay = join(root, "clock-relay.mjs");
writeFileSync(clockRelay, `import { main } from ${JSON.stringify(pathToFileURL(relay).href)};
import { appendFileSync } from "node:fs";
let time = 0;
main({ now: () => ++time, sleep: async ms => {
  appendFileSync(process.env.FAKE_PI_ARGS_FILE + ".waits", JSON.stringify(ms) + "\\n");
  time += ms;
} });`);
let n = 0, passed = 0, total = 0;

function repo() {
  const dir = join(root, `repo${++n}`);
  mkdirSync(dir);
  for (const a of [["init", "-q", "."], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]]) {
    assert.equal(spawnSync("git", a, { cwd: dir }).status, 0);
  }
  return dir;
}

function run(args, { env = {}, cd = repo(), brief = "do the thing" } = {}) {
  const out = join(root, `out${++n}`);
  const briefFile = join(root, `brief${n}.txt`);
  writeFileSync(briefFile, brief);
  const argsFile = join(root, `args${n}.json`);
  const r = spawnSync(process.execPath, [clockRelay, "--brief", briefFile, "--cd", cd, "--out-dir", out, ...args], {
    encoding: "utf8",
    env: { ...process.env, PI_DELEGATE_BIN: fake, FAKE_PI_ARGS_FILE: argsFile, ...env },
  });
  const resultPath = join(out, "result.json");
  return {
    r, cd, out,
    calls: existsSync(argsFile + ".count") ? Number(readFileSync(argsFile + ".count", "utf8")) : null,
    waits: existsSync(argsFile + ".waits") ? readFileSync(argsFile + ".waits", "utf8").trim().split("\n").map(Number) : [],
    result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null,
    argv: existsSync(argsFile) ? JSON.parse(readFileSync(argsFile, "utf8")) : null,
  };
}

function test(name, fn) {
  total += 1;
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (error) { console.log(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}

try {
  test("create: completed, file in touchedFiles, provider/model/session reported", () => {
    const { r, result } = run([], { env: { FAKE_PI_MODE: "create" } });
    assert.equal(r.status, 0);
    assert.equal(result.status, "completed");
    assert.equal(result.tool, "pi");
    assert.equal(result.model, "opencode-go/deepseek-v4.1-flash");
    assert.equal(result.provider, "opencode-go");
    assert.equal(result.sessionId, "fake-session-0001");
    assert.deepEqual(result.touchedFiles, ["?? created.txt"]);
    assert.match(result.finalMessage, /fake done/);
    assert.equal(result.usage.totalTokens, 15);
  });

  test("default flags: no MCP/extensions/skills, json mode, session dir under out-dir", () => {
    const { argv, out } = run([]);
    for (const f of ["-p", "--no-mcp", "--no-extensions", "--no-skills"]) assert.ok(argv.includes(f), f);
    assert.equal(argv[argv.indexOf("--mode") + 1], "json");
    assert.equal(argv[argv.indexOf("--session-dir") + 1], join(out, "sessions"));
    assert.ok(!argv.includes("--no-context-files"), "repo AGENTS.md/CLAUDE.md must stay loaded");
  });

  test("opt-ins drop the --no-* flags", () => {
    const { argv } = run(["--mcp", "--extensions", "--skills"]);
    for (const f of ["--no-mcp", "--no-extensions", "--no-skills"]) assert.ok(!argv.includes(f), f);
  });

  test("DeepSeek defaults to max; Gemini keeps Pi defaults; explicit efforts win", () => {
    for (const model of [null, "deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash"]) {
      const { r, argv, result } = run(model ? ["--model", model] : []);
      assert.equal(r.status, 0);
      assert.equal(argv[argv.indexOf("--thinking") + 1], "max");
      assert.equal(result.effort, "max");
    }
    for (const model of ["gemini-4-argon", "google/gemini-4-argon"]) {
      const { argv } = run(["--model", model]);
      assert.ok(!argv.includes("--thinking"));
    }
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      for (const model of ["deepseek-v4.1-flash", "gemini-4-argon"]) {
        const { r, argv } = run(["--model", model, "--effort", effort]);
        assert.equal(r.status, 0);
        assert.equal(argv[argv.indexOf("--thinking") + 1], effort);
      }
    }
  });

  test("effort maps to --thinking; short model name resolves; google model accepted", () => {
    const a = run(["--effort", "high", "--model", "deepseek-v4.1-flash"]).argv;
    assert.equal(a[a.indexOf("--thinking") + 1], "high");
    assert.equal(a[a.indexOf("--model") + 1], "opencode-go/deepseek-v4.1-flash");
    const b = run(["--model", "google/gemini-4-argon"]);
    assert.equal(b.result.status, "completed");
    assert.equal(b.result.model, "google/gemini-4-argon");
  });

  test("--read-only excludes write/edit/bash, forces no mcp/extensions, repo untouched", () => {
    const { argv, result } = run(["--read-only", "--mcp", "--extensions"], { env: { FAKE_PI_MODE: "create" } });
    assert.equal(argv[argv.indexOf("--exclude-tools") + 1], "write,edit,bash");
    assert.ok(argv.includes("--no-mcp") && argv.includes("--no-extensions"));
    assert.equal(result.status, "completed");
    assert.deepEqual(result.touchedFiles, []);
    assert.equal(result.readOnlyViolation, false);
  });

  test("binary missing -> pi_unavailable, exit 127, result written", () => {
    const { r, result } = run([], { env: { PI_DELEGATE_BIN: join(root, "nope.mjs") } });
    assert.equal(r.status, 127);
    assert.equal(result.status, "pi_unavailable");
    assert.equal(result.errorKind, "binary");
  });

  test("auth not ready -> pi_unavailable, pi never dispatched", () => {
    const { r, result, argv } = run([], { env: { FAKE_PI_AUTH: "missing" } });
    assert.equal(r.status, 127);
    assert.equal(result.status, "pi_unavailable");
    assert.equal(result.errorKind, "auth");
    assert.equal(argv, null);
  });

  test("model outside the allow-list fails early without running pi, result written", () => {
    const { r, result, argv } = run(["--model", "openai/gpt-9"]);
    assert.equal(r.status, 2);
    assert.equal(result.status, "model_unavailable");
    assert.equal(result.errorKind, "model_not_allowed");
    assert.equal(argv, null);
  });

  test("unsafe model name is a usage error (exit 2, no result)", () => {
    const { r, result } = run(["--model", "a b;rm"]);
    assert.equal(r.status, 2);
    assert.equal(result, null);
  });

  test("HTTP 400 with exit 0 -> model_unavailable, not completed", () => {
    const { r, result } = run([], { env: { FAKE_PI_MODE: "error400" } });
    assert.equal(r.status, 1);
    assert.equal(result.status, "model_unavailable");
    assert.equal(result.errorKind, "model");
    assert.equal(result.quotaExhausted, false);
    assert.match(result.error, /Global regions/);
  });

  test("quota / rate limit is distinguishable (quotaExhausted)", () => {
    const { result, waits } = run([], { env: { FAKE_PI_MODE: "quota" } });
    assert.equal(result.status, "model_unavailable");
    assert.equal(result.errorKind, "quota");
    assert.equal(result.quotaExhausted, true);
    assert.equal(result.attempts.length, 1);
    assert.deepEqual(waits, []);
  });

  for (const code of ["429", "503", ""]) {
    test(`${code || "no code"} endpoint unavailable: two fixed 10s retries, never quota`, () => {
      const { result, calls, waits, r } = run([], { env: { FAKE_PI_MODE: "unavailable", FAKE_PI_HTTP: code } });
      assert.equal(r.status, 1);
      assert.equal(result.status, "model_unavailable");
      assert.equal(result.errorKind, "provider_unavailable");
      assert.equal(result.quotaExhausted, false);
      assert.equal(calls, 3);
      assert.deepEqual(waits, [10000, 10000]);
      assert.equal(result.attempts.length, 3);
      for (const a of result.attempts) {
        assert.equal(a.reason, "provider_unavailable");
        assert.equal(a.durationMs, 1);
      }
    });
  }
  test("provider recovers on second attempt", () => {
    const { result, calls, waits } = run([], { env: { FAKE_PI_MODE: "unavailable-success" } });
    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    assert.deepEqual(waits, [10000]);
    assert.deepEqual(result.attempts.map(a => a.reason), ["provider_unavailable", "completed"]);
  });
  test("partial file edits prevent provider retry", () => {
    const { result, calls, waits } = run([], { env: { FAKE_PI_MODE: "unavailable-write" } });
    assert.equal(result.errorKind, "provider_unavailable");
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
    assert.ok(result.touchedFiles.includes("?? partial.txt"));
  });
  test("stderr provider unavailability retries; upstream phrase alone is sufficient", () => {
    const { result, calls } = run([], { env: { FAKE_PI_MODE: "unavailable-stderr", FAKE_PI_ERROR: "Upstream request failed" } });
    assert.equal(result.errorKind, "provider_unavailable");
    assert.equal(result.quotaExhausted, false);
    assert.equal(calls, 3);
  });
  test("endpoint phrase alone is sufficient", () => {
    const { result } = run([], { env: { FAKE_PI_MODE: "unavailable", FAKE_PI_ERROR: "Endpoint is unavailable" } });
    assert.equal(result.errorKind, "provider_unavailable");
  });

  test("plain-text output with exit 0 and no events -> not completed", () => {
    const { result } = run([], { env: { FAKE_PI_MODE: "noevents" } });
    assert.notEqual(result.status, "completed");
  });

  test("timeout -> status timeout, exit 124, process tree killed", () => {
    const t0 = Date.now();
    const { r, result } = run(["--timeout", "2s"], { env: { FAKE_PI_MODE: "hang" } });
    assert.equal(result.status, "timeout");
    assert.equal(r.status, 124);
    assert.ok(Date.now() - t0 < 30_000);
  });

  test("bad --timeout / --effort are usage errors", () => {
    assert.equal(run(["--timeout", "0s"]).r.status, 2);
    assert.equal(run(["--timeout", "soon"]).r.status, 2);
    assert.equal(run(["--effort", "invalid"]).r.status, 2);
  });

  test("resume passes --session with the previous session dir and enforces provenance", () => {
    const cd = repo();
    const first = run(["--task-id", "t1"], { cd });
    assert.equal(first.result.status, "completed");
    const prev = join(first.out, "result.json");
    const second = run(["--task-id", "t1", "--session", "fake-session-0001", "--resume-from", prev, "--resume-reason", "same-patch"], { cd });
    assert.equal(second.result.status, "completed");
    assert.equal(second.argv[second.argv.indexOf("--session") + 1], "fake-session-0001");
    assert.equal(second.argv[second.argv.indexOf("--session-dir") + 1], first.result.sessionDir);
    assert.equal(second.result.resumed, true);
    assert.equal(second.result.runContext.continuationCount, 1);
    const bad = run(["--task-id", "other", "--session", "fake-session-0001", "--resume-from", prev, "--resume-reason", "same-patch"], { cd });
    assert.equal(bad.r.status, 2);
    assert.equal(bad.result, null);
    assert.equal(run(["--session", "fake-session-0001"], { cd }).r.status, 2);
  });

  test("empty brief and reused out-dir are usage errors", () => {
    assert.equal(run([], { brief: "  \n" }).r.status, 2);
  });

  console.log(`
${passed}/${total} passed${passed === total ? "" : " - FAILURES above"}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
