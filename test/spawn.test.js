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

// ─── Concurrency helpers ──────────────────────────────────────────────────
// Run a 2-slot codex fusion (same engine, two models → two distinct slots) with
// the `probe` fake, which records START/END timestamps to a shared file. Parse
// the intervals so tests can assert overlap (parallel) vs no-overlap (serial).
function runFusionProbe({ args = [], probeName, sleepSec = 1 }) {
  const probe = path.join(TMP, probeName);
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex:m1',
      '--engine=codex:m2',
      '--cwd=' + process.cwd(),
      '--heartbeat=0',
      ...args,
      'noop',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_BEHAVIOR: `probe ${sleepSec}`,
        FAKE_PROBE_FILE: probe,
      },
      timeout: 30_000,
    }
  );
  let starts = [];
  let ends = [];
  try {
    const rows = fs
      .readFileSync(probe, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(/\s+/));
    starts = rows
      .filter((e) => e[0] === 'START')
      .map((e) => Number(e[2]))
      .sort((a, b) => a - b);
    ends = rows
      .filter((e) => e[0] === 'END')
      .map((e) => Number(e[2]))
      .sort((a, b) => a - b);
  } catch {
    /* file may be absent on failure paths */
  }
  return { r, starts, ends };
}

// ─── Test 7: --concurrency=1 serializes fusion children ───────────────────
{
  const { r, starts, ends } = runFusionProbe({
    args: ['--concurrency=1'],
    probeName: 'probe-serial.log',
  });
  // Serialized: the second child must START at/after the first child's END.
  const ok =
    r.status === 0 &&
    starts.length === 2 &&
    ends.length === 2 &&
    starts[1] >= ends[0];
  record(
    'concurrency=1: fusion children run serially',
    ok,
    `status=${r.status} starts=${starts} ends=${ends}`
  );
}

// ─── Test 8: default (unbounded) fusion runs children in parallel ─────────
{
  const { r, starts, ends } = runFusionProbe({
    args: [],
    probeName: 'probe-parallel.log',
  });
  // Parallel: the second child STARTs before the first child ENDs (overlap).
  const ok =
    r.status === 0 &&
    starts.length === 2 &&
    ends.length === 2 &&
    starts[1] < ends[0];
  record(
    'default: fusion children run in parallel (overlap)',
    ok,
    `status=${r.status} starts=${starts} ends=${ends}`
  );
}

// ─── Test 9: invalid --concurrency rejected ───────────────────────────────
{
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex:m1',
      '--engine=codex:m2',
      '--cwd=' + process.cwd(),
      '--concurrency=abc',
      'noop',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${FIXTURES}:${process.env.PATH}` },
      timeout: 10_000,
    }
  );
  const ok = r.status === 1 && /--concurrency/.test(r.stderr || '');
  record(
    'concurrency: invalid value → exit 1',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── agy model passthrough helpers ───────────────────────────────────────
// Run review.js against the fake `agy` binary, which dumps its argv to a file.
// Returns the recorded argv as an array of lines so tests can assert whether
// review.js forwarded --model.
function runAgyArgv({ engineSpec, probeName, extraArgs = [], cwd, env = {} }) {
  const argvFile = path.join(TMP, probeName);
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      engineSpec,
      '--cwd=' + (cwd || process.cwd()),
      `--log=${path.join(TMP, probeName + '.engine.log')}`,
      ...extraArgs,
      'noop',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_ARGV_FILE: argvFile,
        ...env,
      },
      timeout: 15_000,
    }
  );
  let argv = [];
  try {
    argv = fs
      .readFileSync(argvFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
  } catch {
    /* file may be absent on failure paths */
  }
  return { r, argv };
}

// ─── Test 10: agy forwards inline model as --model ────────────────────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=agy:gpt-oss',
    probeName: 'agy-model',
  });
  const mi = argv.indexOf('--model');
  const printIdx = argv.indexOf('--print');
  const ok =
    r.status === 0 &&
    mi >= 0 &&
    argv[mi + 1] === 'gpt-oss' &&
    printIdx >= 0 &&
    mi < printIdx; // --model must precede --print (prompt follows --print)
  record(
    'agy: inline model forwarded as --model (before --print)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 11: agy omits --model when no model given ───────────────────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=agy',
    probeName: 'agy-nomodel',
  });
  const ok =
    r.status === 0 && !argv.includes('--model') && argv.includes('--print');
  record(
    'agy: no model → no --model flag, still --print',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 12: review.js flag after `--` → warning, still forwarded ────────
// `--concurrency=3` after the bare `--` is the documented footgun: it goes to
// the engine CLI, not review.js. We must (a) emit a clear stderr note and
// (b) still run the engine (pass-through contract intact). The fake codex
// ignores its own argv, so it exits 0 regardless.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: ['noop', '--', '--concurrency=3'],
  });
  const warned =
    /look like review\.js flag/i.test(r.stderr || '') &&
    /--concurrency=3/.test(r.stderr || '');
  const stillRan = r.status === 0 && /\[fake-codex ok\]/.test(r.logContent);
  record(
    'misplaced-flag guard: warns yet forwards (engine still runs)',
    warned && stillRan,
    `status=${r.status} warned=${warned} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 13: no false positive when engine args are not review.js flags ──
// Genuine engine args after `--` must NOT trigger the warning.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: ['noop', '--', '--some-engine-flag', 'value'],
  });
  const ok =
    r.status === 0 && !/look like review\.js flag/i.test(r.stderr || '');
  record(
    'misplaced-flag guard: no false positive on real engine args',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 14: cmd forwards inline model as -m (before --print prompt) ──────
// runAgyArgv is engine-agnostic (it just runs the given engineSpec with a
// FAKE_ARGV_FILE), so reuse it for the fake `cmd` fixture too.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=cmd:claude-sonnet-4-6',
    probeName: 'cmd-model',
  });
  const mi = argv.indexOf('-m');
  const printIdx = argv.indexOf('--print');
  const ok =
    r.status === 0 &&
    mi >= 0 &&
    argv[mi + 1] === 'claude-sonnet-4-6' &&
    printIdx >= 0 &&
    argv.includes('--skip-onboarding');
  record(
    'cmd: inline model forwarded as -m, with --print + --skip-onboarding',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 15: cmd omits -m when no model given, keeps functional flags ─────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=cmd',
    probeName: 'cmd-nomodel',
  });
  const ok =
    r.status === 0 &&
    !argv.includes('-m') &&
    argv.includes('--print') &&
    argv.includes('--skip-onboarding');
  record(
    'cmd: no model → no -m, still --print + --skip-onboarding',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 16: cursor alias resolves to `agent`; inline model → --model ─────
// `--engine=cursor:<model>` must (a) resolve the alias to the `agent` binary
// (our fake fixture) and (b) forward the model as --model, with the functional
// --print + --trust flags and the gated --plan safety flag present.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=cursor:sonnet-4',
    probeName: 'cursor-model',
  });
  const mi = argv.indexOf('--model');
  const ok =
    r.status === 0 &&
    mi >= 0 &&
    argv[mi + 1] === 'sonnet-4' &&
    argv.includes('--print') &&
    argv.includes('--trust') &&
    argv.includes('--plan');
  record(
    'cursor alias: resolves to agent, model forwarded as --model (+ --print/--trust/--plan)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 17: agent omits --model when no model, keeps functional flags ────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=agent',
    probeName: 'agent-nomodel',
  });
  const ok =
    r.status === 0 &&
    !argv.includes('--model') &&
    argv.includes('--print') &&
    argv.includes('--trust');
  record(
    'agent: no model → no --model, still --print + --trust',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 18: codex forwards --skip-git-repo-check (after exec, before prompt)
// review.js must auto-append --skip-git-repo-check so codex exec doesn't
// hard-fail ("Not inside a trusted directory") when --cwd isn't a git repo.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'codex-trust',
  });
  const execIdx = argv.indexOf('exec');
  const skipIdx = argv.indexOf('--skip-git-repo-check');
  const promptIdx = argv.indexOf('noop');
  const ok =
    r.status === 0 && execIdx >= 0 && skipIdx > execIdx && promptIdx > skipIdx;
  record(
    'codex: --skip-git-repo-check forwarded (exec < flag < prompt)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 19: codex --skip-git-repo-check survives --unrestricted ──────────
// It is a FUNCTIONAL flag, not a safety flag, so --unrestricted (which drops
// -s/read-only) must NOT drop it.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'codex-trust-unrestricted',
    extraArgs: ['--unrestricted'],
  });
  const ok =
    r.status === 0 &&
    argv.includes('--skip-git-repo-check') &&
    !argv.includes('read-only'); // safety flag dropped by --unrestricted
  record(
    'codex: --skip-git-repo-check kept under --unrestricted (safety dropped)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 20: codex unavailable pinned model preserves failure ─────────────
// Codex has no reliable local model-listing command. If a user pins a model
// that this Codex install/account cannot use, keep the original failure and
// add a recovery hint instead of silently retrying with a different model.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex:gpt-5.4-mini',
    probeName: 'codex-model-fallback',
    env: { FAKE_BEHAVIOR: 'model-unavailable' },
  });
  const logPath = path.join(TMP, 'codex-model-fallback.engine.log');
  const log = fs.readFileSync(logPath, 'utf8');
  const ok =
    r.status === 2 &&
    argv.includes('-m') &&
    argv.includes('gpt-5.4-mini') &&
    /model 'gpt-5\.4-mini' not available/.test(log) &&
    /codex model unavailable/.test(log) &&
    /bare --engine=codex/.test(log);
  record(
    'codex: unavailable pinned model preserves failure with hint',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)} log=${log.slice(-400)}`
  );
}

// ─── Test 21: gemini forwards --skip-trust (with -p) ──────────────────────
// review.js must auto-append --skip-trust so gemini doesn't hard-fail
// ("not running in a trusted directory") in headless mode.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=gemini',
    probeName: 'gemini-trust',
  });
  const ok =
    r.status === 0 && argv.includes('--skip-trust') && argv.includes('-p');
  record(
    'gemini: --skip-trust forwarded (with -p)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 22: gemini --skip-trust survives --unrestricted ─────────────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=gemini',
    probeName: 'gemini-trust-unrestricted',
    extraArgs: ['--unrestricted'],
  });
  const ok =
    r.status === 0 && argv.includes('--skip-trust') && !argv.includes('-s'); // gemini safety flag dropped by --unrestricted
  record(
    'gemini: --skip-trust kept under --unrestricted (safety dropped)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 22: opencode forwards --dir <cwd> ───────────────────────────────
// review.js must pass --dir <cwd> so opencode scopes its sandbox file-access
// root to the review cwd (otherwise subtree reads are "external_directory").
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=opencode:testprov/testmodel',
    probeName: 'opencode-dir',
  });
  const dirIdx = argv.indexOf('--dir');
  const ok =
    r.status === 0 &&
    argv.includes('run') &&
    dirIdx >= 0 &&
    argv[dirIdx + 1] === process.cwd() &&
    argv.includes('--model');
  record(
    'opencode: --dir <cwd> forwarded (with run + --model)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 23: empty output (0 bytes) → exit 3 + "no output" note ──────────
// An engine that exits 0 but produces nothing must not be reported as success.
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'empty' }, args: ['noop'] });
  const ok =
    r.status === 3 && /no output/i.test((r.stderr || '') + r.logContent);
  record(
    'empty output: exit 3 + no-output note',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 24: output without envelope → exit 3 + envelope note ────────────
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'noenvelope' }, args: ['noop'] });
  const ok =
    r.status === 3 && /envelope/i.test((r.stderr || '') + r.logContent);
  record(
    'no-envelope output: exit 3 + envelope note',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 25: well-formed envelope output → exit 0 (regression guard) ─────
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'ok' }, args: ['noop'] });
  const ok = r.status === 0 && /SECOND_OPINION_START/.test(r.logContent);
  record(
    'envelope present: exit 0',
    ok,
    `status=${r.status} logTail=${r.logContent.slice(-160)}`
  );
}

// ─── Test 26: --no-wrap skips the envelope check (no-envelope → exit 0) ────
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'noenvelope' },
    args: ['--no-wrap', 'noop'],
  });
  const ok = r.status === 0;
  record(
    '--no-wrap: no-envelope output is not flagged (exit 0)',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 27: --no-wrap still flags empty output (exit 3) ─────────────────
// The 0-byte check is independent of the envelope; empty output is never useful.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'empty' },
    args: ['--no-wrap', 'noop'],
  });
  const ok =
    r.status === 3 && /no output/i.test((r.stderr || '') + r.logContent);
  record(
    '--no-wrap: empty output still exit 3',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 28: 0-byte heartbeat carries a distinct outage note ─────────────
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'silent 3' },
    args: ['--heartbeat=1', '--timeout=15', 'noop'],
  });
  const ok =
    r.status === 0 &&
    /# heartbeat /m.test(r.logContent) &&
    /(NO OUTPUT YET|possible upstream)/i.test(r.logContent);
  record(
    '0-byte heartbeat: distinct outage note while engine silent',
    ok,
    `status=${r.status} logSample=${(r.logContent.match(/# heartbeat[^\n]*/g) || []).join(' | ').slice(0, 220)}`
  );
}

// ─── Test 29: multiple --file= args embed every file ──────────────────────
{
  const fa = path.join(TMP, 'multi-a.txt');
  const fb = path.join(TMP, 'multi-b.txt');
  fs.writeFileSync(fa, 'ALPHA_CONTENT_MARKER\n');
  fs.writeFileSync(fb, 'BETA_CONTENT_MARKER\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'multi-file',
    extraArgs: [`--file=${fa}`, `--file=${fb}`],
  });
  // The fixture dumps argv newline-joined and the helper re-splits on '\n', so
  // a multi-line prompt is spread across entries — rejoin to recover it whole.
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    /ALPHA_CONTENT_MARKER/.test(prompt) &&
    /BETA_CONTENT_MARKER/.test(prompt) &&
    prompt.includes(fa) &&
    prompt.includes(fb);
  record(
    'multi --file: both files embedded in the prompt',
    ok,
    `status=${r.status} promptHas=A:${/ALPHA/.test(prompt)} B:${/BETA/.test(prompt)}`
  );
}

// ─── Test 30: --diff=unstaged includes UNTRACKED files ────────────────────
// Build a throwaway git repo with one modified tracked file and one untracked
// file, then assert the embedded diff (last argv = the prompt) contains both.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'so-untracked-'));
  function git(...a) {
    return spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  }
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\nMODIFIED_LINE\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'UNTRACKED_MARKER\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'untracked',
    extraArgs: ['--diff=unstaged'],
    cwd: repo,
  });
  const prompt = argv.join('\n'); // rejoin multi-line prompt (see test 29)
  const ok =
    r.status === 0 &&
    /MODIFIED_LINE/.test(prompt) && // tracked change present
    /UNTRACKED_MARKER/.test(prompt) && // untracked content present
    /untracked\.txt/.test(prompt);
  record(
    '--diff=unstaged: untracked files included in the diff',
    ok,
    `status=${r.status} hasTracked=${/MODIFIED_LINE/.test(prompt)} hasUntracked=${/UNTRACKED_MARKER/.test(prompt)}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Secret-file (.env) scrubbing ─────────────────────────────────────────
// review.js must never embed real .env contents into an engine prompt. Helper
// to spin up a throwaway git repo for the diff-based cases.
function newRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'so-env-'));
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  return { repo, git };
}
const SECRET = 'SECRET_ENV_VALUE_DO_NOT_LEAK=hunter2';
const EXAMPLE = 'EXAMPLE_ENV_VALUE_OK=placeholder';

// ─── Test 31: --file=.env is refused (exit 1, content never embedded) ─────
{
  const envFile = path.join(TMP, '.env');
  fs.writeFileSync(envFile, SECRET + '\n');
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: [`--file=${envFile}`, 'noop'],
  });
  const ok =
    r.status === 1 &&
    /secret|\.env|--include-secrets/i.test(r.stderr || '') &&
    !r.logContent.includes(SECRET); // never reached the engine
  record(
    '--file=.env: refused (exit 1), content not embedded',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 32: --file=.env --include-secrets embeds it ─────────────────────
{
  const envFile = path.join(TMP, '.env');
  fs.writeFileSync(envFile, SECRET + '\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-include',
    extraArgs: ['--include-secrets', `--file=${envFile}`],
  });
  const prompt = argv.join('\n');
  const ok = r.status === 0 && prompt.includes(SECRET);
  record(
    '--file=.env --include-secrets: embedded',
    ok,
    `status=${r.status} hasSecret=${prompt.includes(SECRET)}`
  );
}

// ─── Test 33: untracked .env scrubbed from --diff=unstaged, .env.example kept
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\nKEEP_TRACKED_MARKER\n');
  fs.writeFileSync(path.join(repo, '.env'), SECRET + '\n'); // untracked secret
  fs.writeFileSync(path.join(repo, '.env.example'), EXAMPLE + '\n'); // safe
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-untracked',
    extraArgs: ['--diff=unstaged'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !prompt.includes(SECRET) && // secret scrubbed
    prompt.includes(EXAMPLE) && // example included
    prompt.includes('KEEP_TRACKED_MARKER') && // tracked change still there
    /\.env/.test(prompt); // skip/redact note mentions it
  record(
    'untracked .env scrubbed from unstaged; .env.example kept',
    ok,
    `status=${r.status} secret=${prompt.includes(SECRET)} example=${prompt.includes(EXAMPLE)}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 34: --include-secrets re-includes the untracked .env ────────────
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\nKEEP\n');
  fs.writeFileSync(path.join(repo, '.env'), SECRET + '\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-untracked-include',
    extraArgs: ['--diff=unstaged', '--include-secrets'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok = r.status === 0 && prompt.includes(SECRET);
  record(
    'untracked .env included under --include-secrets',
    ok,
    `status=${r.status} hasSecret=${prompt.includes(SECRET)}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 35: tracked .env change redacted from the diff ──────────────────
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, '.env'), 'OLD=1\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
  git('add', '.env', 'app.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, '.env'), 'OLD=1\n' + SECRET + '\n'); // tracked change
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\nAPP_CHANGE_MARKER\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-tracked',
    extraArgs: ['--diff=unstaged'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !prompt.includes(SECRET) && // secret hunk redacted
    prompt.includes('APP_CHANGE_MARKER') && // other change preserved
    /redact/i.test(prompt); // redaction note present
  record(
    'tracked .env change redacted from diff (other changes preserved)',
    ok,
    `status=${r.status} secret=${prompt.includes(SECRET)} app=${prompt.includes('APP_CHANGE_MARKER')}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 36: staged NEW .env redacted from --diff=staged ─────────────────
// A newly-added (staged) .env renders as a "new file" diff section; its header
// path must still be matched and redacted. Guards the new-file header variant.
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
  git('add', 'app.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, '.env'), SECRET + '\n'); // brand-new secret
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\nSTAGED_APP_MARKER\n');
  git('add', '.env', 'app.txt');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-staged',
    extraArgs: ['--diff=staged'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !prompt.includes(SECRET) && // new-file .env hunk redacted
    prompt.includes('STAGED_APP_MARKER') && // other staged change preserved
    /redact/i.test(prompt);
  record(
    'staged new .env redacted from --diff=staged (new-file header)',
    ok,
    `status=${r.status} secret=${prompt.includes(SECRET)} app=${prompt.includes('STAGED_APP_MARKER')}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 37: .env under a non-ASCII path (git c-quotes the diff header) ──
// git quotes paths with non-ASCII/special bytes: `diff --git "a/…/.env" "b/…"`.
// The redactor must still match the quoted header, or the secret leaks.
{
  const { repo, git } = newRepo();
  const dir = path.join(repo, 'サンプル'); // non-ASCII → forces git c-quoting
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'OLD=1\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, '.env'), 'OLD=1\n' + SECRET + '\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\nQUOTED_APP_MARKER\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-quoted',
    extraArgs: ['--diff=unstaged'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !prompt.includes(SECRET) && // quoted-path .env redacted
    prompt.includes('QUOTED_APP_MARKER'); // other change preserved
  record(
    'quoted (non-ASCII) .env path redacted from diff',
    ok,
    `status=${r.status} secret=${prompt.includes(SECRET)}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 38: --no-embed --diff excludes env files via git pathspec ───────
// In --no-embed mode the engine runs `git diff` itself, so review.js can't
// redact the output. It instead appends exclude pathspecs to the suggested
// command so the engine never fetches env files in the first place.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'noembed-exclude',
    extraArgs: ['--no-embed', '--diff=unstaged'],
  });
  const prompt = argv.join('\n');
  const ok = r.status === 0 && /exclude/.test(prompt) && /\.env/.test(prompt);
  record(
    '--no-embed --diff: env-file exclude pathspecs in suggested command',
    ok,
    `status=${r.status} hasExclude=${/exclude/.test(prompt)}`
  );
}

// ─── Test 39: malformed open marker (>>) still detected → exit 0 ──────────
// A real engine (cmd) emitted `<<<SECOND_OPINION_START>>` (two '>'). review.js
// must treat that as a usable envelope, not a no-output failure (exit 3).
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'malformed-marker' },
    args: ['noop'],
  });
  const ok = r.status === 0 && /usable review body/.test(r.logContent);
  record(
    'malformed open marker (>>) detected → exit 0',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 160)}`
  );
}

// ─── Test 40: embed mode appends a "self-contained, don't explore" directive
// Stops agentic engines (opencode) from ignoring the embedded content and
// globbing the filesystem instead.
{
  const f = path.join(TMP, 'embed-directive.txt');
  fs.writeFileSync(f, 'hello\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'embed-directive',
    extraArgs: [`--file=${f}`],
  });
  const prompt = argv.join('\n');
  const ok = r.status === 0 && /do not read files/i.test(prompt);
  record(
    'embed mode: self-contained directive present',
    ok,
    `status=${r.status} hasDirective=${/do not read files/i.test(prompt)}`
  );
}

// ─── Test 41: --no-embed must NOT add the "don't read files" directive ────
// In --no-embed the engine is explicitly told to fetch the file itself, so the
// contradictory directive must be absent.
{
  const f = path.join(TMP, 'noembed-directive.txt');
  fs.writeFileSync(f, 'hello\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'noembed-directive',
    extraArgs: ['--no-embed', `--file=${f}`],
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !/do not read files/i.test(prompt) &&
    /Read the file/i.test(prompt);
  record(
    '--no-embed: no self-contained directive (engine must read)',
    ok,
    `status=${r.status} prompt=${prompt.slice(0, 120)}`
  );
}

// ─── Test 42: OUTPUT FORMAT carries no decoy answer-body placeholder ──────
// The old instruction printed `...your complete answer here...` between
// standalone markers, which a first-match extractor would grab. It must be gone.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'no-decoy',
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !/your complete answer here/i.test(prompt) &&
    /SECOND_OPINION_START/.test(prompt); // markers still described
  record(
    'OUTPUT FORMAT: no decoy answer-body placeholder',
    ok,
    `status=${r.status} hasDecoy=${/your complete answer here/i.test(prompt)}`
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
