#!/usr/bin/env node
// LIVE suite: calls the real `pi` with the cheap default model (opencode-go/deepseek-v4.1-flash).
// Costs a few cents. Opt-in only:   PI_LIVE=1 node relay.live.test.mjs
// Three trivial runs: create a file, same brief under --read-only, resume the first session.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_LIVE !== "1") {
  console.log("skipped: set PI_LIVE=1 to run the live (paid) suite");
  process.exit(0);
}
const relay = join(dirname(fileURLToPath(import.meta.url)), "relay.mjs");
const root = mkdtempSync(join(tmpdir(), "pi-relay-live-"));
let n = 0, passed = 0, total = 0;

function repo() {
  const dir = join(root, `repo${++n}`);
  mkdirSync(dir);
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: dir });
  return dir;
}
function run(args, cd, brief) {
  const out = join(root, `out${++n}`);
  const briefFile = join(root, `brief${n}.txt`);
  writeFileSync(briefFile, brief);
  const r = spawnSync(process.execPath, [relay, "--brief", briefFile, "--cd", cd, "--out-dir", out, "--effort", "low", "--timeout", "5m", ...args],
    { encoding: "utf8", env: process.env });
  return { r, out, result: existsSync(join(out, "result.json")) ? JSON.parse(readFileSync(join(out, "result.json"), "utf8")) : null };
}
function test(name, fn) {
  total += 1;
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (error) { console.log(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}

const brief = "Create a file named live.txt in the working directory containing exactly the word hello and a newline. Then reply with the single word done.";
try {
  const cd = repo();
  let first;
  test("live: brief that creates a file -> completed with the file in touchedFiles", () => {
    first = run(["--task-id", "live1"], cd, brief);
    assert.equal(first.result.status, "completed", first.r.stderr);
    assert.ok(first.result.touchedFiles.some((l) => l.endsWith("live.txt")));
    assert.ok(existsSync(join(cd, "live.txt")));
    assert.ok(first.result.sessionId);
  });
  test("live: same brief with --read-only -> no file changed", () => {
    const ro = run(["--read-only"], repo(), brief);
    assert.notEqual(ro.result.status, "pi_unavailable");
    assert.deepEqual(ro.result.touchedFiles, []);
    assert.equal(ro.result.readOnlyViolation, false);
  });
  test("live: resume by session id keeps the conversation", () => {
    const second = run(["--task-id", "live1", "--session", first.result.sessionId, "--resume-from", join(first.out, "result.json"), "--resume-reason", "same-patch"],
      cd, "What was the name of the file you created earlier? Reply with only the file name.");
    assert.equal(second.result.status, "completed", second.r.stderr);
    assert.equal(second.result.sessionId, first.result.sessionId);
    assert.match(second.result.finalMessage, /live\.txt/);
  });
  console.log(`\n${passed}/${total} passed${passed === total ? "" : " - FAILURES above"}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
