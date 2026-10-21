#!/usr/bin/env node
/**
 * delegate-skills · pi-delegate · relay.mjs
 *
 * Dispatch a self-contained brief to the Pi coding agent harness (`pi -p --mode json`),
 * capture the run, and write a structured result the orchestrating agent can review.
 * Same CLI and result.json contract as the codex-delegate / agy-delegate relays, so the
 * orchestrator treats the three providers with the same code.
 *
 * Trust posture: relay.mjs makes no network calls, reads or writes no credentials, and
 * sends no telemetry; no dependencies (Node built-ins only). It shells out only to `pi`
 * and `git`, plus `taskkill` on Windows. The `pi` process it launches authenticates by itself (its own auth store or
 * provider env vars) - the relay never reads those. Read this file before you run it.
 *
 * It deliberately does NOT commit. Committing is always the orchestrator's job.
 *
 * Pi exits 0 even when the provider rejects the request (e.g. HTTP 400 "requires Global
 * regions"). The status therefore comes from the JSON event stream, never from the exit
 * code alone: a provider/model error ends as `model_unavailable` (with `errorKind` and,
 * for rate limits/credit exhaustion, `quotaExhausted: true`), a missing binary or missing
 * credential as `pi_unavailable` (exit 127).
 *
 * Models: explicit allow-list (ALLOWED_MODELS below). Anything else fails before pi runs.
 * Default: opencode-go/deepseek-v4.1-flash with --thinking max; other models keep Pi defaults. Short names (no provider/) are accepted.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Options:
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root for Pi (default: current directory).
 *   --lane <name>           Fleet lane from delegate-setup config (dials apply; explicit flags win).
 *   --model <name>          provider/id from the allow-list (default: opencode-go/deepseek-v4.1-flash).
 *   --effort <level>        low, medium, high, xhigh or max (pi --thinking; default max for deepseek-v4.1-flash).
 *   --task-id <id>          Stable task identifier (generated for fresh runs).
 *   --resume-from <file>    Previous result.json proving same task/repo/session.
 *   --resume-reason <why>   same-patch or transient-retry; at most 2 continuations.
 *   --session <id>          Continue a specific Pi session (passed as pi's --session; sessions
 *                           live in the previous run's sessions/ dir, taken from --resume-from).
 *                           Send only the delta brief.
 *   --read-only             Review/diagnosis with no edits: excludes pi's write, edit and bash
 *                           tools. readOnlyViolation in result.json is the git fingerprint check.
 *   --mcp                   Opt in to MCP servers (default: --no-mcp).
 *   --extensions            Opt in to Pi extensions (default: --no-extensions).
 *   --skills                Opt in to Pi skills (default: --no-skills).
 *   --timeout <dur>         Relay-side watchdog, h/m/s like 30m (default 30m). On expiry the pi
 *                           process tree is killed and result.json gets status "timeout".
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under the system
 *                           temp dir, so the repo stays clean). Pi sessions go to <out-dir>/sessions.
 *   -h, --help              Show this help.
 *
 * Environment: PI_DELEGATE_BIN overrides the pi executable (a .js/.mjs file runs under node).
 *
 * Binary lookup: PI_DELEGATE_BIN, then PATH, then the managed install ~/.pi/agent/bin
 * (Windows: runs the managed `pi-launcher.js` under node, no cmd.exe quoting involved).
 *
 * Result: <out-dir>/result.json, summarized on stdout - status, exitCode, piVersion, sessionId,
 * provider/model, usage, finalMessage, touchedFiles (git porcelain, null if git can't report),
 * readOnlyViolation, errorKind/quotaExhausted, and paths to brief.txt, final.txt, pi.jsonl, stderr.txt.
 *
 * Status: completed | failed | timeout | aborted | pi_unavailable | model_unavailable.
 * Exit codes: usage error exits 2 before any run (no result file), except a model outside the
 * allow-list which writes result.json (model_unavailable) and exits 2; missing binary/credential
 * exits 127 (pi_unavailable); watchdog timeout exits 124; provider error exits 1; otherwise pi's own.
 * result.json is written on every outcome once the brief validates.
 */

import { createRunContext, reserveOutput } from "./context-policy.mjs";
import {spawn, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readFileSync, readlinkSync, lstatSync, existsSync, appendFileSync, realpathSync, statSync } from "node:fs";
import {join, resolve, basename, dirname, relative, isAbsolute, delimiter, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, tmpdir, homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT = "30m";
const MAX_TIMER_MS = 2_147_483_647;
const MAX_TIMER_DURATION = "596h31m23s";
const PROBE_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_CHARS = 1_048_576;

// Allow-list (D-01). To add a model: confirm it in `pi --list-models`, then add it here.
const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";
const ALLOWED_MODELS = [
  "opencode-go/deepseek-v4.1-flash",
  "google/gemini-4-argon",
];
// Keep in lockstep with delegate-setup MODEL_TOKEN.shellSafe.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const IMPLEMENTER_KEY = "pi";

function makeEventScanner(onObject) {
  let buf = "";
  let index = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    if (!chunk) return;
    buf += chunk;
    for (;;) {
      while (index < buf.length) {
        const ch = buf[index];
        // Only track strings inside an object (depth > 0). At depth 0 we are
        // skipping a junk prefix, and an unmatched `"` there must not swallow the
        // real `{...}` that follows in the same chunk.
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          if (depth > 0) inString = true;
        } else if (ch === "{") {
          if (depth === 0) start = index;
          depth += 1;
        } else if (ch === "}") {
          if (depth > 0) {
            depth -= 1;
            if (depth === 0 && start !== -1) {
              const slice = buf.slice(start, index + 1);
              try { onObject(JSON.parse(slice)); } catch { /* skip malformed */ }
              start = -1;
            }
          }
        }
        index += 1;
      }
      if (depth === 0 || start === -1 || buf.length - start <= MAX_BUFFERED_CHARS) break;
      // A complete object may exceed the retained-input cap within this chunk.
      // Drop only an oversized partial, then rescan its suffix so a later
      // concatenated event is not lost.
      buf = buf.slice(start + MAX_BUFFERED_CHARS);
      index = 0;
      start = -1;
      depth = 0;
      inString = false;
      escaped = false;
    }
    if (depth > 0 && start !== -1) {
      if (start > 0) {
        buf = buf.slice(start);
        index -= start;
        start = 0;
      }
    } else {
      buf = "";
      index = 0;
      start = -1;
    }
  };
}

function applyFleetLane(opts, flagged) {
  if (!opts.lane) return;
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../delegate-setup/scripts/lane.mjs");
  if (!existsSync(script)) {
    fail("--lane requires the delegate-setup skill installed beside this relay");
  }
  const r = spawnSync(
    process.execPath,
    [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY],
    { encoding: "utf8", env: process.env },
  );
  if (r.error) fail(`lane resolve failed: ${r.error.message}`);
  if (r.status !== 0) {
    fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  }
  let resolved;
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("lane resolve returned invalid JSON");
  }
  opts.laneSource = resolved.source;
  for (const [field, value] of Object.entries(resolved.dials || {})) {
    if (flagged.has(field)) continue;
    if (field === "autonomy" && (flagged.has("autonomy") || flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "agent" && (flagged.has("agent") || flagged.has("readOnly"))) continue;
    if (field === "sandbox" && (flagged.has("sandbox") || flagged.has("readOnly"))) continue;
    if (field === "permissionMode" && (flagged.has("permissionMode") || flagged.has("readOnly"))) continue;
    if (field === "planOnly" && (flagged.has("planOnly") || flagged.has("readOnly"))) continue;
    if (field === "readOnly" && (flagged.has("readOnly") || flagged.has("dangerouslySkipPermissions"))) continue;
    if (field === "force" && flagged.has("force")) continue;
    opts[field] = value;
  }
}

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}


function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null,
    laneSource: null,
    brief: null,
    cd: process.cwd(),
    model: null,
    effort: null,
    session: null,
    readOnly: false,
    mcp: false,
    extensions: false,
    skills: false,
    timeout: null,
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": opts.effort = next(); flagged.add("effort"); break;
      case "--task-id": opts.taskId = next(); break;
      case "--resume-from": opts.resumeFrom = next(); break;
      case "--resume-reason": opts.resumeReason = next(); break;
      case "--session": opts.session = next(); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--mcp": opts.mcp = true; break;
      case "--extensions": opts.extensions = true; break;
      case "--skills": opts.skills = true; break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (opts.session !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opts.session)) {
    fail("--session must be a Pi session id (letters, digits, dot, dash, underscore)");
  }
  if (!existsSync(opts.cd) || !statSync(opts.cd).isDirectory()) {
    fail(`working directory not found: ${opts.cd}`);
  }
  try {
    opts.runContext = createRunContext({ provider: "pi", repo: opts.cd, taskId: opts.taskId,
      resumeId: opts.session, resumeFrom: opts.resumeFrom, resumeReason: opts.resumeReason });
  } catch (error) { fail(error.message); }
  if (opts.session) {
    try {
      opts.resumeSessionDir = JSON.parse(readFileSync(opts.resumeFrom, "utf8")).sessionDir;
    } catch { opts.resumeSessionDir = null; }
    if (!opts.resumeSessionDir || !existsSync(opts.resumeSessionDir)) {
      fail("--resume-from result has no usable sessionDir; start fresh with a bounded handoff");
    }
  }
  applyFleetLane(opts, flagged);
  if (opts.effort !== null && !["low", "medium", "high", "xhigh", "max"].includes(opts.effort)) {
    fail(`invalid --effort "${opts.effort}" (expected: low, medium, high, xhigh, max)`);
  }
  if (opts.model !== null && !SAFE_MODEL.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : / -)");
  }
  // A malformed --timeout must fail loudly: a null delay would make setTimeout fire
  // on the next tick - a silent instant "timeout".
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const milliseconds = parseDuration(timeout);
  if (milliseconds === null || milliseconds <= 0 || milliseconds > MAX_TIMER_MS) {
    fail(`--timeout "${timeout}" must be an h/m/s duration from 1s through ${MAX_TIMER_DURATION}`);
  }
  opts.timeoutMs = milliseconds;
  return opts;
}

// Short name ("deepseek-v4.1-flash") -> full allow-list entry; null when not allowed.
function resolveModel(requested) {
  const wanted = requested ?? DEFAULT_MODEL;
  if (ALLOWED_MODELS.includes(wanted)) return wanted;
  const matches = ALLOWED_MODELS.filter((m) => m.split("/")[1] === wanted);
  return matches.length === 1 ? matches[0] : null;
}
function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs - dispatch a brief to pi -p --mode json\n";
  return `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n`;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  return stdin;
}

function killChild(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return;
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch {
      // The process tree already exited.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process group already exited.
    }
  }
}
function parseDuration(duration) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds =
      BigInt(match[1] || 0) * 3600n +
      BigInt(match[2] || 0) * 60n +
      BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}

function gitTouchedFiles(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function gitWorktreeFingerprint(cwd, excludedPaths = []) {
  try {
    const git = (args) => execFileSync("git", args, {
      cwd,
      timeout: 10_000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const root = realpathSync.native(git(["rev-parse", "--show-toplevel"]).toString("utf8").replace(/\r?\n$/, ""));
    const exclusions = excludedPaths
      .map((path) => {
        const absolute = resolve(path);
        try { return relative(root, realpathSync.native(absolute)); }
        catch { return relative(root, join(realpathSync.native(dirname(absolute)), basename(absolute))); }
      })
      .filter((path) => path && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path))
      .map((path) => `:(exclude,top,literal)${path.replaceAll("\\", "/")}`);
    const pathspec = [":(top)", ...exclusions];
    const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...pathspec]);
    const fingerprint = createHash("sha256").update("status\0").update(status);
    fingerprint.update("\0index\0").update(git(["diff", "--cached", "--raw", "--full-index", "--no-renames", "-z", "--", ...pathspec]));
    fingerprint.update("\0worktree\0").update(git(["diff", "--raw", "--full-index", "--no-renames", "-z", "--", ...pathspec]));

    const paths = [...new Set(status.toString("utf8").split("\0").filter(Boolean).map((entry) => entry.slice(3)))].sort();
    for (const path of paths) {
      const fullPath = join(cwd, path);
      fingerprint.update("\0path\0").update(path).update("\0");
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        fingerprint.update("missing");
        continue;
      }
      fingerprint.update(String(stat.mode)).update("\0");
      if (stat.isSymbolicLink()) fingerprint.update(readlinkSync(fullPath));
      else if (stat.isFile()) fingerprint.update(git(["hash-object", "--no-filters", "--", path]));
      else if (stat.isDirectory()) {
        const nestedState = gitWorktreeFingerprint(fullPath, excludedPaths);
        if (nestedState === null) return null;
        let headState;
        try {
          headState = git(["-C", fullPath, "rev-parse", "--verify", "HEAD"]);
        } catch {
          const symbolicHead = git(["-C", fullPath, "symbolic-ref", "--quiet", "HEAD"]).toString("utf8").trim();
          const target = spawnSync("git", ["-C", fullPath, "show-ref", "--verify", "--quiet", symbolicHead], { cwd, timeout: 10_000, killSignal: "SIGKILL", stdio: "ignore" });
          if (target.status !== 1) return null;
          headState = Buffer.from(`unborn\0${symbolicHead}`);
        }
        fingerprint.update("submodule\0").update(headState).update(nestedState);
      } else return null;
    }
    return fingerprint.digest("hex");
  } catch {
    return null;
  }
}

function readOnlyVerdict(opts, beforeState, afterState) {
  // Three-valued on purpose: true when fingerprints prove a change, false when coverage
  // is complete and proves none, null when the fingerprint could not be taken or the run
  // was not read-only.
  if (!opts.readOnly) return null;
  if (beforeState === null || afterState === null) return null;
  return beforeState !== afterState;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---- binary resolution -------------------------------------------------------------

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Returns { cmd, prefix } to spawn pi, or null when it cannot be found. */
function resolvePi() {
  const override = process.env.PI_DELEGATE_BIN;
  if (override) {
    if (!isFile(override)) return null;
    return /\.(m?js|cjs)$/i.test(override) ? { cmd: process.execPath, prefix: [override] } : { cmd: override, prefix: [] };
  }
  const managed = join(homedir(), ".pi", "agent", "bin");
  const dirs = [...(process.env.PATH || "").split(delimiter).filter(Boolean), managed];
  for (const dir of dirs) {
    if (process.platform === "win32") {
      const launcher = join(dir, "pi-launcher.js");
      if (isFile(join(dir, "pi.cmd")) && isFile(launcher)) return { cmd: process.execPath, prefix: [launcher] };
      if (isFile(join(dir, "pi.exe"))) return { cmd: join(dir, "pi.exe"), prefix: [] };
    } else if (isFile(join(dir, "pi"))) {
      return { cmd: join(dir, "pi"), prefix: [] };
    }
  }
  return null;
}

// Async probes let signal handlers terminate the whole preflight process tree.
function runPi(bin, args, timeoutMs, onChild, cwd) {
  return new Promise((resolveProbe) => {
    const child = spawn(bin.cmd, [...bin.prefix, ...args], {
      cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env,
      detached: process.platform !== "win32",
    });
    onChild(child);
    let stdout = "", stderr = "", settled = false, timedOut = false;
    let timer, drain;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolveProbe({ stdout, stderr, timedOut, ...extra });
    };
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-MAX_BUFFERED_CHARS); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-MAX_BUFFERED_CHARS); });
    child.on("error", error => finish({ code: null, error }));
    child.on("close", code => finish({ code, error: null }));
    child.once("exit", () => {
      clearTimeout(timer);
      drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 500);
      drain.unref();
    });
    timer = setTimeout(() => {
      timedOut = true;
      killChild(child, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    }, timeoutMs);
  });
}

async function piVersion(bin, timeoutMs, onChild, cwd) {
  const r = await runPi(bin, ["--version"], Math.min(timeoutMs, VERSION_TIMEOUT_MS), onChild, cwd);
  if (r.timedOut) return { error: "pi --version preflight timed out; pi was not dispatched", status: "timeout", exitCode: 124 };
  if (r.error || r.code !== 0) return {
    error: `pi --version preflight failed; pi was not dispatched: ${r.error?.message || r.stderr.trim() || r.code}`,
    status: r.error?.code === "ENOENT" ? "pi_unavailable" : "failed",
    exitCode: r.error?.code === "ENOENT" ? 127 : r.code || 1,
  };
  const text = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").find(Boolean) || "";
  return { version: text.match(/\d+\.\d+\.\d+\S*/)?.[0] || text || "unknown" };
}

/** null = ready or probe inconclusive (never block on a flaky auth probe). */
async function authProblem(bin, model, timeoutMs, onChild, cwd) {
  const provider = model.split("/")[0];
  const r = await runPi(bin, ["auth", "check", "--provider", provider, "--json"], Math.min(timeoutMs, PROBE_TIMEOUT_MS), onChild, cwd);
  if (r.error || r.timedOut) return null;
  try {
    const parsed = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop());
    if (parsed && typeof parsed.status === "string" && parsed.status !== "ready") {
      return `pi auth check for provider ${provider} reported "${parsed.status}"`;
    }
  } catch { /* inconclusive */ }
  return null;
}

// ---- event stream ------------------------------------------------------------------

function classifyError(text) {
  const t = String(text || "");
  if (/Upstream request failed|Endpoint is unavailable/i.test(t)) return "provider_unavailable";
  if (/quota|rate.?limit|too many requests|\b429\b|insufficient (balance|credit|funds)|credits? (exhausted|depleted|ran out)|out of credits|billing|usage limit|(limit|quota)s? (reached|exceeded)|exceeded .*(limit|quota)/i.test(t)) return "quota";
  if (/api key|unauthori[sz]ed|\b401\b|\b403\b|forbidden|not authenticated|no credentials|no auth|not logged in|invalid token/i.test(t)) return "auth";
  if (/requires global regions|model is unavailable|model .*not found|unknown model|no such model|not available in your region/i.test(t)) return "model";
  return "provider_error";
}

function textOf(message) {
  if (typeof message?.content === "string") return message.content.trim();
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.filter((p) => p?.type === "text").map((p) => p.text).join("").trim();
}

/** Incremental object reader: keeps only what the result needs, never the (huge) events. */
function makeEventReader() {
  const s = { sessionId: null, finalMessage: "", lastStop: null, errorMessage: null, retryFailed: null,
    agentEnds: 0, settled: false, provider: null, model: null, turnEnds: 0,
    messageUsage: { input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0 },
    usage: { input: 0, output: 0, cacheRead: 0, totalTokens: 0, cost: 0 }, junk: [] };
  const handle = (e) => {
    if (!e || typeof e !== "object") return;
    switch (e.type) {
      case "session": s.sessionId = e.id ?? s.sessionId; break;
      case "turn_end": {
        s.turnEnds += 1;
        const u = e.message?.usage;
        if (u) {
          s.usage.input += u.input || 0; s.usage.output += u.output || 0; s.usage.cacheRead += u.cacheRead || 0;
          s.usage.totalTokens += u.totalTokens || 0; s.usage.cost += u.cost?.total || 0;
        }
        s.provider = e.message?.provider ?? s.provider; s.model = e.message?.model ?? s.model;
        break;
      }
      case "message_end": {
        if (e.message?.role !== "assistant") break;
        s.lastStop = e.message.stopReason ?? null;
        s.errorMessage = ["error", "aborted"].includes(s.lastStop)
          ? (e.message.errorMessage || `stopReason ${s.lastStop}`) : null;
        s.finalMessage = textOf(e.message);
        s.provider = e.message.provider ?? s.provider;
        s.model = e.message.model ?? s.model;
        const u = e.message.usage;
        if (u) {
          s.messageUsage.input += u.input || 0; s.messageUsage.output += u.output || 0;
          s.messageUsage.cacheRead += u.cacheRead || 0; s.messageUsage.totalTokens += u.totalTokens || 0;
          s.messageUsage.cost += u.cost?.total || 0;
        }
        break;
      }
      case "agent_end": {
        s.agentEnds += 1;
        if (e.willRetry) break;
        const msgs = Array.isArray(e.messages) ? e.messages : [];
        const last = [...msgs].reverse().find((m) => m?.role === "assistant");
        if (!last) break;
        s.lastStop = last?.stopReason ?? null;
        s.errorMessage = last?.stopReason === "error" || last?.stopReason === "aborted"
          ? (last.errorMessage || `stopReason ${last.stopReason}`) : null;
        s.finalMessage = last ? textOf(last) : "";
        break;
      }
      case "auto_retry_end": if (e.success === false) s.retryFailed = e.finalError || "provider error"; break;
      case "agent_settled": s.settled = true; break;
      default: break;
    }
  };
  let diagnostic = "";
  const rememberJunk = line => {
    if (!line.trim()) return;
    try { JSON.parse(line); } catch {
      s.junk.push(line.slice(0, 300));
      if (s.junk.length > 20) s.junk.shift();
    }
  };
  const scan = makeEventScanner(handle);
  return {
    state: s,
    push(text) {
      scan(text);
      // Keep the local plain-text failure diagnostic, with bounded retained input.
      diagnostic = (diagnostic + text).slice(-MAX_BUFFERED_CHARS);
      let index;
      while ((index = diagnostic.indexOf("\n")) >= 0) {
        rememberJunk(diagnostic.slice(0, index));
        diagnostic = diagnostic.slice(index + 1);
      }
    },
    end() { rememberJunk(diagnostic); diagnostic = ""; },
  };
}

// ---- run ----------------------------------------------------------------------------

function prepareRunDir(opts, brief) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-${timestamp()}`);
  try { reserveOutput(outDir, "relay"); } catch (error) { fail(error.message); }
  const run = {
    startedAt,
    outDir,
    briefPath: join(outDir, "brief.txt"),
    finalPath: join(outDir, "final.txt"),
    logPath: join(outDir, "pi.jsonl"),
    stderrPath: join(outDir, "stderr.txt"),
    resultPath: join(outDir, "result.json"),
    sessionDir: opts.session ? opts.resumeSessionDir : join(outDir, "sessions"),
  };
  mkdirSync(run.sessionDir, { recursive: true });
  writeFileSync(run.briefPath, brief, "utf8");
  writeFileSync(run.stderrPath, "", "utf8");
  writeFileSync(run.logPath, "", "utf8");
  return run;
}

const READ_ONLY_EXCLUDED_TOOLS = "write,edit,bash";

function buildArgv(opts, run, model) {
  const argv = ["-p", "--mode", "json", "--model", model, "--session-dir", run.sessionDir];
  if (opts.session) argv.push("--session", opts.session);
  if (opts.effort) argv.push("--thinking", opts.effort);
  if (!opts.mcp || opts.readOnly) argv.push("--no-mcp");
  if (!opts.extensions || opts.readOnly) argv.push("--no-extensions");
  if (!opts.skills) argv.push("--no-skills");
  if (opts.readOnly) argv.push("--exclude-tools", READ_ONLY_EXCLUDED_TOOLS);
  // The brief rides as an @file attachment, not argv: Windows caps a command line at ~32K.
  argv.push(`@${run.briefPath}`, "Execute the attached brief.");
  return argv;
}

function makeResultWriter(opts, version, run, model) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      runContext: opts.runContext,
      lane: opts.lane,
      laneSource: opts.laneSource,
      tool: "pi",
      workdir: opts.cd,
      provider: (model || "").split("/")[0] || null,
      model,
      requestedModel: opts.model,
      effort: opts.effort,
      readOnly: opts.readOnly,
      readOnlyViolation: null,
      resumed: Boolean(opts.session),
      piVersion: version,
      sessionId: opts.session,
      sessionDir: run.sessionDir,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      finalPath: existsSync(run.finalPath) ? run.finalPath : null,
      logPath: existsSync(run.logPath) ? run.logPath : null,
      stderrPath: run.stderrPath,
      ...extra,
    };
    // Publish atomically so a polling orchestrator never reads a half-written file.
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function finishEarly(writeResult, run, fields, message) {
  const result = writeResult({ signal: null, finalMessage: "", touchedFiles: null, ...fields });
  printSummary(result, run.resultPath);
  process.stderr.write(`relay: ${message}\n`);
  process.exit(result.exitCode);
}

function dispatchToPi(opts, bin, run, writeResult, model, attempts = [], runtime = {}) {
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  const attemptStarted = now();
  const signalHandlers = new Map();
  const relayArtifacts = [run.outDir];
  const beforeState = gitWorktreeFingerprint(opts.cd, relayArtifacts);
  const dirtyBefore = gitTouchedFiles(opts.cd);
  const argv = buildArgv(opts, run, model);
  const child = spawn(bin.cmd, [...bin.prefix, ...argv], {
    cwd: opts.cd,
    env: { ...process.env, PWD: opts.cd },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32", // POSIX: own process group so killChild fells the tree
  });

  const reader = makeEventReader();
  const stderrTail = [];
  let settled = false;
  let watchdogFired = false;
  let sigkillTimer = null;
  const watchdogTimer = setTimeout(() => {
    watchdogFired = true;
    child.once("exit", () => { child.stdout.destroy(); child.stderr.destroy(); });
    killChild(child);
    sigkillTimer = setTimeout(() => { if (!settled) killChild(child, "SIGKILL"); }, 10_000);
  }, opts.timeoutMs);

  const common = (extra = {}) => ({
    sessionId: reader.state.sessionId || opts.session,
    usage: reader.state.turnEnds ? reader.state.usage : reader.state.messageUsage,
    actualProvider: reader.state.provider,
    actualModel: reader.state.model,
    stopReason: reader.state.lastStop,
    dirtyBefore,
    attempts: [...attempts, { reason: extra.errorKind ?? extra.status, durationMs: now() - attemptStarted,
      status: extra.status, error: extra.error ?? null }],
    ...extra,
  });

  // The relay's own death must still produce a result (see agy-delegate for the rationale).
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      reader.end();
      const finalMessage = reader.state.finalMessage;
      if (finalMessage) writeFileSync(run.finalPath, finalMessage, "utf8");
      let finalized = false;
      const finalizeAbort = () => {
        if (finalized) return;
        finalized = true;
        if (sigkillTimer) clearTimeout(sigkillTimer);
        const afterState = gitWorktreeFingerprint(opts.cd, relayArtifacts);
        const result = writeResult(common({
          status: "aborted",
          exitCode: 128 + (constants.signals[sig] || 15),
          signal: sig,
          finalMessage,
          stderrTail: stderrTail.slice(-20),
          error: `the relay was killed by ${sig}; pi was terminated with it - inspect the working tree before re-dispatching`,
          touchedFiles: gitTouchedFiles(opts.cd),
          readOnlyViolation: readOnlyVerdict(opts, beforeState, afterState),
        }));
        printSummary(result, run.resultPath);
        process.exit(result.exitCode);
      };
      child.once("close", finalizeAbort);
      killChild(child);
      sigkillTimer = setTimeout(() => killChild(child, "SIGKILL"), 2000);
    };
    signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  child.stdout.on("data", (chunk) => {
    appendFileSync(run.logPath, chunk);
    reader.push(stdoutDecoder.write(chunk));
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(run.stderrPath, chunk);
    for (const line of stderrDecoder.write(chunk).split("\n")) if (line.trim()) stderrTail.push(line.trimEnd());
    while (stderrTail.length > 20) stderrTail.shift();
  });

  child.once("exit", () => {
    if (!watchdogFired) {
      clearTimeout(watchdogTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    }
    const drain = setTimeout(() => {
      if (settled) return;
      child.stdout.destroy();
      child.stderr.destroy();
    }, 500);
    if (typeof drain.unref === "function") drain.unref();
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    const afterState = gitWorktreeFingerprint(opts.cd, relayArtifacts);
    const result = writeResult(common({
      status: "failed",
      exitCode: 1,
      signal: null,
      finalMessage: "",
      touchedFiles: gitTouchedFiles(opts.cd),
      readOnlyViolation: readOnlyVerdict(opts, beforeState, afterState),
      error: String(err && err.message ? err.message : err),
    }));
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", async (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdogTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    if (watchdogFired) killChild(child, "SIGKILL");
    reader.push(stdoutDecoder.end());
    reader.end();
    const st = reader.state;
    const finalMessage = st.finalMessage;
    if (finalMessage) writeFileSync(run.finalPath, finalMessage, "utf8");
    const touchedFiles = gitTouchedFiles(opts.cd);
    const stderr = stderrTail.join("\n");
    const diagnostics = stderr.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-20);
    const afterState = gitWorktreeFingerprint(opts.cd, relayArtifacts);
    const worktreeChanged = beforeState !== null && afterState !== null && beforeState !== afterState;
    const readOnlyViolation = readOnlyVerdict(opts, beforeState, afterState);
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);
    const base = { signal: signal ?? null, finalMessage, touchedFiles, readOnlyViolation };

    let fields;
    // Pi exits 0 on provider errors: the decision comes from the event stream, not the exit code.
    const providerError = st.errorMessage || st.retryFailed
      || (st.agentEnds === 0 && !st.finalMessage && code === 0 ? (st.junk[st.junk.length - 1] || null) : null);
    if (watchdogFired) {
      fields = { ...base, status: "timeout", exitCode: 124, stderrTail: diagnostics,
        error: `pi did not finish within --timeout ${opts.timeout ?? DEFAULT_TIMEOUT}; killed by the relay watchdog` };
    } else if (providerError) {
      const errorKind = classifyError(providerError);
      const unavailable = errorKind === "auth";
      fields = { ...base, status: unavailable ? "pi_unavailable" : "model_unavailable", exitCode: unavailable ? 127 : 1,
        errorKind, quotaExhausted: errorKind === "quota", error: String(providerError).slice(0, 1000), stderrTail: diagnostics };
    } else if (code !== 0 && classifyError(stderr) === "provider_unavailable") {
      fields = { ...base, status: "model_unavailable", exitCode: 1, errorKind: "provider_unavailable",
        quotaExhausted: false, error: stderr.slice(0, 1000), stderrTail: diagnostics };
    } else if (code !== 0) {
      fields = { ...base, status: "failed", exitCode: mapped === 0 ? 1 : mapped, stderrTail: diagnostics,
        ...(classifyError(stderr) === "quota" ? { errorKind: "quota", quotaExhausted: true } : {}) };
    } else if (!finalMessage && !worktreeChanged) {
      fields = { ...base, status: "failed", exitCode: 1, stderrTail: diagnostics,
        error: "pi exited 0 without a final message or observable working-tree changes; the relay cannot confirm this dispatch completed" };
    } else {
      fields = { ...base, status: "completed", exitCode: 0, ...(!finalMessage ? { stderrTail: diagnostics } : {}) };
    }
    attempts.push({ reason: fields.errorKind ?? fields.status, durationMs: now() - attemptStarted,
      status: fields.status, error: fields.error ?? null });
    const retrySafe = beforeState !== null && afterState !== null && beforeState === afterState;
    if (fields.errorKind === "provider_unavailable" && retrySafe && attempts.length < 3) {
      process.stderr.write("relay: provider unavailable; retrying same call in 10 s\n");
      for (const [sig, handler] of signalHandlers) {
        process.removeListener(sig, handler);
        const abortWait = () => {
          const result = writeResult(common({ ...base, attempts, status: "aborted",
            exitCode: 128 + (constants.signals[sig] || 15), signal: sig,
            error: `the relay was killed by ${sig} while waiting to retry` }));
          printSummary(result, run.resultPath);
          process.exit(result.exitCode);
        };
        signalHandlers.set(sig, abortWait);
        process.on(sig, abortWait);
      }
      await sleep(10_000);
      for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
      dispatchToPi(opts, bin, run, writeResult, model, attempts, runtime);
      return;
    }
    fields.attempts = attempts;
    const reported = st.model ? { provider: st.provider, model: `${st.provider}/${st.model}` } : {};
    const result = writeResult(common({ ...fields, ...reported }));
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

export async function main(runtime = {}) {
  const opts = parseArgs(process.argv.slice(2));
  const CONTEXT_PREAMBLE = "CONTEXT HYGIENE: execute only this brief. Do not resume other sessions, import unrelated transcripts, or delegate recursively. Read only relevant file sections; keep full logs on disk and return paths, exit codes and a short summary.\n\n";
  const raw = readBrief(opts);
  if (!raw.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");
  const brief = CONTEXT_PREAMBLE + raw;

  const run = prepareRunDir(opts, brief);
  const model = resolveModel(opts.model);
  if (opts.effort === null && model === DEFAULT_MODEL) opts.effort = "max";
  if (!model) {
    const writeResult = makeResultWriter(opts, null, run, opts.model);
    finishEarly(writeResult, run, { status: "model_unavailable", exitCode: 2, errorKind: "model_not_allowed",
      error: `model "${opts.model}" is not in the pi-delegate allow-list (${ALLOWED_MODELS.join(", ")}); pi was not run` },
      `model "${opts.model}" is not allowed; allowed: ${ALLOWED_MODELS.join(", ")}`);
    return;
  }
  const bin = resolvePi();
  let writeResult = makeResultWriter(opts, null, run, model);
  if (!bin) {
    finishEarly(writeResult, run, { status: "pi_unavailable", exitCode: 127, errorKind: "binary",
      error: "pi binary not found (PI_DELEGATE_BIN, PATH, ~/.pi/agent/bin)" },
      "`pi` not found. Install the Pi coding agent (pinned 1.3.0) and authenticate it.");
    return;
  }
  let preflightChild = null;
  const handlers = new Map();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const handler = () => {
      killChild(preflightChild, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
      finishEarly(writeResult, run, { status: "aborted", exitCode: 128 + (constants.signals[sig] || 15),
        signal: sig, error: `the relay was killed by ${sig} during preflight; pi was not dispatched` }, "preflight aborted");
    };
    handlers.set(sig, handler);
    process.on(sig, handler);
  }
  const onChild = child => { preflightChild = child; };
  const probe = await piVersion(bin, opts.timeoutMs, onChild, opts.cd);
  writeResult = makeResultWriter(opts, probe.version ?? null, run, model);
  if (probe.error) {
    finishEarly(writeResult, run, { status: probe.status, exitCode: probe.exitCode,
      ...(probe.status === "pi_unavailable" ? { errorKind: "binary" } : {}), error: probe.error }, probe.error);
    return;
  }
  const problem = await authProblem(bin, model, opts.timeoutMs, onChild, opts.cd);
  for (const [sig, handler] of handlers) process.removeListener(sig, handler);
  if (problem) {
    finishEarly(writeResult, run, { status: "pi_unavailable", exitCode: 127, errorKind: "auth", error: problem }, problem);
    return;
  }
  dispatchToPi(opts, bin, run, writeResult, model, [], runtime);
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  pi ${result.piVersion ?? "?"}  ·  ${result.model ?? "?"}`);
  if (result.signal === "SIGKILL" && result.status === "failed") lines.push("hint: host killed pi (possible OOM or supervisor timeout); inspect partial work before re-dispatching.");
  if (result.signal === "SIGTERM" && result.status === "failed") lines.push("hint: pi was terminated externally; inspect the working tree before re-dispatching.");
  if (result.errorKind) lines.push(`error kind: ${result.errorKind}${result.quotaExhausted ? " (quota/limit exhausted)" : ""}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.resumed) lines.push("mode: resumed an existing session");
  if (result.sessionId) lines.push(`session id (same-task resume needs --task-id, --resume-from and --resume-reason): ${result.sessionId}`);
  if (result.usage) lines.push(`usage: ${result.usage.totalTokens} tokens, cost ${Number(result.usage.cost).toFixed(6)}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable - inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  ... and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("--- pi final report ---");
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

// Compare real paths: ~/.claude/skills/pi-delegate is a symlink to ~/.agents/skills/pi-delegate,
// and import.meta.url is already resolved, so a plain resolve() never matched and main() never ran.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntryPoint()) main();
