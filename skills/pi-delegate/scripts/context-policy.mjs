import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, realpathSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const MAX_CONTINUATIONS = 2;
const canonical = p => {
  const value = realpathSync(resolve(p));
  return process.platform === 'win32' ? value.toLowerCase() : value;
};

// This proves local provenance, not that two natural-language tasks mean the same thing.
export function createRunContext({ provider, repo, taskId, resumeId, resumeFrom, resumeReason }) {
  const workdir = canonical(repo);
  if (taskId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(taskId)) {
    throw new Error('--task-id must be a short stable identifier (letters, digits, dot, dash, underscore)');
  }
  if (!resumeId) {
    if (resumeFrom || resumeReason) throw new Error('--resume-from/--resume-reason require an explicit conversation/session ID');
    return { schema: 'worker-context.v1', provider, repo: workdir, taskId: taskId || randomUUID(), continuationCount: 0, parentResult: null };
  }
  if (!taskId || !resumeFrom || !['same-patch', 'transient-retry'].includes(resumeReason)) {
    throw new Error('Resume requires --task-id, --resume-from <previous result.json> and --resume-reason same-patch|transient-retry; independent tasks need a fresh session');
  }
  const source = canonical(resumeFrom);
  const raw = readFileSync(source, 'utf8');
  const previous = JSON.parse(raw);
  const context = previous.runContext;
  if (!context || context.schema !== 'worker-context.v1' || context.provider !== provider ||
      context.taskId !== taskId || canonical(context.repo) !== workdir ||
      (provider === 'agy' ? previous.conversationId : provider === 'pi' ? previous.sessionId : previous.threadId) !== resumeId ||
      !['completed', 'failed', 'timeout', 'aborted'].includes(previous.status) || !previous.finishedAt ||
      !Number.isInteger(context.continuationCount) || context.continuationCount < 0) {
    throw new Error('Resume provenance mismatch or legacy/incomplete result; start fresh with a bounded handoff');
  }
  if (context.continuationCount >= MAX_CONTINUATIONS) {
    throw new Error('Context rotation required after 2 continuations; start fresh with objective, current files, gates and remaining blocker, without transcript/log dumps');
  }
  return {
    schema: 'worker-context.v1', provider, repo: workdir, taskId,
    continuationCount: context.continuationCount + 1,
    parentResult: source, parentResultSha256: createHash('sha256').update(raw).digest('hex'), resumeReason,
  };
}

export function reserveOutput(directory, owner) {
  mkdirSync(directory, { recursive: true });
  if (existsSync(join(directory, 'result.json'))) throw new Error('Output already contains a result; choose a new output directory for every dispatch');
  try {
    writeFileSync(join(directory, `.${owner}-run.lock`), `${process.pid}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Output already used by a dispatch; choose a new output directory');
    throw error;
  }
}
