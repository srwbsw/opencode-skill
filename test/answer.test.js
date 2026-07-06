#!/usr/bin/env node
/**
 * Integration test for bin/review.js "answer extraction":
 *
 *   1. When a log file is in use (auto-log or --log=<path>) and --no-wrap was
 *      NOT passed, review.js extracts the LAST complete
 *      <<<SECOND_OPINION_START>>> … <<<SECOND_OPINION_END>>> pair with a
 *      NON-EMPTY trimmed payload (tolerant marker matching:
 *      /<{2,}\s*SECOND_OPINION_START\s*>{2,}/ and the equivalent END regex)
 *      and writes the trimmed payload to <logPath>.answer.md, printing
 *      `ANSWER FILE: <path>` on stdout. A run that yields no answer removes
 *      any stale .answer.md left on a reused --log path.
 *   2. --print-answer also echoes the payload to stdout, AFTER the
 *      `ANSWER FILE:` line and BEFORE the final SECOND_OPINION_RESULT line.
 *   3. The LAST line of stdout is always a single-line JSON blob:
 *      `SECOND_OPINION_RESULT: {...}` — single engine keys: engine, model,
 *      exit, log, answer, timeout. Fusion mode: {"fusion":true,"slots":[...]}
 *      with the same per-slot keys. Written synchronously so it survives
 *      process.exit() even behind a multi-MB payload echo, and also emitted
 *      on launch-failure paths (missing engine binary → exit 127).
 *
 * Uses test/fixtures/codex (a node-based fake) as the engine binary, exposed
 * via PATH=fixtures:$PATH, same as test/spawn.test.js.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REVIEW = path.join(__dirname, '..', 'bin', 'review.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'so-answer-test-'));

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

// Same pattern as test/spawn.test.js's runReview: spawn review.js against the
// fake codex fixture with a known --log=<path> (unless the caller's own args
// override it, e.g. with --log=-). Returns spawnSync's result plus the
// resolved log path and (best-effort) log content. `maxBuffer` overrides
// spawnSync's 1MB default for the large-payload test.
function runReview({
  env = {},
  args = [],
  logPath,
  timeoutMs = 30_000,
  maxBuffer,
}) {
  const finalLog =
    logPath || path.join(TMP, `log-${Date.now()}-${Math.random()}.log`);
  const finalEnv = {
    ...process.env,
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
    {
      encoding: 'utf8',
      env: finalEnv,
      timeout: timeoutMs,
      ...(maxBuffer ? { maxBuffer } : {}),
    }
  );
  r.logPath = finalLog;
  r.logContent = '';
  try {
    r.logContent = fs.readFileSync(finalLog, 'utf8');
  } catch {
    /* may not exist on failure paths, or when --log=- disables logging */
  }
  return r;
}

// Run a 2-slot codex fusion (same engine, two models → two slots) with the
// `ok` fake behavior, mirroring runFusionProbe in test/spawn.test.js but
// without the probe timing machinery — we only care about the parent's
// SECOND_OPINION_RESULT line and each slot's on-disk answer file.
function runFusionOk({ env = {}, timeoutMs = 30_000 } = {}) {
  return spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex:m1',
      '--engine=codex:m2',
      '--cwd=' + process.cwd(),
      '--heartbeat=0',
      'noop',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_BEHAVIOR: 'ok',
        ...env,
      },
      timeout: timeoutMs,
    }
  );
}

function readMaybe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// The LAST non-empty line of stdout, which the spec requires to always be
// `SECOND_OPINION_RESULT: {...}`.
function lastLine(text) {
  const lines = (text || '').split('\n').filter((l) => l.length > 0);
  return lines.length ? lines[lines.length - 1] : '';
}

// Parse the trailing `SECOND_OPINION_RESULT: {...}` line, if present. Returns
// null if the line is missing or not valid JSON.
function parseResultLine(stdout) {
  const line = lastLine(stdout);
  const m = /^SECOND_OPINION_RESULT: (.+)$/.exec(line);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ─── Test 1: ok fixture → ANSWER FILE + .answer.md + result JSON ──────────
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'ok' }, args: ['noop'] });
  const answerPath = `${r.logPath}.answer.md`;
  const answerContent = readMaybe(answerPath);
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 0 &&
    (r.stdout || '').includes(`ANSWER FILE: ${answerPath}`) &&
    answerContent !== null &&
    answerContent.trim() === '[fake-codex ok] review complete' &&
    result !== null &&
    result.answer === answerPath &&
    result.exit === 0;
  record(
    'ok fixture: ANSWER FILE line + .answer.md + result JSON',
    ok,
    `status=${r.status} answerPath=${answerPath} answerContent=${JSON.stringify(answerContent)} result=${JSON.stringify(result)} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 2: double-echoed envelope → answer file keeps the LAST payload ──
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'double' }, args: ['noop'] });
  const answerPath = `${r.logPath}.answer.md`;
  const answerContent = readMaybe(answerPath);
  const ok =
    r.status === 0 &&
    answerContent !== null &&
    answerContent.includes('SECOND_PAYLOAD_MARKER') &&
    !answerContent.includes('FIRST_PAYLOAD_MARKER');
  record(
    'double envelope: answer file keeps LAST payload, not first',
    ok,
    `status=${r.status} answerContent=${JSON.stringify(answerContent)}`
  );
}

// ─── Test 3: malformed markers (2 angle brackets, both ends) → extraction ──
// still succeeds via the tolerant regex on BOTH the open and close markers.
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'malformed' }, args: ['noop'] });
  const answerPath = `${r.logPath}.answer.md`;
  const answerContent = readMaybe(answerPath);
  const ok =
    r.status === 0 &&
    answerContent !== null &&
    answerContent.includes('TOLERANT_PAYLOAD_MARKER');
  record(
    'malformed markers (2 brackets, both ends): extraction still succeeds',
    ok,
    `status=${r.status} answerContent=${JSON.stringify(answerContent)}`
  );
}

// ─── Test 4: noenvelope fixture → exit 3, no .answer.md, result JSON null ──
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'noenvelope' },
    args: ['noop'],
  });
  const answerPath = `${r.logPath}.answer.md`;
  const answerExists = fs.existsSync(answerPath);
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 3 &&
    !answerExists &&
    result !== null &&
    result.answer === null &&
    result.exit === 3;
  record(
    'noenvelope: exit 3, no .answer.md, result JSON answer=null exit=3',
    ok,
    `status=${r.status} answerExists=${answerExists} result=${JSON.stringify(result)} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 5: empty fixture → exit 3, no .answer.md, result JSON null ──────
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'empty' }, args: ['noop'] });
  const answerPath = `${r.logPath}.answer.md`;
  const answerExists = fs.existsSync(answerPath);
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 3 &&
    !answerExists &&
    result !== null &&
    result.answer === null &&
    result.exit === 3;
  record(
    'empty: exit 3, no .answer.md, result JSON answer=null exit=3',
    ok,
    `status=${r.status} answerExists=${answerExists} result=${JSON.stringify(result)} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 6: --no-wrap with ok fixture → no ANSWER FILE, answer=null ──────
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: ['--no-wrap', 'noop'],
  });
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 0 &&
    !/ANSWER FILE:/.test(r.stdout || '') &&
    result !== null &&
    result.answer === null;
  record(
    '--no-wrap: no ANSWER FILE line, result JSON answer=null',
    ok,
    `status=${r.status} result=${JSON.stringify(result)} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 7: --print-answer echoes the payload AFTER the ANSWER FILE line ──
// and before the final result line. The suppressed-mode engine-output tail
// already flushes the payload text to stdout BEFORE the ANSWER FILE line even
// without the flag, so "payload appears somewhere before the result line" is
// vacuously true — the discriminating assertion is a payload occurrence AFTER
// the ANSWER FILE line. A control run without the flag pins that: if the tail
// alone ever satisfied the predicate, the control would fail this test.
{
  const control = runReview({ env: { FAKE_BEHAVIOR: 'ok' }, args: ['noop'] });
  const controlStdout = control.stdout || '';
  const controlAnswerIdx = controlStdout.indexOf('ANSWER FILE:');
  const controlEchoed =
    controlAnswerIdx >= 0 &&
    controlStdout.indexOf(
      '[fake-codex ok] review complete',
      controlAnswerIdx
    ) >= 0;

  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: ['--print-answer', 'noop'],
  });
  const stdout = r.stdout || '';
  const answerIdx = stdout.indexOf('ANSWER FILE:');
  const payloadIdx =
    answerIdx >= 0
      ? stdout.indexOf('[fake-codex ok] review complete', answerIdx)
      : -1;
  const resultIdx = stdout.indexOf('SECOND_OPINION_RESULT:');
  const last = lastLine(stdout);
  const ok =
    r.status === 0 &&
    !controlEchoed &&
    answerIdx >= 0 &&
    payloadIdx > answerIdx &&
    resultIdx > payloadIdx &&
    /^SECOND_OPINION_RESULT:/.test(last);
  record(
    '--print-answer: payload echoed AFTER the ANSWER FILE line, before the final SECOND_OPINION_RESULT line (control run without flag does not echo)',
    ok,
    `status=${r.status} controlEchoed=${controlEchoed} answerIdx=${answerIdx} payloadIdx=${payloadIdx} resultIdx=${resultIdx} lastLine=${last}`
  );
}

// ─── Test 8: --log=- (stdout-only) → no log file, no .answer.md anywhere ──
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: ['--log=-', 'noop'],
  });
  const noLogFile = !fs.existsSync(r.logPath);
  const noAnswerFile = !fs.existsSync(`${r.logPath}.answer.md`);
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 0 &&
    noLogFile &&
    noAnswerFile &&
    result !== null &&
    result.log === null &&
    result.answer === null;
  record(
    '--log=-: no log file, no .answer.md, result JSON log=null answer=null',
    ok,
    `status=${r.status} noLogFile=${noLogFile} noAnswerFile=${noAnswerFile} result=${JSON.stringify(result)}`
  );
}

// ─── Test 9: fusion (2 engines, ok) → parent result JSON fusion:true ──────
// with 2 slots, each slot exit 0, each answer file on disk holding exactly
// the expected trimmed payload.
{
  const r = runFusionOk();
  const result = parseResultLine(r.stdout);
  const slotsOk =
    result &&
    result.fusion === true &&
    Array.isArray(result.slots) &&
    result.slots.length === 2 &&
    result.slots.every(
      (s) =>
        s &&
        s.exit === 0 &&
        s.answer &&
        readMaybe(s.answer) === '[fake-codex ok] review complete'
    );
  const ok = r.status === 0 && !!slotsOk;
  record(
    'fusion: parent result JSON fusion:true, 2 slots, each exit 0 with the expected answer file content',
    ok,
    `status=${r.status} result=${JSON.stringify(result)} stdoutTail=${(r.stdout || '').slice(-300)}`
  );
}

// ─── Test 10: timeout → exit 124, result JSON timeout:true, answer=null ───
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'hang' },
    args: ['--timeout=1', '--heartbeat=0', 'noop'],
    timeoutMs: 20_000,
  });
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 124 &&
    result !== null &&
    result.timeout === true &&
    result.answer === null;
  record(
    'timeout: exit 124, result JSON timeout=true, answer=null',
    ok,
    `status=${r.status} result=${JSON.stringify(result)} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 11: reused --log path → stale .answer.md removed on no-answer ───
// A previous run's .answer.md must never survive a rerun on the same --log
// path that yields no answer — file existence always reflects THIS run.
{
  const reusedLog = path.join(TMP, 'reused.log');
  const first = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: ['noop'],
    logPath: reusedLog,
  });
  const existedAfterOk = fs.existsSync(`${reusedLog}.answer.md`);
  const second = runReview({
    env: { FAKE_BEHAVIOR: 'noenvelope' },
    args: ['noop'],
    logPath: reusedLog,
  });
  const staleSurvived = fs.existsSync(`${reusedLog}.answer.md`);
  const result = parseResultLine(second.stdout);
  const ok =
    first.status === 0 &&
    existedAfterOk &&
    second.status === 3 &&
    !staleSurvived &&
    result !== null &&
    result.answer === null;
  record(
    'reused --log path: stale .answer.md removed when the rerun yields no answer',
    ok,
    `firstStatus=${first.status} existedAfterOk=${existedAfterOk} secondStatus=${second.status} staleSurvived=${staleSurvived} result=${JSON.stringify(result)}`
  );
}

// ─── Test 12: empty trailing pair → falls back to the last NON-EMPTY pair ──
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'empty-final-pair' },
    args: ['noop'],
  });
  const answerContent = readMaybe(`${r.logPath}.answer.md`);
  const ok =
    r.status === 0 &&
    answerContent !== null &&
    answerContent.includes('REAL_CONTENT_MARKER');
  record(
    'empty final pair: extraction falls back to the last NON-EMPTY pair',
    ok,
    `status=${r.status} answerContent=${JSON.stringify(answerContent)}`
  );
}

// ─── Test 13: payload "0" (falsy string) → still a real answer ─────────────
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'zero-payload' },
    args: ['noop'],
  });
  const answerPath = `${r.logPath}.answer.md`;
  const answerContent = readMaybe(answerPath);
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 0 &&
    answerContent === '0' &&
    result !== null &&
    result.answer === answerPath &&
    result.exit === 0;
  record(
    'falsy payload "0": extracted and written verbatim, not dropped by truthiness',
    ok,
    `status=${r.status} answerContent=${JSON.stringify(answerContent)} result=${JSON.stringify(result)}`
  );
}

// ─── Test 14: >1MB --print-answer echo → result line survives the pipe ────
// spawnSync gives review.js a pipe for stdout (same as `| cat`). If review.js
// emitted the payload echo / result line via async process.stdout.write, the
// process.exit() at the end would discard whatever is still queued — the echo
// truncates and the SECOND_OPINION_RESULT line vanishes. Pin the sync-write
// behavior: full marker arrives AND the result line is still the last line.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'big 2' },
    args: ['--print-answer', '--heartbeat=0', 'noop'],
    timeoutMs: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout || '';
  const result = parseResultLine(stdout);
  const ok =
    r.status === 0 &&
    stdout.length > 1_000_000 &&
    stdout.includes('BIG_PAYLOAD_END_MARKER') &&
    result !== null &&
    result.exit === 0 &&
    result.answer === `${r.logPath}.answer.md`;
  record(
    'large payload (>1MB) --print-answer: full echo delivered, SECOND_OPINION_RESULT still the last stdout line',
    ok,
    `status=${r.status} stdoutBytes=${stdout.length} hasMarker=${stdout.includes('BIG_PAYLOAD_END_MARKER')} lastLine=${lastLine(stdout).slice(0, 160)}`
  );
}

// ─── Test 15: missing engine binary → exit 127 still emits the result line ──
// PATH deliberately EXCLUDES the fixtures dir (and any real codex install):
// preflight fails before any log file exists. Launch failures must still end
// with a parseable SECOND_OPINION_RESULT line.
{
  const missingLog = path.join(TMP, 'missing-binary.log');
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      '--cwd=' + process.cwd(),
      `--log=${missingLog}`,
      'noop',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      timeout: 30_000,
    }
  );
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 127 &&
    result !== null &&
    result.exit === 127 &&
    result.answer === null &&
    result.timeout === false;
  record(
    'missing engine binary: exit 127 still emits a parseable SECOND_OPINION_RESULT line',
    ok,
    `status=${r.status} result=${JSON.stringify(result)} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 16: stray leading START → answer is exactly the clean payload ───
// An engine that echoes a bare START marker mid-reasoning (no matching END)
// before emitting the real pair must NOT have the stray marker swallow the
// real START: backward pairing binds the END to the LAST START before it, so
// the answer is the clean payload with no reasoning text or embedded marker.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'stray-start' },
    args: ['noop'],
  });
  const answerContent = readMaybe(`${r.logPath}.answer.md`);
  const ok = r.status === 0 && answerContent === 'REAL_CLEAN_PAYLOAD';
  record(
    'stray leading START: answer is exactly the clean payload of the real pair',
    ok,
    `status=${r.status} answerContent=${JSON.stringify(answerContent)}`
  );
}

// ─── Test 17: echoed instructions with INLINE markers after the real pair ──
// The wrap instruction names both markers inline in one sentence. An engine
// that parrots it AFTER its real answer must not have that inline "pair" win
// the backward walk (its payload would be the word "and"): markers only count
// alone on their own line, so the answer stays the real payload.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'echo-instructions' },
    args: ['noop'],
  });
  const answerContent = readMaybe(`${r.logPath}.answer.md`);
  const ok =
    r.status === 0 &&
    answerContent === '[fake-codex echo-instructions] REAL_ANSWER_MARKER';
  record(
    'echoed instructions with inline markers: real own-line pair wins, not the inline fragment',
    ok,
    `status=${r.status} answerContent=${JSON.stringify(answerContent)}`
  );
}

// ─── Test 18: ONLY inline instruction markers → exit 3, no answer file ────
// The loose streaming presence check sees the marker text, but there is no
// own-line pair to extract — the quality verdict (log file in use) keys on
// extraction success, so this is "no usable output": exit 3, answer:null.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'inline-only' },
    args: ['noop'],
  });
  const answerExists = fs.existsSync(`${r.logPath}.answer.md`);
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 3 &&
    !answerExists &&
    result !== null &&
    result.answer === null &&
    result.exit === 3;
  record(
    'inline-only instruction markers: exit 3, no .answer.md, result JSON answer=null exit=3',
    ok,
    `status=${r.status} answerExists=${answerExists} result=${JSON.stringify(result)} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 19: fusion with one missing engine binary → dead slot log:null ──
// PATH holds only the fixtures dir, node's own bin dir, and the system dirs —
// so the codex slot runs the fixture while the qwen slot dies in preflight
// (exit 127) WITHOUT ever creating its slot log. The parent's result JSON
// must report log:null (and answer:null) for the dead slot instead of a
// planned-but-never-created path; aggregation still surfaces the 127.
{
  const restrictedPath = `${FIXTURES}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex:m1',
      '--engine=qwen',
      '--cwd=' + process.cwd(),
      '--heartbeat=0',
      'noop',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: restrictedPath, FAKE_BEHAVIOR: 'ok' },
      timeout: 30_000,
    }
  );
  const result = parseResultLine(r.stdout);
  const slots = (result && Array.isArray(result.slots) && result.slots) || [];
  const good = slots.find((s) => s && s.engine === 'codex');
  const dead = slots.find((s) => s && s.engine === 'qwen');
  const goodOk =
    good &&
    good.exit === 0 &&
    good.log &&
    fs.existsSync(good.log) &&
    good.answer &&
    fs.existsSync(good.answer);
  const deadOk =
    dead && dead.exit === 127 && dead.log === null && dead.answer === null;
  const ok =
    r.status === 127 &&
    result !== null &&
    result.fusion === true &&
    slots.length === 2 &&
    !!goodOk &&
    !!deadOk;
  record(
    'fusion with missing engine binary: dead slot reports log=null answer=null exit=127, good slot intact, parent exit 127',
    ok,
    `status=${r.status} result=${JSON.stringify(result)}`
  );
}

// ─── Test 20: unwritable --log dir → exit 0, result JSON log:null ─────────
// When the log file cannot be created (here: --log points below a read-only
// directory, so the runner's mkdir fails), the engine output streams to
// stdout instead — a perfectly good run. The quality verdict must fall back
// to the streaming envelope check (NOT punish the missing log with exit 3),
// and the result JSON must report log:null rather than a planned path no
// consumer can Read (same phantom-path rule as the fusion slots).
{
  const roDir = path.join(TMP, 'readonly-dir');
  fs.mkdirSync(roDir, { mode: 0o555 });
  let unwritable = false;
  try {
    fs.accessSync(roDir, fs.constants.W_OK);
  } catch {
    unwritable = true;
  }
  if (!unwritable) {
    // Running as root (or on a filesystem that ignores modes): the scenario
    // cannot be produced here, so skip gracefully rather than fail.
    record(
      'unwritable --log dir: exit 0, result JSON log=null answer=null (SKIPPED: dir writable in this environment)',
      true
    );
  } else {
    const badLog = path.join(roDir, 'nested', 'x.log');
    const r = runReview({
      env: { FAKE_BEHAVIOR: 'ok' },
      args: ['noop'],
      logPath: badLog,
    });
    const result = parseResultLine(r.stdout);
    const ok =
      r.status === 0 &&
      result !== null &&
      result.exit === 0 &&
      result.log === null &&
      result.answer === null &&
      (r.stderr || '').includes('could not open log file');
    record(
      'unwritable --log dir: exit 0, result JSON log=null answer=null, stderr notes the failed log open',
      ok,
      `status=${r.status} result=${JSON.stringify(result)} stderrTail=${(r.stderr || '').slice(-200)}`
    );
  }
  try {
    fs.chmodSync(roDir, 0o755); // restore so the TMP cleanup below succeeds
  } catch {
    /* best-effort */
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
