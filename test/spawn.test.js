#!/usr/bin/env node
/**
 * Integration test for bin/review.js spawn behaviour:
 *   1. Pre-flight catches missing engine binary (exit 127)
 *   2. stdio[0]='ignore' so engines see EOF on stdin (no hang)
 *   3. Heartbeat fires when engine is silent
 *   4. Timeout kills hung engine with exit 124
 *   5. Tail flushed to stdout on exit when stdout was suppressed
 *   6. branch shortcut auto-detects default branch (smoke)
 *
 * Uses test/fixtures/codex (a node-based fake) as the engine binary, exposed
 * via PATH=fixtures:$PATH. Tests are independent and runnable in parallel.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REVIEW = path.join(__dirname, '..', 'bin', 'review.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'so-spawn-test-'));

let pass = 0;
let fail = 0;

function record(name, ok, info) {
  if (ok) {
    pass += 1;
    console.log(`PASS [${name}]`);
  } else {
    fail += 1;
    console.log(`FAIL [${name}]${info ? `: ${info}` : ''}`);
  }
}

// Helper: run review.js with a given env. Returns spawnSync result with the
// log file path injected at result.logPath. Captures stdout + stderr as
// strings.
function runReview({ env = {}, args = [], logPath, timeoutMs = 30_000 }) {
  const finalLog =
    logPath || path.join(TMP, `log-${Date.now()}-${Math.random()}.log`);
  const finalEnv = {
    ...process.env,
    // Shim PATH so `codex` resolves to our fake.
    PATH: `${FIXTURES}:${process.env.PATH}`,
    ...env,
  };
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      '--cwd=' + process.cwd(),
      `--log=${finalLog}`,
      ...args,
    ],
    { encoding: 'utf8', env: finalEnv, timeout: timeoutMs }
  );
  r.logPath = finalLog;
  r.logContent = '';
  try {
    r.logContent = fs.readFileSync(finalLog, 'utf8');
  } catch {
    /* may not exist on failure paths */
  }
  return r;
}

// ─── Test 1: pre-flight catches missing binary ────────────────────────────
{
  // Wipe PATH (apart from /usr/bin for spawnSync itself) so `codex` is gone.
  const r = spawnSync(
    process.execPath,
    [REVIEW, '--engine=codex', '--cwd=' + process.cwd(), 'noop'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      timeout: 5000,
    }
  );
  const ok = r.status === 127 && /not found on PATH/i.test(r.stderr || '');
  record(
    'preflight missing binary → exit 127',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 2: stdio[0]='ignore' → fake engine sees EOF on stdin ────────────
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'echo-stdin' }, args: ['noop'] });
  const ok =
    r.status === 0 &&
    /STDIN_CLOSED bytes=0/.test(r.logContent) &&
    !/STDIN_HANG/.test(r.logContent);
  record(
    'stdio ignore: child stdin is EOF',
    ok,
    `status=${r.status} logTail=${r.logContent.slice(-200)}`
  );
}

// ─── Test 3: heartbeat fires when engine silent ───────────────────────────
{
  // Fake sleeps 5s with no output; heartbeat=1s → expect ≥2 heartbeats.
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'silent 3' },
    args: ['--heartbeat=1', '--timeout=15', 'noop'],
  });
  const matches = (r.logContent.match(/^# heartbeat /gm) || []).length;
  const ok = r.status === 0 && matches >= 2;
  record(
    'heartbeat: ≥2 ticks when engine silent',
    ok,
    `status=${r.status} heartbeats=${matches}`
  );
}

// ─── Test 4: timeout kills hung engine with exit 124 ──────────────────────
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'hang' },
    args: ['--timeout=2', '--heartbeat=0', 'noop'],
    timeoutMs: 20_000,
  });
  const ok =
    r.status === 124 &&
    /TIMEOUT after/.test(r.logContent) &&
    /SIGTERM/.test(r.logContent);
  record(
    'timeout: hung engine killed with exit 124',
    ok,
    `status=${r.status} sigterm=${/SIGTERM/.test(r.logContent)}`
  );
}

// ─── Test 5: tail flushed to stdout on exit when suppressed ───────────────
{
  // spawnSync inherits no TTY → stdout is suppressed in review.js. We expect
  // the engine's last bytes to appear on stdout after exit.
  const r = runReview({ env: { FAKE_BEHAVIOR: 'ok' }, args: ['noop'] });
  const ok =
    r.status === 0 &&
    /engine output tail/i.test(r.stdout || '') &&
    /\[fake-codex ok\] review complete/.test(r.stdout || '');
  record(
    'tail: last bytes flushed to stdout on exit',
    ok,
    `status=${r.status} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 6: --diff=branch auto-detects default branch ────────────────────
// Smoke only — works if this checkout has origin/HEAD set. If not, the
// resolver returns null and we fall back to HEAD~1..HEAD. Either way the
// command should NOT fail with a hard error from missing origin/main.
{
  // Use a tiny prompt and FAKE ok so the engine doesn't actually need to
  // process anything. We only care that diff resolution succeeded.
  const repo = path.join(__dirname, '..');
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      `--cwd=${repo}`,
      '--diff=branch',
      `--log=${path.join(TMP, 'branch.log')}`,
      'noop',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_BEHAVIOR: 'ok',
      },
      timeout: 15_000,
    }
  );
  // We don't assert on exit code (the diff may be empty in CI), but stderr
  // must NOT show the old `git diff origin/main..HEAD failed` message — it
  // should either succeed, or fall back cleanly to HEAD~1..HEAD.
  const oldFailureMsg = /git diff origin\/main\.\.HEAD failed/.test(
    r.stderr || ''
  );
  const ok = !oldFailureMsg;
  record(
    'branch shortcut: no hard-coded origin/main failure',
    ok,
    `stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Cleanup ──────────────────────────────────────────────────────────────
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
