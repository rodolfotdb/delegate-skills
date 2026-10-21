#!/usr/bin/env node
// Deterministic stand-in for the `pi` CLI, used by relay.test.mjs via PI_DELEGATE_BIN.
// It speaks just enough of `pi -p --mode json` to exercise the relay's decisions.
// FAKE_PI_MODE: ok (default) | create (writes created.txt unless write/bash excluded) | error400 | quota | hang | noevents
// FAKE_PI_AUTH: ready (default) | missing   FAKE_PI_ARGS_FILE: where the received argv is dumped (JSON).
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("1.3.0"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "check") {
  const status = process.env.FAKE_PI_AUTH || "ready";
  console.log(JSON.stringify({ status, provider: argv[argv.indexOf("--provider") + 1], authType: "api_key" }));
  process.exit(0);
}
if (process.env.FAKE_PI_ARGS_FILE) writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(argv));

const emit = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
let mode = process.env.FAKE_PI_MODE || "ok";
if (mode.startsWith("unavailable")) {
  const counter = process.env.FAKE_PI_ARGS_FILE + ".count";
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
  writeFileSync(counter, String(n));
  if (mode === "unavailable-success" && n === 2) mode = "ok";
  else {
    if (mode === "unavailable-write") writeFileSync("partial.txt", "partial");
    const errorMessage = `${process.env.FAKE_PI_HTTP ?? "429"} {"type":"server_error","message":"${process.env.FAKE_PI_ERROR ?? "Upstream request failed: Endpoint is unavailable."}"}`;
    if (mode === "unavailable-stderr") { console.error(errorMessage); process.exit(1); }
    console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage, content: [] }] }));
    process.exit(0);
  }
}
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const sessionId = flag("--session") || "fake-session-0001";
const [provider, model] = (flag("--model") || "x/y").split("/");

if (mode === "hang") { emit({ type: "session", id: sessionId }); setInterval(() => {}, 1000); }
else if (mode === "noevents") { console.log("something went wrong"); process.exit(0); }
else {
  emit({ type: "session", version: 3, id: sessionId });
  emit({ type: "agent_start" });
  const usage = { input: 10, output: 5, cacheRead: 0, totalTokens: 15, cost: { total: 0.001 } };
  if (mode === "error400" || mode === "quota") {
    const errorMessage = mode === "quota"
      ? "429: {\"type\":\"error\",\"message\":\"Rate limit exceeded: monthly credits exhausted\"}"
      : "400: {\"type\":\"server_error\",\"message\":\"requires Global regions ...\"}";
    const msg = { role: "assistant", content: [], provider, model, usage, stopReason: "error", errorMessage };
    emit({ type: "turn_end", message: msg });
    emit({ type: "agent_end", messages: [msg], willRetry: true });
    emit({ type: "auto_retry_end", success: false, attempt: 3, finalError: errorMessage });
    emit({ type: "agent_settled", aborted: false });
    process.exit(0); // pi really exits 0 here
  }
  const excluded = (flag("--exclude-tools") || "").split(",");
  if (mode === "create" && !excluded.includes("write") && !excluded.includes("bash")) {
    writeFileSync("created.txt", "hi\n");
  }
  const msg = { role: "assistant", content: [{ type: "text", text: `fake done (${mode})` }], provider, model, usage, stopReason: "stop" };
  emit({ type: "turn_end", message: msg });
  emit({ type: "agent_end", messages: [{ role: "user", content: [] }, msg], willRetry: false });
  emit({ type: "agent_settled", aborted: false });
}
