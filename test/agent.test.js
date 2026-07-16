#!/usr/bin/env node
/**
 * TDD RED-PHASE tests for bin/agent.js (does not exist yet — see
 * skills/AGENTS.md / the second-agent spec). agent.js is review.js's sibling
 * entry point: instead of a read-only review, it instructs an engine to
 * perform an arbitrary task (write tests, refactor, run commands) inside
 * --cwd. It shares bin/lib/{engines,content,envelope,run}.js with review.js.
 *
 * Contract under test (see spec "Phase 2 — bin/agent.js"):
 *   - Refuses to run without --unrestricted (hard gate, exit 1, NO spawn).
 *   - Exactly one engine slot; multiple --engine / CSV → exit 1.
 *   - Engine argv is built via the shared buildEngineCmd() with
 *     unrestricted=true: safety/plan/read-only flags are ALWAYS absent,
 *     functional flags (exec/--print/run, model flags) are present, and the
 *     composed prompt is the last positional CLI argument to the engine.
 *   - The composed prompt carries a delegated-TASK directive (never review.js's
 *     "self-contained, don't explore" directive) plus the structured-output
 *     envelope instruction (unless --no-wrap).
 *   - Change reporting: git status/HEAD snapshot before + after the engine
 *     runs; prints a `CHANGED FILES:` block and folds the same data into the
 *     final `SECOND_AGENT_RESULT` JSON line's `changes` key. Non-git --cwd →
 *     changes: null (no crash).
 *   - Missing envelope but real changes → exit 0 + a `NO REPORT` warning
 *     (changes are the deliverable). Missing envelope AND no changes → the
 *     usual "no usable output" exit 3.
 *   - Same preflight (127), timeout (124), and secret-file guard as review.js.
 *
 * Uses test/fixtures/{codex,claude,opencode} (node-based fakes) as engine
 * binaries, exposed via PATH=fixtures:$PATH, same pattern as
 * test/spawn.test.js. bin/agent.js does not exist yet, so EVERY test here
 * must fail as an assertion diff against expected OUTPUT CONTENT (stderr/
 * stdout substrings, argv-file contents, parsed JSON fields) — never on exit
 * code alone, since `node <missing-file>.js` itself exits 1 with a generic
 * "Cannot find module" message that must not accidentally satisfy any
 * assertion here.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT = path.join(__dirname, '..', 'bin', 'agent.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'so-agent-test-'));

// Distinctive marker used as the raw user prompt in argv-shape tests. Long
// and unique so it can never collide with flag tokens or engine boilerplate.
const PROMPT_MARKER = 'AGENT_TASK_PROMPT_MARKER_9f3';

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

// Low-level: spawn `node bin/agent.js <args>` with PATH shimmed to the fake
// engine fixtures. Callers pass the full args array (including --engine=,
// --cwd=, --unrestricted, etc.) so every test controls its own invocation
// explicitly — mirrors test/spawn.test.js's mix of a thin wrapper plus ad hoc
// spawnSync calls for the less-common shapes.
function spawnAgent(args, { env = {}, timeoutMs = 30_000 } = {}) {
  return spawnSync(process.execPath, [AGENT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${FIXTURES}:${process.env.PATH}`,
      ...env,
    },
    timeout: timeoutMs,
  });
}

// Read an argv-dump file written by a fixture. Same re-split-on-newline
// convention as test/spawn.test.js/test/answer.test.js — see test/AGENTS.md's
// caveat about multi-line prompts spreading across array entries.
function readArgvFile(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
  } catch {
    return []; // absent on failure paths (incl. "agent.js never spawned")
  }
}

// Find and JSON.parse the `SECOND_AGENT_RESULT: {...}` line from stdout.
// Returns null (never throws) when the line is missing or malformed, so
// callers can assert on it directly without a surrounding try/catch.
function parseResultLine(stdout) {
  const m = (stdout || '').match(/^SECOND_AGENT_RESULT: (.+)$/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Run an engine argv-shape probe: --engine=<engineSpec> --cwd=<cwd>
// --unrestricted [...extraArgs] <PROMPT_MARKER>, with FAKE_ARGV_FILE set so
// the fixture dumps what agent.js forwarded. FAKE_BEHAVIOR defaults to 'ok'
// (envelope-wrapped success) so a well-behaved run exits 0.
function runAgentArgv({
  engineSpec,
  probeName,
  extraArgs = [],
  cwd,
  env = {},
}) {
  const argvFile = path.join(TMP, `${probeName}.argv`);
  const args = [
    `--engine=${engineSpec}`,
    '--cwd=' + (cwd || process.cwd()),
    '--unrestricted',
    ...extraArgs,
    PROMPT_MARKER,
  ];
  const r = spawnAgent(args, {
    env: { FAKE_BEHAVIOR: 'ok', FAKE_ARGV_FILE: argvFile, ...env },
  });
  return { r, argv: readArgvFile(argvFile) };
}

// Fresh throwaway git repo with one committed file (so `git rev-parse HEAD`
// always resolves — an empty repo with zero commits has no HEAD). Used by
// the change-reporting / timeout / no-envelope tests.
function newRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'so-agent-repo-'));
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  git('add', 'seed.txt');
  git('commit', '-qm', 'init');
  return { repo, git };
}

// Run agent.js against a repo with the codex fixture under a given
// FAKE_BEHAVIOR (optionally writing a file via FAKE_WRITE_FILE). Used by the
// change-reporting / no-envelope / timeout tests, which all share the same
// "--engine=codex --cwd=<repo> --unrestricted [...extra] <prompt>" shape.
function runAgentInRepo({ repo, behavior, writeFile, extraArgs = [] }) {
  const args = [
    '--engine=codex',
    '--cwd=' + repo,
    '--unrestricted',
    ...extraArgs,
    'DO_TASK',
  ];
  const env = {
    FAKE_BEHAVIOR: behavior,
    ...(writeFile ? { FAKE_WRITE_FILE: writeFile } : {}),
  };
  return spawnAgent(args, { env, timeoutMs: 20_000 });
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

// ─── Test 1: --unrestricted gate — missing flag → exit 1, no spawn ────────
{
  const argvFile = path.join(TMP, 'gate-noflag.argv');
  const r = spawnAgent(
    ['--engine=codex', '--cwd=' + process.cwd(), PROMPT_MARKER],
    { env: { FAKE_BEHAVIOR: 'ok', FAKE_ARGV_FILE: argvFile } }
  );
  const argvCreated = fs.existsSync(argvFile);
  const ok =
    r.status === 1 && /--unrestricted/.test(r.stderr || '') && !argvCreated;
  record(
    'gate: missing --unrestricted → exit 1, stderr mentions it, no spawn',
    ok,
    `status=${r.status} argvCreated=${argvCreated} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 2: multiple --engine flags rejected ──────────────────────────────
{
  const r = spawnAgent([
    '--engine=codex',
    '--engine=claude',
    '--cwd=' + process.cwd(),
    '--unrestricted',
    PROMPT_MARKER,
  ]);
  const ok = r.status === 1 && /one engine/i.test(r.stderr || '');
  record(
    'gate: multiple --engine flags → exit 1 ("one engine per task")',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 3: CSV --engine list rejected ────────────────────────────────────
{
  const r = spawnAgent([
    '--engine=codex,claude',
    '--cwd=' + process.cwd(),
    '--unrestricted',
    PROMPT_MARKER,
  ]);
  const ok = r.status === 1 && /one engine/i.test(r.stderr || '');
  record(
    'gate: CSV --engine list → exit 1 ("one engine per task")',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 4: codex argv shape — safety absent, functional+model+prompt ────
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'codex:codex-test-model',
    probeName: 'argv-codex',
  });
  const execIdx = argv.indexOf('exec');
  const skipIdx = argv.indexOf('--skip-git-repo-check');
  const modelFlagIdx = argv.indexOf('-m');
  const promptIdx = argv.indexOf(PROMPT_MARKER);
  const ok =
    r.status === 0 &&
    execIdx >= 0 &&
    !argv.includes('-s') &&
    !argv.includes('read-only') &&
    skipIdx > execIdx &&
    modelFlagIdx > skipIdx &&
    argv[modelFlagIdx + 1] === 'codex-test-model' &&
    promptIdx > modelFlagIdx;
  record(
    'codex argv: safety flags absent, exec/--skip-git-repo-check/-m/prompt present in order',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 5: claude argv shape — safety absent, functional+model+prompt ───
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'claude:claude-test-model',
    probeName: 'argv-claude',
  });
  const printIdx = argv.indexOf('--print');
  const modelFlagIdx = argv.indexOf('--model');
  const promptIdx = argv.indexOf(PROMPT_MARKER);
  const ok =
    r.status === 0 &&
    printIdx >= 0 &&
    !argv.includes('--permission-mode') &&
    !argv.includes('plan') &&
    modelFlagIdx > printIdx &&
    argv[modelFlagIdx + 1] === 'claude-test-model' &&
    promptIdx > modelFlagIdx;
  record(
    'claude argv: safety flags absent, --print/--model/prompt present in order',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 6: opencode argv shape — safety absent, functional+model+prompt ─
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'opencode:testprov/testmodel',
    probeName: 'argv-opencode',
  });
  const runIdx = argv.indexOf('run');
  const dirIdx = argv.indexOf('--dir');
  const modelFlagIdx = argv.indexOf('--model');
  const promptIdx = argv.indexOf(PROMPT_MARKER);
  const ok =
    r.status === 0 &&
    runIdx >= 0 &&
    dirIdx > runIdx &&
    argv[dirIdx + 1] === process.cwd() &&
    !argv.includes('--agent') &&
    !argv.includes('plan') &&
    modelFlagIdx > dirIdx &&
    argv[modelFlagIdx + 1] === 'testprov/testmodel' &&
    promptIdx > modelFlagIdx;
  record(
    'opencode argv: safety flags absent, run/--dir/--model/prompt present in order',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 7: task directive present (mentions the delegated task + cwd) ───
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'codex',
    probeName: 'directive-task',
  });
  const joined = argv.join('\n');
  const ok =
    r.status === 0 &&
    /delegated engineering task/i.test(joined) &&
    joined.includes(process.cwd());
  record(
    'task directive: present in prompt (mentions delegated task + cwd)',
    ok,
    `status=${r.status} hasDirective=${/delegated engineering task/i.test(joined)}`
  );
}

// ─── Test 8: review's self-contained/"don't explore" directive is absent ──
// review.js's embed-mode directive tells the engine NOT to explore the repo
// ("do not read files, glob, run shell commands..." — see spawn.test.js Test
// 40). agent.js's whole point is to let the engine explore/modify/run
// commands, so this phrase must never appear in its prompt.
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'codex',
    probeName: 'directive-no-selfcontained',
  });
  const joined = argv.join('\n');
  const ok =
    r.status === 0 &&
    !/do not read files/i.test(joined) &&
    argv.includes('exec');
  record(
    "review's self-contained directive: absent from agent.js prompt",
    ok,
    `status=${r.status} hasReviewDirective=${/do not read files/i.test(joined)}`
  );
}

// ─── Test 9: envelope instruction present by default ───────────────────────
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'codex',
    probeName: 'envelope-present',
  });
  const joined = argv.join('\n');
  const ok =
    r.status === 0 &&
    /OUTPUT FORMAT/.test(joined) &&
    /SECOND_OPINION_START/.test(joined);
  record(
    'envelope instruction: present by default',
    ok,
    `status=${r.status} hasOutputFormat=${/OUTPUT FORMAT/.test(joined)}`
  );
}

// ─── Test 10: --no-wrap omits the envelope instruction ─────────────────────
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'codex',
    probeName: 'envelope-nowrap',
    extraArgs: ['--no-wrap'],
  });
  const joined = argv.join('\n');
  const ok =
    r.status === 0 &&
    argv.includes('exec') &&
    !/OUTPUT FORMAT/.test(joined) &&
    !/SECOND_OPINION_START/.test(joined);
  record(
    '--no-wrap: envelope instruction absent',
    ok,
    `status=${r.status} hasOutputFormat=${/OUTPUT FORMAT/.test(joined)}`
  );
}

// ─── Test 11: change reporting — written file shows up in CHANGED FILES ───
// and in the SECOND_AGENT_RESULT JSON's changes.files, with state 'added'
// (git status --porcelain reports it as a new untracked path: "?? <path>").
{
  const { repo } = newRepo();
  const r = runAgentInRepo({
    repo,
    behavior: 'write-file',
    writeFile: 'agent-output.txt',
  });
  const result = parseResultLine(r.stdout);
  const entry =
    result && result.changes && Array.isArray(result.changes.files)
      ? result.changes.files.find((f) => f.path === 'agent-output.txt')
      : null;
  const ok =
    r.status === 0 &&
    /CHANGED FILES:/.test(r.stdout || '') &&
    /agent-output\.txt/.test(r.stdout || '') &&
    !!entry &&
    entry.state === 'added';
  record(
    'change reporting: engine-written file appears in CHANGED FILES + result JSON (state=added)',
    ok,
    `status=${r.status} entry=${JSON.stringify(entry)} stdoutTail=${(r.stdout || '').slice(-300)}`
  );
  rmrf(repo);
}

// ─── Test 12: change reporting — nothing written → "(none)" + empty array ─
{
  const { repo } = newRepo();
  const r = runAgentInRepo({ repo, behavior: 'ok' });
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 0 &&
    /CHANGED FILES:\s*\(none\)/.test(r.stdout || '') &&
    !!result &&
    !!result.changes &&
    Array.isArray(result.changes.files) &&
    result.changes.files.length === 0 &&
    typeof result.changes.headBefore === 'string' &&
    result.changes.headBefore.length > 0 &&
    result.changes.headBefore === result.changes.headAfter;
  record(
    'change reporting: no changes → CHANGED FILES "(none)" + empty files array',
    ok,
    `status=${r.status} changes=${JSON.stringify(result && result.changes)} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
  rmrf(repo);
}

// ─── Test 13: no-envelope + changes → exit 0 + "NO REPORT" warning ─────────
{
  const { repo } = newRepo();
  const r = runAgentInRepo({
    repo,
    behavior: 'write-file-noenvelope',
    writeFile: 'noenv-output.txt',
  });
  const combined = (r.stdout || '') + (r.stderr || '');
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 0 &&
    /NO REPORT/.test(combined) &&
    /no envelope/i.test(combined) &&
    !!result &&
    result.exit === 0 &&
    !!result.changes &&
    Array.isArray(result.changes.files) &&
    result.changes.files.length >= 1;
  record(
    'no-envelope + changes → exit 0 + NO REPORT warning',
    ok,
    `status=${r.status} combinedTail=${combined.slice(-300)}`
  );
  rmrf(repo);
}

// ─── Test 14: no-envelope + no changes → exit 3 ────────────────────────────
{
  const { repo } = newRepo();
  const r = runAgentInRepo({ repo, behavior: 'noenvelope' });
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 3 &&
    !!result &&
    result.exit === 3 &&
    !!result.changes &&
    Array.isArray(result.changes.files) &&
    result.changes.files.length === 0;
  record(
    'no-envelope + no changes → exit 3',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)} result=${JSON.stringify(result)}`
  );
  rmrf(repo);
}

// ─── Test 15: timeout → exit 124 ───────────────────────────────────────────
{
  const { repo } = newRepo();
  const r = runAgentInRepo({
    repo,
    behavior: 'hang',
    extraArgs: ['--timeout=2', '--heartbeat=0'],
  });
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 124 &&
    !!result &&
    result.exit === 124 &&
    result.timeout === true;
  record(
    'timeout: hung engine killed with exit 124',
    ok,
    `status=${r.status} result=${JSON.stringify(result)}`
  );
  rmrf(repo);
}

// ─── Test 16: missing binary → exit 127 ────────────────────────────────────
{
  const r = spawnSync(
    process.execPath,
    [
      AGENT,
      '--engine=codex',
      '--cwd=' + process.cwd(),
      '--unrestricted',
      'noop',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      timeout: 10_000,
    }
  );
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 127 &&
    /not found on PATH/i.test(r.stderr || '') &&
    !!result &&
    result.exit === 127;
  record(
    'preflight missing binary → exit 127',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 17: --file=.env refused pre-spawn (exit 1, no engine invocation) ─
{
  const SECRET = 'SECRET_ENV_VALUE_DO_NOT_LEAK=hunter2';
  const envFile = path.join(TMP, '.env');
  fs.writeFileSync(envFile, SECRET + '\n');
  const argvFile = path.join(TMP, 'env-refuse.argv');
  const r = spawnAgent(
    [
      '--engine=codex',
      '--cwd=' + process.cwd(),
      '--unrestricted',
      `--file=${envFile}`,
      PROMPT_MARKER,
    ],
    { env: { FAKE_BEHAVIOR: 'ok', FAKE_ARGV_FILE: argvFile } }
  );
  const argvCreated = fs.existsSync(argvFile);
  const ok =
    r.status === 1 &&
    /secret|\.env|--include-secrets/i.test(r.stderr || '') &&
    !argvCreated;
  record(
    '--file=.env: refused pre-spawn (exit 1), engine never invoked',
    ok,
    `status=${r.status} argvCreated=${argvCreated} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 18: empty prompt → exit 1 ────────────────────────────────────────
{
  const r = spawnAgent([
    '--engine=codex',
    '--cwd=' + process.cwd(),
    '--unrestricted',
  ]);
  const ok = r.status === 1 && /prompt/i.test(r.stderr || '');
  record(
    'empty prompt: exit 1',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 19: quotes/newlines in the prompt round-trip via FAKE_ARGV_FILE ──
{
  const argvFile = path.join(TMP, 'quotes.argv');
  const prompt =
    'He said "hello"\nSecond line with \'quotes\' and $pecial chars';
  const r = spawnAgent(
    ['--engine=codex', '--cwd=' + process.cwd(), '--unrestricted', prompt],
    { env: { FAKE_BEHAVIOR: 'ok', FAKE_ARGV_FILE: argvFile } }
  );
  const joined = readArgvFile(argvFile).join('\n');
  const ok =
    r.status === 0 &&
    joined.includes('He said "hello"') &&
    joined.includes("Second line with 'quotes' and $pecial chars");
  record(
    'prompt round-trip: quotes/newlines preserved in engine argv',
    ok,
    `status=${r.status} joinedHas=${joined.includes('He said')}`
  );
}

// ─── Test 20: non-git cwd → changes: null (no crash) ───────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-agent-nogit-'));
  const r = spawnAgent(
    ['--engine=codex', '--cwd=' + dir, '--unrestricted', 'noop'],
    { env: { FAKE_BEHAVIOR: 'ok' } }
  );
  const result = parseResultLine(r.stdout);
  const ok = r.status === 0 && !!result && result.changes === null;
  record(
    'non-git cwd: changes is null (no crash)',
    ok,
    `status=${r.status} changes=${JSON.stringify(result && result.changes)}`
  );
  rmrf(dir);
}

// ─── Test 21: source contains the --unrestricted gate (safety.test.js-style)
// Lightweight source-grep check, consistent with how test/safety.test.js
// verifies review.js's safety contract by reading the source directly rather
// than spawning it. Guards against a future refactor silently dropping the
// gate check itself (e.g. moving it behind a flag that defaults to true).
{
  let src = '';
  try {
    src = fs.readFileSync(AGENT, 'utf8');
  } catch {
    src = ''; // bin/agent.js does not exist yet — correctly fails below
  }
  const ok = src.length > 0 && /unrestricted/i.test(src);
  record(
    'agent.js source: mentions the --unrestricted gate',
    ok,
    `sourceBytes=${src.length}`
  );
}

// ─── Test 22 (M4): verdict counts HEAD movement, not just dirty-porcelain ──
// An engine that COMMITS its own work leaves porcelain CLEAN (files: []) even
// though real work happened — HEAD moved. Without counting headBefore !==
// headAfter as "real changes", the missing-envelope verdict falls through to
// EXIT_NO_OUTPUT (3) despite the engine having actually done something. This
// must land as exit 0 + the same "NO REPORT" warning the dirty-porcelain case
// gets (the changes — here, the commit — are the deliverable).
{
  const { repo } = newRepo();
  const r = runAgentInRepo({ repo, behavior: 'commit-noenvelope' });
  const combined = (r.stdout || '') + (r.stderr || '');
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 0 &&
    /NO REPORT/.test(combined) &&
    !!result &&
    result.exit === 0 &&
    !!result.changes &&
    result.changes.headBefore !== result.changes.headAfter;
  record(
    'HEAD movement counts as changes: engine commits its work → exit 0 + NO REPORT (not exit 3)',
    ok,
    `status=${r.status} combinedTail=${combined.slice(-300)} changes=${JSON.stringify(result && result.changes)}`
  );
  rmrf(repo);
}

// ─── Test 23 (m1): --no-wrap + zero output + zero changes → exit 3 ────────
// review.js's 0-byte check is independent of --no-wrap (see
// spawn.test.js "--no-wrap: empty output still exit 3") — agent.js's --no-wrap
// path must apply the same fallback. Zero bytes of engine output AND zero
// changes on disk is never a usable outcome, wrap or no wrap.
{
  const { repo } = newRepo();
  const r = runAgentInRepo({
    repo,
    behavior: 'empty',
    extraArgs: ['--no-wrap'],
  });
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 3 &&
    !!result &&
    result.exit === 3 &&
    !!result.changes &&
    Array.isArray(result.changes.files) &&
    result.changes.files.length === 0;
  record(
    '--no-wrap: zero output + zero changes → exit 3',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)} result=${JSON.stringify(result)}`
  );
  rmrf(repo);
}

// ─── Test 24 (m1 regression guard): --no-wrap WITH output → stays exit 0 ──
// Non-empty output but no envelope, under --no-wrap, must NOT be flagged —
// only the 0-byte fallback applies on the no-wrap path.
{
  const { repo } = newRepo();
  const r = runAgentInRepo({
    repo,
    behavior: 'noenvelope',
    extraArgs: ['--no-wrap'],
  });
  const ok = r.status === 0;
  record(
    '--no-wrap: non-empty output without envelope still exits 0',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
  rmrf(repo);
}

// ─── Test 25 (M1a): source pins the default timeout to SOS_AGENT_TIMEOUT_SEC
// Source-grep check, consistent with Test 21's style. Pins the env var name
// AND the 1800 default TOGETHER (not two independent regexes) so a future
// refactor can't satisfy this by leaving one half stale — e.g. typo'ing the
// default to 1900 while still reading the right env var, or vice versa.
{
  let src = '';
  try {
    src = fs.readFileSync(AGENT, 'utf8');
  } catch {
    src = '';
  }
  const ok =
    src.length > 0 &&
    /DEFAULT_TIMEOUT_SEC\s*=\s*Number\(process\.env\.SOS_AGENT_TIMEOUT_SEC\)\s*\|\|\s*1800/.test(
      src
    );
  record(
    'agent.js source: default timeout is 1800s, keyed to SOS_AGENT_TIMEOUT_SEC',
    ok,
    `sourceBytes=${src.length}`
  );
}

// ─── Test 26 (M1b): SOS_AGENT_TIMEOUT_SEC env override, no --timeout flag ──
// Sets the timeout via the env var alone (no --timeout=<n>) to prove the env
// override actually reaches DEFAULT_TIMEOUT_SEC, not just that --timeout
// works (already covered by Test 15).
{
  const { repo } = newRepo();
  const r = spawnAgent(
    [
      '--engine=codex',
      '--cwd=' + repo,
      '--unrestricted',
      '--heartbeat=0',
      'DO_TASK',
    ],
    {
      env: { FAKE_BEHAVIOR: 'hang', SOS_AGENT_TIMEOUT_SEC: '1' },
      timeoutMs: 20_000,
    }
  );
  const result = parseResultLine(r.stdout);
  const ok =
    r.status === 124 &&
    !!result &&
    result.exit === 124 &&
    result.timeout === true;
  record(
    'SOS_AGENT_TIMEOUT_SEC=1 (no --timeout flag): hung engine killed, exit 124',
    ok,
    `status=${r.status} result=${JSON.stringify(result)}`
  );
  rmrf(repo);
}

// ─── Test 27 (M2a): classifyStatusCode 'modified' — pre-committed file ─────
// A tracked, already-committed file that the engine overwrites shows up as
// ' M' in `git status --porcelain` (not '??'/'A') — classifyStatusCode must
// map that to 'modified'.
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original content\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'add tracked.txt');
  const r = runAgentInRepo({
    repo,
    behavior: 'write-file',
    writeFile: 'tracked.txt',
  });
  const result = parseResultLine(r.stdout);
  const entry =
    result && result.changes && Array.isArray(result.changes.files)
      ? result.changes.files.find((f) => f.path === 'tracked.txt')
      : null;
  const ok = r.status === 0 && !!entry && entry.state === 'modified';
  record(
    "classifyStatusCode: pre-committed tracked file overwritten -> state 'modified'",
    ok,
    `status=${r.status} entry=${JSON.stringify(entry)}`
  );
  rmrf(repo);
}

// ─── Test 28 (M2b): classifyStatusCode 'deleted' — tracked file removed ───
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'to-delete.txt'), 'will be deleted\n');
  git('add', 'to-delete.txt');
  git('commit', '-qm', 'add to-delete.txt');
  const r = runAgentInRepo({
    repo,
    behavior: 'delete-file',
    writeFile: 'to-delete.txt',
  });
  const result = parseResultLine(r.stdout);
  const entry =
    result && result.changes && Array.isArray(result.changes.files)
      ? result.changes.files.find((f) => f.path === 'to-delete.txt')
      : null;
  const ok = r.status === 0 && !!entry && entry.state === 'deleted';
  record(
    "classifyStatusCode: tracked file deleted -> state 'deleted'",
    ok,
    `status=${r.status} entry=${JSON.stringify(entry)}`
  );
  rmrf(repo);
}

// ─── Test 29 (M3a): --engine-arg=<val> passthrough, positioned before prompt
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'codex',
    probeName: 'engine-arg-flag',
    extraArgs: ['--engine-arg=--foo'],
  });
  const fooIdx = argv.indexOf('--foo');
  const promptIdx = argv.indexOf(PROMPT_MARKER);
  const ok =
    r.status === 0 &&
    fooIdx >= 0 &&
    promptIdx > fooIdx &&
    argv.includes('exec');
  record(
    '--engine-arg=--foo: forwarded to engine argv, before the prompt',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 30 (M3b): `-- --bar` passthrough, positioned before prompt ──────
// Unlike --engine-arg=, a bare `--` swallows every remaining CLI token into
// extraEngineArgs (agent.js's parse loop does `extraEngineArgs =
// argv.slice(i + 1); break;` on `--`) — so the prompt must be given BEFORE
// `--`, matching the usage string's `"<task prompt>" [... | -- <engine-args
// ...>]` ordering. Confirms the known semantic: the composed prompt always
// stays the LAST positional the engine CLI receives, even when extra args
// are passed via `--` instead of --engine-arg=.
{
  const argvFile = path.join(TMP, 'engine-arg-dashdash.argv');
  const r = spawnAgent(
    [
      '--engine=codex',
      '--cwd=' + process.cwd(),
      '--unrestricted',
      PROMPT_MARKER,
      '--',
      '--bar',
    ],
    { env: { FAKE_BEHAVIOR: 'ok', FAKE_ARGV_FILE: argvFile } }
  );
  const argv = readArgvFile(argvFile);
  const barIdx = argv.indexOf('--bar');
  const promptIdx = argv.indexOf(PROMPT_MARKER);
  const ok =
    r.status === 0 &&
    barIdx >= 0 &&
    promptIdx > barIdx &&
    argv.includes('exec');
  record(
    "'-- --bar': forwarded to engine argv, before the prompt",
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 31 (m4): --engine=cursor resolves to the `agent` binary ─────────
// If the alias were dropped, 'cursor' would fail SUPPORTED_ENGINES.includes()
// and exit 1 before ever spawning — the fixture's argv file would never be
// created. A non-empty argv file, with the `agent` fixture's functional
// flags present, proves the alias resolved to the `agent` binary.
{
  const { r, argv } = runAgentArgv({
    engineSpec: 'cursor',
    probeName: 'cursor-alias',
  });
  const ok =
    r.status === 0 &&
    argv.length > 0 &&
    argv.includes('--print') &&
    argv.includes('--trust');
  record(
    '--engine=cursor: alias resolves to the `agent` binary',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Cleanup ────────────────────────────────────────────────────────────────
rmrf(TMP);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
