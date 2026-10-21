# Multi-task queues

A queue is a sequence of independent dispatches reviewed one by one.

1. **One session per task.** Never reuse a session across tasks; resume is only for corrections to the
   same patch.
2. **Order by dependency.** Land and commit task N (gates green) before dispatching N+1 so the next
   brief sees the committed state. Pi runs against the working tree, so do not run two writers in the
   same checkout: give each its own working tree (a branch name alone does not isolate files).
3. **Carry constraints forward in the brief**, not in conversation: restate the "do not touch" list and
   the gates in every brief. Pass pointers (paths, commit ids), not transcripts.
4. **Track progress outside Pi**: keep a small table (task, out-dir, status, commit). The `result.json`
   per task is the source of truth.
5. **Quota.** If a result has `quotaExhausted: true`, finish the queue on another provider at most once;
   do not loop retries.
6. **Pick the model per task.** `deepseek-v4.1-flash` for mechanical items, `gemini-4-argon` for
   long-context ones; the model lands in each `result.json` for cost audit.
7. **End-of-run coherence check.** After the last task run the full gates once on the combined tree and
   read the combined diff: individually correct patches can still conflict.

For larger queues, update the progress file after each landing with gate outcomes, review notes,
design decisions and questions needing human judgment. Carry decided helper names, fixtures and
interfaces into later briefs. In the final coherence pass, search for the changed concepts and
replay migrations from a clean state when applicable. Publish or open a PR only when authorized.
If a task exceeds its brief, review invalidates the plan, or gates expose a problem in already
landed work, report the landed commits and blocker before continuing dependent tasks.
