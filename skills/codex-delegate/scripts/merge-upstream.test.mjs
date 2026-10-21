// Offline regression harness: every child-process API is replaced before evaluating the relay.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

const relayURL = new URL('./relay.mjs', import.meta.url);
const source = fs.readFileSync(relayURL, 'utf8');
const hasUpstreamFlags = source.includes('case "--web-search"');
// Set only when running this harness against the pre-merge relay.
assert.ok(hasUpstreamFlags || process.env.CODEX_DELEGATE_MERGE_BASELINE === '1', 'upstream flags disappeared');
const artifactRoot = fileURLToPath(new URL('../.merge-upstream/', import.meta.url));
fs.mkdirSync(artifactRoot, { recursive: true });
const plain = value => JSON.parse(JSON.stringify(value));
class Exit extends Error { constructor(code) { super(`exit ${code}`); this.code = code; } }

function harness(platform = 'win32', overrides = {}) {
  const calls = [];
  const timers = [];
  const proc = Object.assign(new EventEmitter(), {
    platform, pid: 123, execPath: process.execPath, argv: ['node', 'relay'],
    cwd: () => artifactRoot,
    env: { PATH: 'C:\\bin;C:\\Users\\x\\Microsoft\\WindowsApps;C:\\Program Files\\WindowsApps\\pwsh',
      Path: 'C:\\tools;C:\\WindowsApps', CODEX_HOME: 'auth-home', SECRET: 'private', EXTRA: 'keep-me' },
    stdin: { isTTY: true }, stdout: { write() {} }, stderr: { write() {} },
    exit(code) { throw new Exit(code); }, kill(...args) { calls.push(['kill', ...args]); },
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 456, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write(s) { calls.push(['stdin', s]); }, end() {} }),
    kill(signal) { calls.push(['child.kill', signal]); },
  });
  child.stdout.destroy = child.stderr.destroy = () => {};
  const bindings = {
    ...fs, ...path, constants, StringDecoder, Buffer, URL, fileURLToPath, process: proc,
    tmpdir: () => artifactRoot,
    execSync(...args) { calls.push(['execSync', ...args]); return 'codex test\n'; },
    execFileSync(binary, ...args) {
      calls.push(['execFileSync', binary, ...args]);
      if (binary === 'git') return ' M src/a.mjs\n?? new.txt\n';
      if (binary === 'codex') return 'codex test\n';
      if (binary === 'taskkill') return '';
      throw new Error(`Unexpected executable: ${binary}`);
    },
    spawn(...args) { calls.push(['spawn', ...args]); return child; },
    spawnSync() { throw new Error('Unexpected lane resolution'); },
    setTimeout(fn, ms) { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    clearTimeout(t) { t.cleared = true; }, ...overrides,
  };
  const body = source.replace(/^import .*;\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(relayURL.href)).replace(/\bmain\(\);\s*$/, '');
  const context = vm.createContext(bindings);
  vm.runInContext(body + '\nglobalThis.api = { parseArgs, buildArgv, codexEnv, codexVersion, versionProbeTimeout, spawnShellLaunch, prepareRunDir, makeResultWriter, reportUnavailable, reportVersionFailure, dispatchToCodex, stderrTail, main };', context);
  return { ...context.api, calls, timers, proc, child };
}

function expectExit(fn, code) { assert.throws(fn, e => e instanceof Exit && e.code === code); }
function runSetup(h, flags = []) {
  const dir = fs.mkdtempSync(path.join(artifactRoot, 'test-'));
  const opts = h.parseArgs(['--out-dir', dir, ...flags]);
  const run = h.prepareRunDir(opts, 'brief with spaces & Unicode: ação');
  return { opts, run, writer: h.makeResultWriter(opts, 'codex test', run) };
}
function dispatch(h, flags = []) {
  const setup = runSetup(h, flags);
  h.dispatchToCodex(setup.opts, 'brief & $(never executed)', setup.run, setup.writer, {});
  return { ...setup, result: () => JSON.parse(fs.readFileSync(setup.run.resultPath, 'utf8')) };
}

test('legacy flags retain argv, stdin prompt, isolated config and Windows quoting', () => {
  const h = harness();
  const opts = h.parseArgs(['--model', 'gpt-6.1-sol', '--effort', 'medium', '--read-only',
    '--ignore-user-config', '--skip-git-repo-check', '--clean-env', '--keep-env', 'EXTRA', '--timeout', '2h']);
  assert.deepEqual(plain(h.buildArgv(opts, 'C:\\output with spaces\\final.txt')),
    ['exec', '--ignore-user-config', '--json', '-o', '"C:\\output with spaces\\final.txt"',
      '-s', 'read-only', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium', '--skip-git-repo-check', '-']);
  assert.equal(h.versionProbeTimeout(opts), 10000);
  assert.equal(h.versionProbeTimeout(h.parseArgs(['--timeout', '1s'])), 1000);
});

test('exact session, resume-last, explicit sandbox ordering and default resume behavior', () => {
  const h = harness('linux');
  for (const flags of [['--session', 'thread-1'], ['--resume-last']]) {
    const argv = h.buildArgv(h.parseArgs(flags), '/output space/final.txt');
    assert.ok(!argv.includes('-s'));
    assert.ok(argv.includes(flags[0] === '--session' ? 'thread-1' : '--last'));
    const explicit = h.buildArgv(h.parseArgs([...flags, '--read-only', '--effort', 'high']), '/f');
    assert.ok(explicit.indexOf('-s') < explicit.indexOf('resume'));
    assert.ok(explicit.indexOf('-c') > explicit.indexOf('resume'));
  }
});

test('invalid legacy arguments exit 2 before launching any child', () => {
  for (const args of [['--session', 'x', '--resume-last'], ['--session', 'x&calc'], ['--model', 'x&calc'],
    ['--effort', 'x y'], ['--keep-env', 'EXTRA'], ['--timeout', '0s'], ['--timeout', '999999h'],
    ['--sandbox', 'invalid'], ['--clean-env', '--keep-env', 'MISSING'], ['--unknown']]) {
    const h = harness(); expectExit(() => h.parseArgs(args), 2); assert.equal(h.calls.length, 0);
  }
});

test('WindowsApps is removed only in sandboxed Windows runs; clean env retains auth and opt-ins', () => {
  const h = harness();
  const clean = h.codexEnv(h.parseArgs(['--clean-env', '--keep-env', 'EXTRA']));
  assert.equal(clean.PATH, 'C:\\bin'); assert.equal(clean.SECRET, undefined);
  assert.equal(clean.CODEX_HOME, 'auth-home'); assert.equal(clean.EXTRA, 'keep-me');
  const inherited = h.codexEnv(h.parseArgs([]));
  assert.equal(inherited.Path, 'C:\\tools'); assert.equal(inherited.SECRET, 'private');
  assert.equal(h.codexEnv(h.parseArgs(['--sandbox', 'danger-full-access'])).PATH, h.proc.env.PATH);
  const posix = harness('linux'); assert.equal(posix.codexEnv(posix.parseArgs([])).PATH, posix.proc.env.PATH);
});

test('Node 24 Windows launch uses one shell string; POSIX preserves argv array', () => {
  const h = harness(); h.codexVersion(1000, { PATH: 'filtered' });
  assert.equal(h.calls[0][0], 'execSync'); assert.equal(h.calls[0][1], 'codex --version');
  assert.equal(h.calls[0][2].timeout, 1000); assert.equal(h.calls[0][2].env.PATH, 'filtered');
  h.spawnShellLaunch('codex', ['exec', '-o', '"C:\\space dir\\f"', '-'], {}, true);
  assert.equal(h.calls[1].length, 3); assert.equal(h.calls[1][1], 'codex exec -o "C:\\space dir\\f" -');
  assert.equal(h.calls[1][2].shell, true);
  const p = harness('linux'); p.codexVersion(1000, {});
  assert.equal(p.calls[0][0], 'execFileSync');
  p.spawnShellLaunch('codex', ['exec', '-'], {}, false);
  assert.deepEqual(plain(p.calls[1].slice(1)), ['codex', ['exec', '-'], {}]);
});

test('version preflight distinguishes missing executable from broken or hung installation', () => {
  for (const platform of ['win32', 'linux']) {
    const probe = error => harness(platform, { execSync() { throw error; }, execFileSync() { throw error; } });
    assert.equal(probe({ code: 'ENOENT' }).codexVersion(10, {}).error, null);
    const timeout = { code: 'ETIMEDOUT' };
    assert.equal(probe(timeout).codexVersion(10, {}).error, timeout);
    if (platform === 'win32') assert.equal(probe({ stderr: 'not recognized as an internal or external command' }).codexVersion(10, {}).error, null);
  }
});

test('result v1 metadata and completed contract retain field types and atomic publication', () => {
  const h = harness(); const s = dispatch(h);
  fs.writeFileSync(s.run.finalPath, ' completed report \n');
  const event = Buffer.from('{"thread_id":"thread-ação"}\n');
  const split = event.indexOf(Buffer.from('ç')) + 1;
  h.child.stdout.emit('data', event.subarray(0, split)); h.child.stdout.emit('data', event.subarray(split));
  expectExit(() => h.child.emit('close', 0, null), 0);
  const r = s.result();
  assert.equal(r.schema, 'delegate-relay.result.v1'); assert.equal(r.status, 'completed');
  assert.equal(r.exitCode, 0); assert.equal(r.signal, null); assert.equal(r.threadId, 'thread-ação');
  assert.equal(r.finalMessage, 'completed report'); assert.deepEqual(r.touchedFiles, [' M src/a.mjs', '?? new.txt']);
  for (const key of ['lane', 'laneSource', 'model', 'effort', 'session']) assert.equal(r[key], null);
  for (const key of ['resumeLast', 'cleanEnv', 'ignoreUserConfig']) assert.equal(r[key], false);
  assert.equal(r.sandbox, 'workspace-write'); assert.deepEqual(r.keepEnv, []);
  for (const key of ['workdir', 'codexVersion', 'startedAt', 'finishedAt', 'briefPath', 'eventsPath', 'finalPath', 'stderrPath']) assert.equal(typeof r[key], 'string');
  assert.ok(!('error' in r)); assert.ok(!('stderrTail' in r));
  assert.ok(!fs.existsSync(`${s.run.resultPath}.123.tmp`));
  assert.deepEqual(h.calls.find(c => c[0] === 'stdin'), ['stdin', 'brief & $(never executed)']);
  assert.ok(!h.calls.find(c => c[0] === 'execFileSync' && c[1] === 'git')[3].shell);
});

test('failed close and launch error preserve diagnostics and exit status', () => {
  const h = harness(); const s = dispatch(h);
  h.child.stderr.emit('data', Buffer.from('failure details\n'));
  expectExit(() => h.child.emit('close', 7, null), 7);
  assert.equal(s.result().status, 'failed'); assert.deepEqual(s.result().stderrTail, ['failure details']);
  const e = harness(); const t = dispatch(e);
  expectExit(() => e.child.emit('error', new Error('launch failure')), 1);
  assert.equal(t.result().status, 'failed'); assert.equal(t.result().error, 'launch failure');
});

test('signal, watchdog and aborted outcomes keep status/error contract', () => {
  const h = harness(); const s = dispatch(h);
  expectExit(() => h.child.emit('close', null, 'SIGKILL'), 137);
  assert.equal(s.result().status, 'failed'); assert.equal(s.result().signal, 'SIGKILL');
  const w = harness(); const t = dispatch(w, ['--timeout', '1s']);
  w.timers.find(t => t.ms === 1000).fn();
  expectExit(() => w.child.emit('close', 0, null), 1);
  assert.equal(t.result().status, 'timeout'); assert.match(t.result().error, /watchdog/);
  const a = harness(); const u = dispatch(a); a.proc.emit('SIGINT');
  assert.equal(u.result().status, 'aborted'); assert.equal(u.result().signal, 'SIGINT');
  assert.equal(u.result().exitCode, 130); assert.match(u.result().error, /SIGINT/);
});

test('unavailable and preflight errors publish legacy result and exit codes', () => {
  const h = harness(); const s = runSetup(h);
  expectExit(() => h.reportUnavailable(s.writer, s.run.resultPath), 127);
  assert.equal(JSON.parse(fs.readFileSync(s.run.resultPath)).status, 'codex_unavailable');
  for (const [error, status, exit] of [[{ code: 'ETIMEDOUT' }, 'timeout', 124], [{ status: 9 }, 'failed', 9]]) {
    expectExit(() => h.reportVersionFailure(s.opts, s.writer, s.run, error, 1000), exit);
    const r = JSON.parse(fs.readFileSync(s.run.resultPath));
    assert.equal(r.status, status); assert.match(r.error, /preflight/);
  }
});

test('stderr tail is bounded, Unicode-safe and marks partial lines', () => {
  const h = harness(); const { run } = runSetup(h);
  fs.writeFileSync(run.stderrPath, 'ação'.repeat(20000));
  const tail = h.stderrTail(run.stderrPath);
  assert.equal(tail.length, 1); assert.match(tail[0], /^\[truncated; read stderrPath\]/);
  assert.ok(!tail[0].includes('\ufffd'));
  fs.writeFileSync(run.stderrPath, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(h.stderrTail(run.stderrPath).length, 20);
});

test('new overrides apply after resume and add metadata without changing legacy fields', { skip: !hasUpstreamFlags }, () => {
  const h = harness('linux');
  for (const resume of [[], ['--session', 'thread-1'], ['--resume-last']]) {
    const { opts, run, writer } = runSetup(h, [...resume, '--sandbox', 'workspace-write', '--network-access',
      '--subagent-model', 'gpt-test', '--subagent-effort', 'high', '--web-search', 'live']);
    const argv = plain(h.buildArgv(opts, '/f'));
    const pairs = argv.flatMap((v, i) => v === '-c' ? [argv[i + 1]] : []);
    assert.deepEqual(pairs, ['agents.default_subagent_model=gpt-test', 'agents.default_subagent_reasoning_effort=high',
      'web_search=live', 'sandbox_workspace_write.network_access=true']);
    if (resume.length) assert.ok(argv.indexOf('-c') > argv.indexOf('resume'));
    const r = writer({ status: 'completed', exitCode: 0 });
    assert.equal(r.subagentModel, 'gpt-test'); assert.equal(r.subagentEffort, 'high');
    assert.equal(r.webSearch, 'live'); assert.equal(r.networkAccess, true);
    assert.equal(r.schema, 'delegate-relay.result.v1'); assert.ok(fs.existsSync(run.resultPath));
  }
});

test('new unsafe tokens and network/read-only or implicit-resume pairs fail before dispatch', { skip: !hasUpstreamFlags }, () => {
  for (const args of [['--subagent-model', 'x&calc'], ['--subagent-effort', 'x y'], ['--web-search', 'x;calc'],
    ['--network-access', '--read-only'], ['--network-access', '--session', 't'], ['--network-access', '--resume-last']]) {
    const h = harness(); expectExit(() => h.parseArgs(args), 2); assert.equal(h.calls.length, 0);
  }
  const h = harness(); assert.equal(h.parseArgs(['--read-only', '--web-search', 'live']).webSearch, 'live');
});
