import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createRunContext, reserveOutput } from './context-policy.mjs';

const root = mkdtempSync(join(tmpdir(), 'worker-context-test-'));
let checks = 0;
const rejects = fn => { assert.throws(fn); checks++; };
try {
  const otherRepo = join(root, 'other'); mkdirSync(otherRepo);
  for (const provider of ['agy', 'codex', 'pi']) {
    const fresh = createRunContext({ provider, repo: root, taskId: 'task-a' });
    assert.equal(fresh.continuationCount, 0); checks++;
    assert.notEqual(createRunContext({ provider, repo: root }).taskId, createRunContext({ provider, repo: root }).taskId); checks++;
    const source = join(root, `${provider}.json`);
    const result = { status: 'completed', finishedAt: new Date().toISOString(),
      conversationId: 'conv-a', threadId: 'thread-a', sessionId: 'sess-a', runContext: fresh };
    writeFileSync(source, JSON.stringify(result));
    const resume = { provider, repo: root, taskId: 'task-a', resumeId: provider === 'agy' ? 'conv-a' : provider === 'pi' ? 'sess-a' : 'thread-a',
      resumeFrom: source, resumeReason: 'same-patch' };
    const once = createRunContext(resume);
    assert.equal(once.continuationCount, 1); checks++;
    assert.match(once.parentResultSha256, /^[a-f0-9]{64}$/); checks++;
    for (const override of [{ taskId: 'other-task' }, { repo: otherRepo }, { provider: provider === 'agy' ? 'codex' : 'agy' },
      { resumeId: 'wrong' }, { resumeFrom: undefined }, { resumeReason: undefined }, { resumeReason: 'new-task' }]) {
      rejects(() => createRunContext({ ...resume, ...override }));
    }
    writeFileSync(source, JSON.stringify({ ...result, runContext: once }));
    const twice = createRunContext(resume);
    assert.equal(twice.continuationCount, 2); checks++;
    writeFileSync(source, JSON.stringify({ ...result, runContext: twice }));
    rejects(() => createRunContext(resume));
    writeFileSync(source, JSON.stringify({ ...result, runContext: null }));
    rejects(() => createRunContext(resume));
    writeFileSync(source, JSON.stringify({ ...result, status: 'running' }));
    rejects(() => createRunContext(resume));
    rejects(() => createRunContext({ provider, repo: root, resumeFrom: source }));
  }
  const out = join(root, 'output');
  reserveOutput(out, 'wrapper'); reserveOutput(out, 'relay');
  rejects(() => reserveOutput(out, 'wrapper'));
  writeFileSync(join(out, 'result.json'), '{}');
  rejects(() => reserveOutput(out, 'another-owner'));
  console.log(`CONTEXT POLICY OK: ${checks} checks, no provider calls`);
} finally {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('worker-context-test-')) throw new Error('Unsafe test cleanup');
  rmSync(root, { recursive: true, force: true });
}
