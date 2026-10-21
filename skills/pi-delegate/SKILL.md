---
name: pi-delegate
description: >-
  Delegate a coding task to the Pi coding agent harness (`pi`, models deepseek-v4.1-flash or
  gemini-4-argon) as a cheap background implementer, then review its diff and land it yourself. Use
  this whenever the user wants to hand mechanical, high-volume or low-risk implementation work to Pi -
  phrasings like "have Pi do X", "delegate this to pi", "run it through pi", "use deepseek/pi to
  implement/fix/refactor" - or wants to run a queue of such tasks through Pi while staying the
  reviewer. DO NOT USE for tasks small enough to do inline, for work that touches third-party money
  (MT5 fleet, orders, accounts, boot/heartbeat - that is Codex only), or when the user wants the code
  written directly without delegating.
license: MIT
metadata:
  version: 0.1.0
---

# Pi Delegate

You are the **orchestrator**. This skill hands a bounded coding task to a separate **implementer** -
the Pi coding agent harness (`pi`, pinned 1.3.0) - then you review what it produced and land it
yourself. You write the brief and own the judgment; Pi does the typing in its own session; you verify
and commit. Same loop and same `result.json` contract as `codex-delegate` and `agy-delegate`, so the
three providers are handled by the same orchestrator code.

## When NOT to use this

- The task is small enough to do inline.
- You need a sandboxed implementer: Pi runs with the host account permissions.
- The work is critical (third-party money, MT5 fleet, orders, accounts, boot/heartbeat): Codex only.
- `pi` is not installed or not authenticated: the relay reports `pi_unavailable` (exit 127).

## Prerequisites (check once)

Node.js, git, and the Pi CLI (managed install in `~/.pi/agent`, Windows `pi.cmd` may be off PATH - the
relay finds it itself). `pi --version` prints `1.3.0`. Credentials are Pi's own (the `opencode-go`
provider via its auth store, `google` via the `GEMINI_API_KEY` environment variable). Never put a key in
a brief, log or commit; the relay never reads credentials.

## Choose the model

Explicit allow-list (the constant `ALLOWED_MODELS` in `scripts/relay.mjs`; it grows only by editing it):

| Model | Use |
|---|---|
| `opencode-go/deepseek-v4.1-flash` (default) | mechanical edits, tests, migrations, bulk refactors |
| `google/gemini-4-argon` | long-context reading, trickier synthesis |

Short names (`--model deepseek-v4.1-flash`) are accepted. Anything else fails before Pi runs, with
`status: "model_unavailable"` (`errorKind: "model_not_allowed"`) and exit 2.

## The loop

1. **Write the brief** ([references/writing-the-brief.md](references/writing-the-brief.md)): one task,
   self-contained, with the real gate commands and a report contract. Tell Pi it will not commit.
2. **Dispatch** with the helper (`<skill-dir>` = the folder containing this `SKILL.md`):

   ```bash
   node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
   # model:      --model deepseek-v4.1-flash | google/gemini-4-argon
   # effort:     --effort low|medium|high|xhigh|max (-> pi --thinking; default max for deepseek-v4.1-flash, Pi default for other models)
   # read-only:  --read-only                  (excludes write, edit and bash tools)
   # opt-ins:    --mcp --extensions --skills  (off by default)
   # resume the SAME task: --session ID --task-id TASK --resume-from previous/result.json --resume-reason same-patch
   # timeout:    --timeout 30m (default; use 1h or 2h for larger implementation briefs)
   ```

   Details: [references/dispatch-and-poll.md](references/dispatch-and-poll.md).
3. **Wait**: the helper blocks until Pi finishes. In Claude Code run it with `run_in_background: true`.
   A run is finished when `result.json` is written and the process exited.
4. **Review - never trust the self-report**: re-run the gates yourself, read the diff against the brief,
   start from `touchedFiles` (taken from `git status`, never from what Pi says it did). Checklist:
   [references/review-and-land.md](references/review-and-land.md).
5. **Land it**: the implementer edits the working tree; the orchestrator commits.

## Reading the status

Pi exits 0 even when the provider rejects the request, so the status comes from the JSON event stream:

| `status` | Meaning | Action |
|---|---|---|
| `completed` | Pi finished and produced a final message or changes | review the diff |
| `failed` | non-zero exit, or exit 0 with no message and no changes | inspect `stderrTail`, `pi.jsonl` |
| `timeout` | watchdog fired (exit 124) | inspect partial work before re-dispatching |
| `aborted` | the relay itself was killed | inspect the tree |
| `pi_unavailable` | binary missing or provider auth not ready (exit 127) | fallback provider, tell the operator |
| `model_unavailable` | provider/model rejected the run (e.g. HTTP 400 "requires Global regions", model off) | fallback provider; not a task failure |

`errorKind` is `quota`, `provider_unavailable`, `auth`, `model`, `provider_error`, `binary` or `model_not_allowed`. When
`quotaExhausted` is `true` the provider reported a rate limit or exhausted credits: switch provider at
most once, do not loop. `result.json` always records `provider` and `model` for audit.

`provider_unavailable` (Upstream request failed / Endpoint is unavailable, with or without 429/503) sets `quotaExhausted: false`; retry the same call at most twice, 10 s apart, only with a verified unchanged tree; `attempts` records reasons/durations; exhausted retries return `model_unavailable`.

## Worker context lifecycle

Each independent task is a **new session**. Resume only a correction to the same patch or a transient
retry: `--session ID --task-id TASK --resume-from previous/result.json --resume-reason same-patch`
(or `transient-retry`), with a **new output directory**. The relay checks task, canonical repo,
provider, session id and a completed run. After at most **two continuations** rotate to a fresh
session with a short handoff (objective, patch pointers, gates with exit codes, blocker, next action).
Sessions live in `<out-dir>/sessions`; the resume reuses the previous run's directory automatically.

## Permission model

Pi has no permission modes: in print mode it approves its own tool calls (the equivalent of a bypass).
Containment is therefore yours: run it on a working branch or worktree, never on a dirty main checkout;
`--read-only` removes write/edit/bash and the relay fingerprints the tree to report `readOnlyViolation`.
Default run: `--no-mcp --no-extensions --no-skills` (the repo's `AGENTS.md`/`CLAUDE.md` still load).

## Authorization model

Delegation is something the human opts into. Once they have, committing verified, gate-passing work is
the agreed contract. **Surface, don't absorb** (report Pi's design decisions and unasked turns) and
**stop for scope changes**.

For the upstream merge decisions and repeat procedure, see [MERGE-UPSTREAM.md](MERGE-UPSTREAM.md).

## Tests

`node scripts/relay.test.mjs` - deterministic, fake `pi`, no cost. `PI_LIVE=1 node scripts/relay.live.test.mjs`
- three real runs on `deepseek-v4.1-flash` (a few cents). `node scripts/context-policy.selftest.mjs`.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md)
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md)
- [references/review-and-land.md](references/review-and-land.md)
- [references/multi-task-queues.md](references/multi-task-queues.md)
