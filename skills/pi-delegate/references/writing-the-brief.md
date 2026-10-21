# Writing the brief

Pi sees only the text you send plus what it can read in the workspace (and the repo's `AGENTS.md` /
`CLAUDE.md`, which the relay leaves enabled). No chat history, no shared context. The relay prepends a
short context-hygiene preamble and attaches the brief to Pi as a file, so size is not capped by the
command line.

## Structure

1. **Goal** - one sentence, and why (so Pi can decide edge cases).
2. **Current state** - files and symbols involved, with paths. Point at them; do not paste large code.
3. **What to change** - concrete and bounded. One task per brief.
4. **What not to touch** - files, public APIs, the test oracle, generated code.
5. **Gates** - the project's real commands (build, test, lint) and what green looks like.
6. **Constraints** - language level (e.g. Java 8 in bigplan), style, no new dependencies.
7. **Report contract** - what Pi must reply with: files changed, gate results with exit codes, open
   questions. Ask for a short report; full logs stay on disk.
8. **Boundaries** - "Do not commit, push or create branches. Do not delegate. Do not start background
   processes." Pi runs commands synchronously in its bash tool.

## Template

```text
GOAL: <one sentence + reason>

CONTEXT
- <path>: <what it does, what is relevant>

TASK
1. <step>
2. <step>

DO NOT TOUCH: <paths / behaviours>

GATES (run them, report exit codes):
- <command>

CONSTRAINTS: <language level, style, dependencies>

REPORT: files changed, gate exit codes, anything you were unsure about. Do not commit.
```

## Model fit

`deepseek-v4.1-flash` is cheap and fast: give it precise, mechanical, well-bounded work and an explicit
gate. For ambiguous design, long-context reading or synthesis choose `google/gemini-4-argon`, or do not
delegate. Never delegate work touching third-party money (Codex only).

## Secrets

Never put keys, tokens or passwords in a brief. Reference a path or env var the workspace can read. The
relay stores the brief in `<out-dir>/brief.txt`.

## Verify facts before dispatch

Discover the actual gates in `AGENTS.md`, `CLAUDE.md`, `package.json`, `Makefile` or equivalent;
copy their commands into the brief and require fixing failures before finishing. Restate the
load-bearing house rules even when context files load automatically from workspace parents.
Ask the closing report to identify deviations and decisions as well as gate exit codes.

Premises freeze at dispatch: there is no steering channel during the run. If a fact changes,
stop the run, inspect and reconcile partial edits, then dispatch a corrected brief. For rework
on the same patch send only the delta, using the explicit provenance flags in SKILL.md.
For diagnosis require a full cause investigation; for recommendations distinguish observed
facts, inferences and open questions, and use `--read-only`.
