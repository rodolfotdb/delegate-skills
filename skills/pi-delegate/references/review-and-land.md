# Review and land

The relay never commits. The orchestrator verifies, then commits.

## Review checklist

1. **Status first.** Anything but `completed` is not a delivery (see the status table in SKILL.md).
   `model_unavailable` / `pi_unavailable` are provider problems: switch provider, do not blame the task.
2. **`touchedFiles`** comes from `git status`, not from Pi's account. Compare with `dirtyBefore`: files
   already dirty before the run are not necessarily Pi's.
3. **Read the diff** against the brief: what was asked, nothing more, nothing less. Look for edits to
   the test oracle, deleted tests, widened scope, new dependencies, hard-coded values.
4. **Re-run the gates yourself** (build, test, lint). Pi's claim that tests pass is not evidence.
5. For migrations round-trip them; for removals grep for dangling references.
6. For `--read-only`, check `readOnlyViolation` is `false`.

## Commit boundary

Commit only after the gates pass and the diff holds. Use a clear message; the orchestrator is the author
of record. Never let Pi commit or push.

## Rework

Corrections to the same patch: resume the session with explicit provenance
(`--session ID --task-id TASK --resume-from previous/result.json --resume-reason same-patch`, new
`--out-dir`), send only the delta. After two continuations, rotate to a fresh session with a short
handoff. A different problem is a new task, not a continuation.

## Surface, don't absorb

Report Pi's design decisions, defensible-but-unasked changes and non-blocking nitpicks instead of
silently keeping them. Stop and ask if correct completion needs going beyond the brief.

## Inspect the evidence before cleanup

Review existing-test edits before trusting gates. Unbriefed changes, skipped tests and loosened
assertions (truthy/contains replacing exact matches or widened tolerances) need explicit review.
For stateful behavior exercise the behavior, beyond compilation. Look for catch-all defaults
hiding errors, APIs absent from installed versions, dead scaffolding, duplicate clients or
logging styles, and abstractions with no caller.

Until reviewed and committed, the working tree may be the only copy of Pi's work. Inspect
`git status`, `git diff`, `git diff --cached`, and open untracked files directly before any
checkout/reset/clean or branch switch. After inspection, discard only work you have determined
should be discarded. Rework receives the same test, gate and diff review as the original patch.
`readOnlyViolation: null` means the relay could not prove read-only behavior, not that it passed.
