// Offline regressions for the adapted upstream scanner and preflight.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'pi-merge-test-'));
const relay = fileURLToPath(new URL('./relay.mjs', import.meta.url));
const fake = join(root, 'probe.mjs');
writeFileSync(fake, `
const mode = process.env.MERGE_TEST_MODE;
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  if (mode === 'version-fail') process.exit(7);
  if (mode === 'version-hang') { setInterval(() => {}, 1000); }
  else { console.log('1.3.0'); process.exit(0); }
} else if (argv[0] === 'auth') {
  console.log('unsupported auth probe'); process.exit(1);
} else {
  if (mode === 'plain-quota') { console.log('429 {"message":"quota exceeded"}'); process.exit(0); }
  const msg = { role: 'assistant', provider: 'opencode-go', model: 'deepseek-v4.1-flash',
    content: 'done café 漢字', stopReason: 'stop',
    usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } } };
  if (mode === 'error') { msg.stopReason = 'error'; msg.errorMessage = '429 quota exceeded'; }
  const events = [{ type: 'session', id: 'merge-test' }, { type: 'message_end', message: msg }];
  if (mode === 'both') events.push({ type: 'turn_end', message: msg });
  if (mode === 'retry-success') {
    events[1].message = { ...msg, stopReason: 'error', errorMessage: '429 quota exceeded' };
    events.push({ type: 'agent_end', willRetry: true, messages: [events[1].message] });
    events.push({ type: 'message_end', message: msg });
  }
  if (mode !== 'message-only') events.push({ type: 'agent_end' });
  const prefix = mode === 'oversized' ? '{"bad":"' + 'x'.repeat(1100000) + '\\n' : 'junk \\" prefix ';
  const bytes = Buffer.from(prefix + events.map(JSON.stringify).join(''));
  let at = 0;
  const pump = () => {
    if (at >= bytes.length) return;
    const end = Math.min(at + (mode === 'oversized' ? 32768 : 7), bytes.length);
    const chunk = bytes.subarray(at, end); at = end;
    process.stdout.write(chunk, () => setImmediate(pump));
  };
  pump();
}
`);
let count = 0;
function run(mode, args = []) {
  const out = join(root, `out-${++count}`);
  const child = spawnSync(process.execPath, [relay, '--cd', root, '--out-dir', out, ...args], {
    input: 'offline test', encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PI_DELEGATE_BIN: fake, MERGE_TEST_MODE: mode },
  });
  assert.ifError(child.error);
  const result = existsSync(join(out, 'result.json')) ? JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')) : null;
  return { child, result };
}
try {
  for (const mode of ['concatenated', 'both', 'oversized', 'retry-success', 'message-only']) {
    const { child, result } = run(mode);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(result.status, 'completed');
    assert.equal(result.finalMessage, 'done café 漢字');
    assert.equal(result.sessionId, 'merge-test');
    assert.equal(result.actualProvider, 'opencode-go');
    assert.equal(result.stopReason, 'stop');
    if (mode !== 'retry-success') assert.equal(result.usage.totalTokens, 15);
    console.log(`ok ${mode}: chunked UTF-8, string message, no final newline`);
  }
  const quota = run('error');
  assert.equal(quota.result.status, 'model_unavailable');
  assert.equal(quota.result.errorKind, 'quota');
  assert.equal(quota.result.quotaExhausted, true);
  console.log('ok message_end error retains structured quota contract');
  const plain = run('plain-quota');
  assert.equal(plain.result.status, 'model_unavailable');
  assert.equal(plain.result.quotaExhausted, true);
  console.log('ok plain-text quota with JSON fragment preserves local diagnostic');
  const failed = run('version-fail');
  assert.equal(failed.child.status, 7);
  assert.equal(failed.result.status, 'failed');
  assert.match(failed.result.error, /preflight failed/);
  console.log('ok nonzero version preflight prevents dispatch');
  const hung = run('version-hang', ['--timeout', '1s']);
  assert.equal(hung.child.status, 124);
  assert.equal(hung.result.status, 'timeout');
  console.log('ok hung version preflight kills child and writes timeout/124');
  const badCwd = run('concatenated', ['--cd', fake]);
  assert.equal(badCwd.child.status, 2);
  assert.equal(badCwd.result, null);
  console.log('ok file as working directory is a usage error');
  console.log('MERGE UPSTREAM OK: 10 cases, no provider calls');
} finally {
  rmSync(root, { recursive: true, force: true });
}
