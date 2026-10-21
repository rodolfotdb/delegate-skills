# Dispatch and poll

`scripts/relay.mjs` wraps `pi -p --mode json`, records the run and always writes `result.json`
(Node built-ins only; it shells out to `pi`, `git`, and `taskkill` on Windows).

## Flags

| Flag | Meaning |
|---|---|
| `--brief <file>` | brief path; stdin when omitted |
| `--cd <dir>` | working root (default cwd) |
| `--lane <name>` | fleet lane from delegate-setup (explicit flags win) |
| `--model <name>` | allow-list entry, `provider/id` or short id (default `opencode-go/deepseek-v4.1-flash`) |
| `--effort low\|medium\|high\|xhigh\|max` | passed as `--thinking` |
| `--read-only` | `--exclude-tools write,edit,bash`, MCP and extensions forced off |
| `--mcp` `--extensions` `--skills` | opt back in (default: all off) |
| `--timeout <dur>` | h/m/s watchdog, default `30m` |
| `--out-dir <dir>` | artifacts dir, fresh per dispatch (default under the system temp dir) |
| `--task-id` `--resume-from` `--resume-reason` `--session` | same-task resume, see SKILL.md |

Environment: `PI_DELEGATE_BIN` overrides the pi executable (a `.js`/`.mjs` runs under node; used by the
fake in tests). Without it the relay searches `PATH`, then `~/.pi/agent/bin`. On Windows it runs the
managed `pi-launcher.js` under node, so there is no `cmd.exe` quoting.

## What the relay does

1. Reads the brief, rejects an empty one (exit 2, no result).
2. Reserves the out-dir, writes `brief.txt`, creates `sessions/`.
3. Checks the model against the allow-list (fail early, no Pi run, result written).
4. Finds `pi`, runs `pi --version` and `pi auth check --provider <p> --json`; missing binary or auth
   not ready -> `pi_unavailable` (exit 127). The version probe has a 10 s cap (or the smaller
   `--timeout`): a hang returns `timeout`/124; a non-zero exit returns `failed` without dispatch.
   The auth probe retains its 60 s cap and an inconclusive result never blocks dispatch.
   Catchable signals during either probe terminate its process tree and write `aborted`.
5. Fingerprints the git tree, spawns Pi, streams stdout to `pi.jsonl`, parses events incrementally.
6. Watchdog on `--timeout`: kills the process tree (`taskkill /t` on Windows, process group elsewhere).
7. Fingerprints again, builds `touchedFiles` from `git status --porcelain`, writes `result.json`.

## Event stream (what the status is built from)

`session` (`id`), `turn_end` (`message.usage`, `provider`, `model`), `agent_end` (`messages`,
`willRetry`; the last assistant message has `stopReason` `stop` or `error` plus `errorMessage`),
`auto_retry_end` (`success`, `finalError`), `agent_settled`. Also accepts upstream
`message_end` assistant messages (string or text-part content). The object scanner tolerates
concatenated events, chunk boundaries, junk prefixes and missing final newlines; partial retained
objects are capped at 1 MiB. Usage comes from `turn_end` when present, otherwise `message_end`,
so emitting both does not double-count tokens. An assistant message with
`stopReason: "error"` or a failed auto-retry is a provider error even though the process exits 0.

## result.json (schema `delegate-relay.result.v1`)

`runContext`, `lane`, `tool: "pi"`, `workdir`, `provider`, `model`, `requestedModel`, `effort`,
`readOnly`, `readOnlyViolation` (null / false / true), `resumed`, `piVersion`, `sessionId`,
`sessionDir`, `startedAt`, `finishedAt`, `briefPath`, `finalPath`, `logPath`, `stderrPath`, `usage`
(`input`, `output`, `cacheRead`, `totalTokens`, `cost`), `dirtyBefore` (porcelain lines already dirty
before the run), `status`, `exitCode`, `signal`, `finalMessage`, `touchedFiles`, and when relevant
`actualProvider`, `actualModel`, `stopReason`, `error`, `errorKind`, `quotaExhausted`, `stderrTail`, `attempts` (reason/durationMs per dispatch).

Exit codes: 0 completed; 1 failed / provider error; 2 usage error or model outside the allow-list;
124 timeout; 127 `pi_unavailable`; 128+N when killed by signal N.

## Backgrounding

Claude Code: Bash with `run_in_background: true`, you are notified on exit. Elsewhere: background it and
poll for `result.json` (it is published atomically). A non-zero exit with no file is a usage error.

## Recovery

- `model_unavailable` with HTTP 400 "requires Global regions": the OpenCode workspace region setting;
  an operator fix, not a task failure.
- `provider_unavailable`: transient upstream/endpoint outage (including 429/503), `quotaExhausted: false`; the relay retries the same call twice at fixed 10 s intervals only if its tree fingerprint proves no changes; otherwise stops. After `model_unavailable`, the caller may switch models once.
- `quotaExhausted: true`: switch provider once (Codex or agy), do not retry in a loop.
- `timeout`: inspect `git status` and partial work before re-dispatching; a new session does not undo it.
- `failed` with a silent exit 0: read `pi.jsonl` and `stderr.txt`.

## Interrupted runs and lost work

On native Windows a hard kill of the relay cannot be caught; if it exited without a result,
inspect the tree and `pi.jsonl` directly. A child `SIGKILL` may indicate an OOM or supervisor
kill; `SIGTERM` with `failed` means external termination. Inspect partial work before retrying.
On POSIX the watchdog terminates the process group, then escalates after 10 s; Windows kills
the whole tree immediately with `taskkill /t /f`.

Use `pi.jsonl` to identify files and tool commands after an interrupted run. Preserve work
already in the tree. Any reconstruction from tool events must be verified against the diff;
replaying commands can duplicate mutations. `touchedFiles` includes pre-existing dirt and
may include artifacts when `--out-dir` is inside the worktree.
