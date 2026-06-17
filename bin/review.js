#!/usr/bin/env node
// second-opinion-skill review runner
// Usage: review.js --engine=<engine> [--model=<model>] --cwd=<path>
//                  [--diff=<spec> | --file=<path>] "<prompt>"
//                  [--engine-arg=<arg> ... | -- <engine-args...>]
// Engines: opencode, gemini, codex, claude, copilot, qwen, kilo, agy, cmd,
//          agent (Cursor CLI; aliases: cursor, cursor-agent)
//
// --diff=<spec> shortcuts (review.js runs git in --cwd):
//   unstaged     → git diff + untracked files (new files git diff omits)
//   staged       → git diff --staged
//   last-commit  → git diff HEAD~1
//   branch       → git diff <auto-detected default>..HEAD
//                  (fallback: HEAD~1..HEAD)
//   <custom>     → git diff <custom>        (e.g. "HEAD~3..HEAD")
//
// --file=<path>  Read file content from disk. Repeatable — every --file= is
//                embedded as its own <file> block.
//
// Diff/file content is embedded directly in the prompt as a <diff> or <file>
// block. No temp files written, no model-side file reads, no sandbox carve-outs.
// Engines without shell access (gemini, qwen) and sandboxed engines (codex,
// opencode) all get the same deterministic inline content.
//
// Secret-file guard (system-level, on by default): review.js never embeds
// .env-style secret files (.env / .env.* / *.env, except *example* etc). It
// refuses --file=.env, skips untracked .env files, and redacts .env hunks from
// diffs (including git's c-quoted headers for non-ASCII paths). In --no-embed
// mode it appends git exclude pathspecs so the engine's own `git diff` omits
// them too. A prompt-level reminder is the final layer for sandbox tree walks.
// Override the whole guard with --include-secrets.
//
// Exit codes: 0 = success, 124 = timeout (GNU `timeout` convention),
// 3 = clean exit but NO usable output (zero bytes, or — when wrapped — output
// missing the <<<SECOND_OPINION_START>>> envelope), otherwise the engine's own
// non-zero code.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellQuote } = require('./shell-quote');
const { isLikelyEnvSecret } = require('./env-guard');

let engine = ''; // resolved single-engine name (post-validation)
let model = ''; // resolved single-engine model (post-validation)
const rawEngineSpecs = []; // every --engine= occurrence, comma-split: each item is 'name' or 'name:model'
let cwd = process.cwd();
let diffSpec = '';
const filePaths = []; // every --file= occurrence; multiple files are all embedded
let prompt = '';
let extraEngineArgs = [];
let showHelp = false;
let logArg = null; // null = unset, '' = auto-disabled with --log=-, string = explicit path
let timeoutArg = null; // null = use default, number = seconds, 0 = no timeout
let heartbeatArg = null; // null = use default, number = seconds, 0 = disabled
let concurrencyArg = null; // null = unbounded (fusion only); >=1 = max parallel slots
let unrestricted = false; // when true, drop the per-engine sandbox/plan/read-only flags
let noEmbed = false; // when true, do not inline diff/file content; instruct engine to fetch itself
let noWrap = false; // when true, do not append the structured-output sentinel envelope
let includeSecrets = false; // when true, DON'T scrub .env-style secret files from embedded content

// Defaults. Override via --timeout / --heartbeat or env vars (for harness tuning).
const DEFAULT_TIMEOUT_SEC = Number(process.env.SOS_TIMEOUT_SEC) || 600;
const DEFAULT_HEARTBEAT_SEC = Number(process.env.SOS_HEARTBEAT_SEC) || 30;
// Bytes of recent engine stdout to flush to the parent's stdout on exit when
// the live stream was suppressed. Helps callers see a tail without opening the
// log file, while still forcing them to Read the log for the full content.
const TAIL_BYTES_ON_EXIT = 4096;
// Grace period between SIGTERM and SIGKILL when --timeout fires.
const KILL_GRACE_MS = 5000;
// Exit code for a "clean" engine exit (status 0) that nonetheless produced no
// usable review — zero bytes, or output missing the structured-output
// envelope. Distinct from success (0), the engine's own failure codes, and the
// timeout code (124) so callers/fusion can tell "engine ran but said nothing"
// apart from "engine errored" and "engine timed out".
const EXIT_NO_OUTPUT = 3;

const argv = process.argv.slice(2);

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  review.js --engine=<name>[:<model>] [--engine=...] --cwd=<path>',
      '            [--diff=<spec> | --file=<path>] "<prompt>"',
      '            [--engine-arg=<arg> ... | -- <engine-args...>]',
      '',
      'Engines:',
      '  opencode, gemini, codex, claude, copilot, qwen, kilo, agy, cmd, agent',
      '  (agent = Cursor CLI; aliases "cursor" and "cursor-agent" also work)',
      '',
      'Engine / model:',
      '  --engine=gemini                            default model',
      '  --engine=codex:gpt-5                       single engine, inline model',
      '  --engine=gemini --engine=codex:gpt-5       fusion: repeat the flag',
      '  --engine=opencode:a --engine=opencode:b    same engine, two models',
      '  --engine=a,b,c                             CSV shorthand',
      '',
      'Fusion output:',
      '  Each slot gets its own log file under $TMPDIR/second-opinion-fusion-<ts>/.',
      '  Filename is <engine>.log or <engine>__<sanitized-model>.log.',
      '',
      'Diff/file shortcuts:',
      '  --diff=unstaged     git diff + untracked files',
      '  --diff=staged       git diff --staged',
      '  --diff=last-commit  git diff HEAD~1',
      '  --diff=branch       git diff <default-branch>..HEAD (auto-detected)',
      '  --diff=<range>      git diff <range>',
      '  --file=<path>       review a specific file (repeatable)',
      '',
      'Extra engine args:',
      '  --engine-arg=<arg>  Forward one extra arg to the engine CLI (repeatable)',
      '  --                  Forward all remaining args to the engine CLI',
      '',
      'Output capture:',
      '  --log=<path>        Tee engine output to <path> (in addition to stdout)',
      '  --log=-             Disable auto-logging (force stdout-only)',
      '  (default)           Auto-log to $TMPDIR/second-opinion-<engine>-<ts>.log',
      '                      when stdout is not a TTY (agent harness, pipes, CI)',
      '',
      'Liveness:',
      `  --timeout=<sec>     Kill engine after N seconds (default ${DEFAULT_TIMEOUT_SEC}, 0=disable)`,
      `  --heartbeat=<sec>   Heartbeat interval when engine silent (default ${DEFAULT_HEARTBEAT_SEC}, 0=disable)`,
      '',
      'Fusion concurrency (multi-slot only):',
      '  --concurrency=<n>   Max slots running at once (default: all in parallel)',
      '                      1 = strictly serial, for rate-limited providers',
      '',
      'Engine behavior:',
      '  --unrestricted      Drop per-engine sandbox/plan/read-only flags',
      '                      (lets the engine edit/run commands; use deliberately)',
      '  --no-embed          Do not inline diff/file content; tell the engine to',
      '                      fetch via its own shell. Lower argv, needs shell access.',
      '  --no-wrap           Skip the structured-output sentinel envelope',
      '                      (default appends <<<SECOND_OPINION_START/END>>> markers)',
      '  --include-secrets   Do NOT scrub .env-style secret files. By default',
      '                      review.js refuses --file=.env, skips untracked .env',
      '                      files, and redacts .env hunks from diffs (except',
      '                      *example*/*sample*/*template*).',
      '',
      'Exit codes:',
      '  0    success',
      '  3    clean exit but NO usable output (0 bytes, or — when wrapped —',
      '       missing the <<<SECOND_OPINION_START>>> envelope)',
      '  124  timeout (matches GNU `timeout`)',
      "  *    otherwise the engine CLI's own non-zero code",
      '',
      'Examples:',
      '  review.js --engine=claude --cwd=. "Review this" --engine-arg=--verbose',
      '  review.js --engine=codex --cwd=. "Review this" -- --model o3',
      '  review.js --engine=gemini --cwd=. --log=/tmp/r.log "Review this"',
      '  review.js --engine=codex --cwd=. --timeout=300 --heartbeat=15 "Review this"',
    ].join('\n') + '\n'
  );
}

// Canonical registry of review.js's OWN flags. Single source of truth, kept in
// sync with the parse loop below. Used by the post-parse guard to detect when
// one of these leaks past `--` (or into --engine-arg=) and gets forwarded to
// the engine CLI — a common footgun that surfaces as a confusing engine-side
// "unknown argument" error rather than a review.js error. Prefix flags take
// `=<value>`; bare flags are standalone booleans. `--help`/`-h` are omitted on
// purpose: an engine may legitimately accept its own --help after `--`.
const REVIEW_JS_PREFIX_FLAGS = [
  '--engine=',
  '--engine-arg=',
  '--model=',
  '--cwd=',
  '--diff=',
  '--file=',
  '--log=',
  '--timeout=',
  '--heartbeat=',
  '--concurrency=',
];
const REVIEW_JS_BARE_FLAGS = [
  '--unrestricted',
  '--no-embed',
  '--no-wrap',
  '--include-secrets',
];

// Warn (do not block) when a token destined for the engine CLI looks like one
// of review.js's own flags. We keep the `--` pass-through contract intact —
// the token IS forwarded — but emit a clear hint so the caller knows to move
// it before `--` if they meant it for review.js. Non-fatal by design: an
// engine could genuinely accept a same-named flag.
function warnMisplacedReviewFlags(args) {
  const misplaced = args.filter(
    (a) =>
      REVIEW_JS_BARE_FLAGS.includes(a) ||
      REVIEW_JS_PREFIX_FLAGS.some((p) => a.startsWith(p))
  );
  if (misplaced.length === 0) return;
  process.stderr.write(
    `review.js: note: ${misplaced.map((m) => `'${m}'`).join(', ')} ` +
      `look like review.js flag(s) but were placed after '--' (or in ` +
      `--engine-arg=), so they are forwarded to the engine CLI verbatim — ` +
      `likely causing an "unknown argument" failure from the engine. If you ` +
      `meant them for review.js, move them BEFORE '--'.\n`
  );
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '-h' || arg === '--help') {
    showHelp = true;
    break;
  }
  if (arg === '--') {
    extraEngineArgs = argv.slice(i + 1);
    break;
  }
  if (arg.startsWith('--engine-arg='))
    extraEngineArgs.push(arg.slice('--engine-arg='.length));
  else if (arg.startsWith('--engine=')) {
    // Repeatable. Each --engine= may also contain a comma-separated list;
    // each piece is 'name' or 'name:model'. Collect raw for later parsing.
    const v = arg.slice('--engine='.length);
    for (const piece of v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      rawEngineSpecs.push(piece);
    }
  } else if (arg.startsWith('--model=')) {
    process.stderr.write(
      "review.js: --model=<val> is no longer supported. Use '--engine=<name>:<model>' instead.\n"
    );
    process.exit(1);
  } else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
  else if (arg.startsWith('--diff=')) diffSpec = arg.slice('--diff='.length);
  else if (arg.startsWith('--file='))
    filePaths.push(arg.slice('--file='.length));
  else if (arg.startsWith('--log=')) logArg = arg.slice('--log='.length);
  else if (arg.startsWith('--timeout='))
    timeoutArg = arg.slice('--timeout='.length);
  else if (arg.startsWith('--heartbeat='))
    heartbeatArg = arg.slice('--heartbeat='.length);
  else if (arg.startsWith('--concurrency='))
    concurrencyArg = arg.slice('--concurrency='.length);
  else if (arg === '--unrestricted') unrestricted = true;
  else if (arg === '--no-embed') noEmbed = true;
  else if (arg === '--no-wrap') noWrap = true;
  else if (arg === '--include-secrets') includeSecrets = true;
  else if (!prompt) prompt = arg;
  else {
    process.stderr.write(`review.js: unexpected argument '${arg}'\n`);
    process.stderr.write(
      'Use --engine-arg=<arg> or -- to pass extra engine-specific args.\n'
    );
    process.exit(1);
  }
}

if (showHelp) {
  printHelp();
  process.exit(0);
}

const SUPPORTED_ENGINES = [
  'opencode',
  'gemini',
  'codex',
  'claude',
  'copilot',
  'qwen',
  'kilo',
  'agy',
  'cmd',
  'agent',
];

// Friendly engine-name aliases that normalize to a canonical engine before
// validation. Cursor's CLI binary is `agent`, but users naturally reach for
// "cursor" / "cursor-agent" — accept all three. Applied in the slot parser
// below, so aliases flow through the rest of the script as the canonical name.
const ENGINE_ALIASES = {
  cursor: 'agent',
  'cursor-agent': 'agent',
};

if (rawEngineSpecs.length === 0) {
  printHelp();
  process.exit(1);
}

// Engines that REQUIRE a model. Used to fail-fast.
const MODEL_REQUIRED = new Set(['opencode']);

// Parse every --engine= piece into a {engine, model} slot. Inline 'name:model'
// binds model directly to that slot; bare 'name' falls back to globalModel
// (if set) or empty. Dedup by (engine, model) tuple — same engine with
// different models is a valid pair of fusion slots.
const slots = [];
const seen = new Set();
for (const piece of rawEngineSpecs) {
  const idx = piece.indexOf(':');
  let eng, mdl;
  if (idx >= 0) {
    eng = piece.slice(0, idx);
    mdl = piece.slice(idx + 1);
    if (!eng || !mdl) {
      process.stderr.write(
        `review.js: --engine='${piece}' has empty engine or model around ':'\n`
      );
      process.exit(1);
    }
  } else {
    eng = piece;
    mdl = '';
  }
  // Normalize friendly aliases (cursor, cursor-agent) to their canonical
  // engine (agent) before validation and dedup.
  eng = ENGINE_ALIASES[eng] || eng;
  if (!SUPPORTED_ENGINES.includes(eng)) {
    process.stderr.write(`review.js: unknown engine '${eng}'\n`);
    process.stderr.write(
      `Supported engines: ${SUPPORTED_ENGINES.join(', ')}\n`
    );
    process.exit(1);
  }
  const key = `${eng}\u0001${mdl}`;
  if (seen.has(key)) continue; // dedup exact-duplicate slots
  seen.add(key);
  slots.push({ engine: eng, model: mdl });
}

// Validate model-required engines.
for (const s of slots) {
  if (MODEL_REQUIRED.has(s.engine) && !s.model) {
    process.stderr.write(
      `review.js: engine '${s.engine}' requires a model. Use '--engine=${s.engine}:<provider/model>'.\n`
    );
    process.exit(1);
  }
}

// Footgun guard: if a review.js flag was placed after `--` (or smuggled via
// --engine-arg=), warn before we dispatch. In fusion mode this runs in the
// parent (real stderr) and again in each child (stderr ignored), so the
// caller sees exactly one note.
warnMisplacedReviewFlags(extraEngineArgs);

const isFusion = slots.length > 1;

// In single-engine mode, project the slot back onto the module-level
// `engine`/`model` vars that the rest of the script reads.
if (!isFusion) {
  engine = slots[0].engine;
  model = slots[0].model;
}

if (!prompt) {
  process.stderr.write(
    'review.js: prompt is required as a positional argument\n'
  );
  process.exit(1);
}

if (diffSpec && filePaths.length) {
  process.stderr.write('review.js: --diff and --file are mutually exclusive\n');
  process.exit(1);
}

// Refuse to hand an engine a .env-style secret file — whether we embed its
// contents or (under --no-embed) tell the engine to open it itself. Override
// with --include-secrets. System-level: enforced before any prompt is built.
if (!includeSecrets) {
  const secret = filePaths.find((p) => isLikelyEnvSecret(p));
  if (secret) {
    process.stderr.write(
      `review.js: refusing --file='${secret}' — it looks like a secret/.env ` +
        'file and may hold real credentials. Pass --include-secrets to ' +
        'override, or use an .env.example.\n'
    );
    process.exit(1);
  }
}

function parseSecondsArg(name, raw, fallback) {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(
      `review.js: --${name}=<seconds> must be a non-negative number, got '${raw}'\n`
    );
    process.exit(1);
  }
  return n;
}

const timeoutSec = parseSecondsArg('timeout', timeoutArg, DEFAULT_TIMEOUT_SEC);
const heartbeatSec = parseSecondsArg(
  'heartbeat',
  heartbeatArg,
  DEFAULT_HEARTBEAT_SEC
);

// Max number of fusion slots to run at once. Unset → unbounded (all slots in
// parallel, the historical default). 1 → strictly serial (rate-limit safe).
// k → capped pool of k. Only meaningful in fusion mode; ignored for a single
// engine. Validated up front so a typo fails fast rather than mid-run.
function parseConcurrencyArg(raw) {
  if (raw === null) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(
      `review.js: --concurrency=<n> must be a positive integer, got '${raw}'\n`
    );
    process.exit(1);
  }
  return n;
}
const concurrency = parseConcurrencyArg(concurrencyArg);

// Resolve the default remote branch once so --diff=branch can target it
// instead of guessing origin/main. Falls back to HEAD~1..HEAD in fetchDiff.
function resolveDefaultBranchRef() {
  // git symbolic-ref refs/remotes/origin/HEAD → 'refs/remotes/origin/main'
  const r = spawnSync(
    'git',
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd, encoding: 'utf8' }
  );
  if (r.status === 0 && r.stdout) {
    return r.stdout.trim(); // e.g. 'origin/main'
  }
  return null;
}

// Build a synthetic diff for untracked files (new files git would otherwise
// omit from `git diff`). Read-only: lists untracked paths honoring .gitignore,
// then renders each as an add-style diff via `git diff --no-index /dev/null
// <file>`. Binary files (NUL in first 8KB) are skipped with a note so they
// don't blow up the prompt or corrupt it. Returns '' when there are none.
function fetchUntrackedContent() {
  const ls = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd, encoding: 'utf8' }
  );
  if (ls.status !== 0 || !ls.stdout) return '';
  const files = ls.stdout.split('\0').filter(Boolean);
  if (files.length === 0) return '';

  const parts = [];
  for (const rel of files) {
    // Never embed a .env-style secret file's contents (unless --include-secrets).
    if (!includeSecrets && isLikelyEnvSecret(rel)) {
      parts.push(
        `# (skipped potential secret file: ${rel} — pass --include-secrets to include)\n`
      );
      continue;
    }
    const abs = path.join(cwd, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // raced away / unreadable — skip
    }
    const sniff = buf.subarray(0, Math.min(buf.length, 8192));
    if (sniff.includes(0)) {
      parts.push(`# (skipped binary untracked file: ${rel})\n`);
      continue;
    }
    // `git diff --no-index` exits 1 when files differ (they always do here vs
    // /dev/null); that's expected, so we use stdout regardless of status.
    const d = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', rel], {
      cwd,
      encoding: 'utf8',
    });
    if (d.stdout) parts.push(d.stdout);
  }
  return parts.join('');
}

// Decide whether a `diff --git` header line names an .env-style secret file.
// Handles git's c-quoted form — `diff --git "a/…" "b/…"` — emitted when a path
// contains non-ASCII or special bytes (core.quotePath, on by default), as well
// as the bare form. Tests BOTH path tokens (a-side and b-side) so a rename
// to/from a secret is caught. Errs toward redaction on an unparseable header.
function diffHeaderTouchesEnvSecret(headerLine) {
  const rest = headerLine.replace(/^diff --git\s+/, '');
  let toks;
  // Quoted form: git quotes BOTH sides together. Capture inside each "...".
  const q = rest.match(/^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"\s*$/);
  if (q) {
    toks = [q[1], q[2]];
  } else {
    // Bare form: filenames never contain spaces here (git quotes those), so
    // the two tokens are `a/<old>` and `b/<new>` separated by " b/".
    const m = rest.match(/^a\/(.*?) b\/(.*?)\s*$/);
    toks = m ? [m[1], m[2]] : rest.split(/\s+/);
  }
  // Strip any surrounding quote and the a//b/ prefix, then match on basename.
  const clean = (t) => t.replace(/^"/, '').replace(/^[ab]\//, '');
  return toks.some((t) => isLikelyEnvSecret(clean(t)));
}

// Redact .env-style secret files from a unified diff so a tracked secret
// (committing a real .env is bad practice but happens) never reaches an engine.
// Splits on `diff --git` section boundaries, identifies each section's path
// from its header, and replaces secret sections with a one-line note while
// keeping every other file's hunks intact. No-op under --include-secrets.
function redactEnvFromDiff(diff) {
  if (includeSecrets || !diff) return diff;
  // Lookahead split keeps the `diff --git` line attached to its section; the
  // first element is any preamble before the first header (usually empty).
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .map((sec) => {
      if (!sec.startsWith('diff --git ')) return sec;
      const nl = sec.indexOf('\n');
      const headerLine = nl >= 0 ? sec.slice(0, nl) : sec;
      if (diffHeaderTouchesEnvSecret(headerLine)) {
        // Keep the header (the filename is not the secret — the hunk is) so
        // the reviewer can see WHICH file was withheld; drop the body.
        return (
          headerLine +
          '\n# (redacted potential secret file — contents withheld; ' +
          'pass --include-secrets to include)\n'
        );
      }
      return sec;
    })
    .join('');
}

// Fetch raw diff content for a given spec. Returns the string.
//
// For `unstaged` we also append untracked files (see fetchUntrackedContent):
// plain `git diff` omits them, so a WIP review of work that ADDS files would
// silently miss the new files. The other specs (staged, last-commit, branch,
// custom range) are commit/index scoped and intentionally exclude untracked.
function fetchDiffContent(spec) {
  const shortcuts = {
    unstaged: ['diff'],
    staged: ['diff', '--staged'],
    'last-commit': ['diff', 'HEAD~1'],
  };
  let args;
  if (spec === 'branch') {
    const base = resolveDefaultBranchRef();
    args = base ? ['diff', `${base}..HEAD`] : ['diff', 'HEAD~1..HEAD'];
  } else {
    args = shortcuts[spec] ?? ['diff', spec];
  }

  let result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  // Fallback for branch: if the auto-detected base ref didn't work
  // (shallow clone, no upstream), fall back to HEAD~1..HEAD.
  if (spec === 'branch' && result.status !== 0) {
    args = ['diff', 'HEAD~1..HEAD'];
    result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  }

  if (result.error || result.status !== 0) {
    process.stderr.write(
      `review.js: git ${args.join(' ')} failed: ${result.stderr || result.error?.message || 'unknown'}\n`
    );
    process.exit(1);
  }

  let combined = redactEnvFromDiff(result.stdout);
  if (spec === 'unstaged') combined += fetchUntrackedContent();

  if (!combined.trim()) {
    process.stderr.write(
      `review.js: git ${args.join(' ')} produced no output — nothing to review\n`
    );
    process.exit(1);
  }

  return combined;
}

function readFileContent(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (err) {
    process.stderr.write(`review.js: could not read ${p}: ${err.message}\n`);
    process.exit(1);
  }
  // Reject binary files: NUL byte in the first 8KB is a strong signal.
  const sniff = buf.subarray(0, Math.min(buf.length, 8192));
  if (sniff.includes(0)) {
    process.stderr.write(
      `review.js: --file '${p}' looks binary (NUL byte detected); pass a text file or use --diff\n`
    );
    process.exit(1);
  }
  return buf.toString('utf8');
}

// Escape closing tags so embedded content cannot break out of the wrapper block.
function escapeForBlock(content, tag) {
  const close = `</${tag}>`;
  return content.split(close).join(`</​${tag}>`);
}

// Cap on the final combined prompt size. Linux ARG_MAX is often 128KB after
// environment overhead; macOS is ~256KB. Stay under the smallest realistic
// limit so `spawnSync` doesn't fail with E2BIG.
const PROMPT_BYTE_LIMIT = 120_000;

function checkPromptSize(p) {
  const size = Buffer.byteLength(p, 'utf8');
  if (size > PROMPT_BYTE_LIMIT) {
    process.stderr.write(
      `review.js: combined prompt is ${size} bytes (limit ${PROMPT_BYTE_LIMIT}). ` +
        'Narrow the diff range or split the file.\n'
    );
    process.exit(1);
  }
}

// git pathspecs that exclude .env-style files, so the --no-embed `git diff`
// the engine runs itself never emits secret content. (In embed mode we redact
// instead; this is the system-level guard for the self-fetch path.) Slightly
// over-excludes .env.example etc, which is the safe direction for no-embed.
const ENV_EXCLUDE_PATHSPECS = [
  ':(exclude,glob)**/.env',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/*.env',
];

// Resolve the actual git args we would use for a given diff spec, so
// --no-embed mode can show the engine the same range we would have fetched.
// Appends env-file exclude pathspecs unless --include-secrets.
function resolveDiffArgs(spec) {
  const shortcuts = {
    unstaged: ['diff'],
    staged: ['diff', '--staged'],
    'last-commit': ['diff', 'HEAD~1'],
  };
  let args;
  if (spec === 'branch') {
    const base = resolveDefaultBranchRef();
    args = base ? ['diff', `${base}..HEAD`] : ['diff', 'HEAD~1..HEAD'];
  } else {
    args = shortcuts[spec] ?? ['diff', spec];
  }
  if (!includeSecrets) args = [...args, '--', ...ENV_EXCLUDE_PATHSPECS];
  return args;
}

// `combinedPrompt` is consumed deep inside buildEngineCmd(). In single-engine
// mode we build it now; in fusion mode the children build their own copies
// (since each may differ if they ever specialize — but for now identical),
// so we skip the work here and let runFusion() spawn children that go
// through this same top-level codepath with --engine=<one>.
let combinedPrompt = '';
if (!isFusion) {
  combinedPrompt = prompt;
  if (diffSpec) {
    if (noEmbed) {
      const args = resolveDiffArgs(diffSpec).map(shellQuote).join(' ');
      combinedPrompt =
        `Repository root: ${cwd}\n` +
        `Use your shell to run: git -C ${shellQuote(cwd)} ${args}\n` +
        `Read the resulting diff, then:\n\n${prompt}`;
    } else {
      const diffContent = escapeForBlock(fetchDiffContent(diffSpec), 'diff');
      combinedPrompt = `<diff>\n${diffContent}\n</diff>\n\nReview the diff above. Then:\n\n${prompt}`;
    }
  } else if (filePaths.length) {
    if (noEmbed) {
      const list = filePaths.map((p) => `  - ${p}`).join('\n');
      combinedPrompt =
        `Repository root: ${cwd}\n` +
        `Read the file(s) at:\n${list}\n` +
        `Then:\n\n${prompt}`;
    } else {
      const blocks = filePaths
        .map((p) => {
          const fileContent = escapeForBlock(readFileContent(p), 'file');
          return `<file path="${p}">\n${fileContent}\n</file>`;
        })
        .join('\n\n');
      const noun = filePaths.length > 1 ? 'files' : 'file';
      combinedPrompt = `${blocks}\n\nReview the ${noun} above. Then:\n\n${prompt}`;
    }
  }

  // When review.js embedded the content (diff/file, not --no-embed), tell the
  // engine the review is self-contained. Agentic engines (notably opencode)
  // otherwise ignore the embedded block and explore the filesystem — globbing
  // outside --cwd, tripping sandbox auto-rejects, and returning an empty review.
  if (!noEmbed && (diffSpec || filePaths.length)) {
    combinedPrompt +=
      '\n\n---\n' +
      'This review is self-contained: everything needed is in the content above. ' +
      'Answer from it directly — do not read files, glob, run shell commands, or ' +
      'otherwise explore the repository.';
  }

  // Secret-file guard (belt-and-suspenders for self-read vectors). review.js
  // already scrubs .env contents from anything it embeds; this line covers the
  // cases where the engine reads on its own — --no-embed, or a sandbox engine
  // walking the tree. Skipped under --include-secrets.
  if (!includeSecrets) {
    combinedPrompt +=
      '\n\n---\n' +
      'SECURITY: Do not open, read, print, or otherwise access environment/secret ' +
      'files (.env, .env.*, *.env — except *example*/*sample*/*template* files). ' +
      'They may contain real credentials. If any diff hunk, command output, or ' +
      'file content you are given includes such a file, skip that section and note ' +
      'it was withheld rather than reproducing or acting on its contents.';
  }

  // Structured-output envelope. Forces the engine to emit its real answer
  // between stable sentinels, so callers can extract the payload from the
  // log without scraping reasoning traces, tool-use noise, or model-specific
  // scaffolding. Topic-neutral — works for review, Q&A, brainstorming, anything.
  if (!noWrap) {
    // Describe the markers inline rather than printing a standalone
    // START / <body> / END block: a literal example block gets echoed into the
    // log by some engines and a first-match extractor then grabs the example
    // body instead of the real answer. Tokens are joined from fragments so this
    // instruction text itself doesn't contain a clean copyable marker pair.
    const S = '<<<' + 'SECOND_OPINION_START' + '>>>';
    const E = '<<<' + 'SECOND_OPINION_END' + '>>>';
    combinedPrompt +=
      '\n\n---\n' +
      `OUTPUT FORMAT (required): put your full final answer between two marker lines — a line reading exactly ${S} immediately before it, and a line reading exactly ${E} immediately after it. ` +
      'Emit each marker once, alone on its own line. Reasoning or scratch work before the START marker is fine and is ignored; do not nest or paraphrase the markers.';
  }

  checkPromptSize(combinedPrompt);
}

// Determine where to write the captured copy of engine output (the "log").
// Priority:
//   --log=<path>   → explicit file path
//   --log=-        → disable (force stdout-only)
//   stdout is TTY  → no log (interactive use)
//   otherwise      → auto-generate $TMPDIR/second-opinion-<engine>-<ts>.log
// Returning null means "don't write a log file, just stream to stdout".
function resolveLogPath() {
  if (logArg === '-') return null;
  if (logArg) return path.resolve(logArg);
  if (process.stdout.isTTY) return null;
  const tmp = (process.env.TMPDIR || '/tmp').replace(/\/+$/, '');
  return path.join(tmp, `second-opinion-${engine}-${Date.now()}.log`);
}

// Resolve a command on PATH. Returns the absolute path or null if missing.
// Used for pre-flight checks AND for picking the PTY wrapper.
function whichCmd(cmd) {
  // `command -v` is the POSIX-standard way and is a shell builtin, so we
  // have to invoke it via /bin/sh. Pass the full pipeline as a single
  // string to avoid Node's DEP0190 warning about array args + shell.
  // shellQuote guards against any path-injection via the input arg.
  const r = spawnSync('/bin/sh', ['-c', `command -v ${shellQuote(cmd)}`], {
    encoding: 'utf8',
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  // Some `command -v` builtins refuse to print non-builtin paths; fall back
  // to `which` which exists nearly everywhere POSIX.
  const r2 = spawnSync('which', [cmd], { encoding: 'utf8' });
  if (r2.status === 0 && r2.stdout) return r2.stdout.trim();
  return null;
}

const INSTALL_HINTS = {
  opencode: 'https://opencode.ai',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  codex: 'https://github.com/openai/codex',
  claude: 'https://claude.ai/code',
  copilot: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  qwen: 'https://github.com/QwenLM/qwen-code',
  kilo: 'https://kilocode.ai',
  agy: 'https://antigravity.google.com',
  cmd: 'https://commandcode.ai/docs',
  agent: 'https://cursor.com/cli',
};

function preflightCheck(cmd) {
  const found = whichCmd(cmd);
  if (found) return;
  const hint = INSTALL_HINTS[engine]
    ? `\n  Install: ${INSTALL_HINTS[engine]}`
    : '';
  process.stderr.write(
    `review.js: '${cmd}' not found on PATH. Cannot run --engine=${engine}.${hint}\n`
  );
  process.exit(127);
}

// Many engine CLIs (codex exec, claude --print, gemini -p, etc.) detect a
// non-TTY stdout and buffer output until completion. When review.js is run
// from a background shell (CI, agent harness, `&`), this produces long silent
// stretches that look like a hang.
//
// We probe wrappers in this order, picking the first that exists AND is
// usable in the current environment:
//
//   1. `unbuffer -p` (expect package). Cross-platform, no TTY-on-stdin
//      requirement. Best when available.
//   2. `script(1)`. Per-platform syntax. BSD `script` calls tcgetattr() on
//      its own stdin and aborts when stdin is not a TTY, so on darwin we
//      can only use it when stdin is a real TTY. Linux util-linux is fine.
//   3. Direct spawn — engine bytes may buffer until exit, but at least the
//      process runs.
//
// We use streaming `spawn` (not `spawnSync`) so we can pipe chunks into both
// the parent stdio and an optional log file.
function chooseSpawn(cmd, args) {
  // No PTY needed when stdout is already a TTY (interactive use).
  if (process.stdout.isTTY || process.platform === 'win32') {
    return { cmd, args, viaScript: false, viaUnbuffer: false };
  }

  // Step 1: unbuffer (from `expect`). Works cross-platform without needing
  // a real TTY on stdin. Preferred when present.
  if (whichCmd('unbuffer')) {
    return {
      cmd: 'unbuffer',
      args: ['-p', cmd, ...args],
      viaScript: false,
      viaUnbuffer: true,
    };
  }

  // Step 2: script(1). Skip on darwin if stdin isn't a TTY (BSD script
  // aborts via tcgetattr). Linux util-linux `script -qfc` has no such
  // requirement.
  const scriptUsable = process.platform !== 'darwin' || process.stdin.isTTY;
  if (scriptUsable && whichCmd('script')) {
    const scriptArgs =
      process.platform === 'darwin'
        ? ['-q', '/dev/null', cmd, ...args]
        : ['-qfc', [cmd, ...args].map(shellQuote).join(' '), '/dev/null'];
    return {
      cmd: 'script',
      args: scriptArgs,
      viaScript: true,
      viaUnbuffer: false,
    };
  }

  // Step 3: give up on PTY. Engine may buffer output until exit.
  return { cmd, args, viaScript: false, viaUnbuffer: false };
}

// When a log file is in use AND stdout is not a TTY, suppress live engine
// output from the parent's stdout entirely. Models invoking review.js from an
// agent harness routinely pipe to `| tail -N`, which truncates long reviews
// and loses content. By keeping engine bytes off stdout in that mode, we force
// callers to read the log file — there is literally nothing else to consume
// live. We DO flush a final tail (TAIL_BYTES_ON_EXIT) to stdout when the
// engine exits so callers always see at least the end of the review without
// having to open the log file.
function runEngine(cmd, args, logStream) {
  const stdoutSuppressed = !!logStream && !process.stdout.isTTY;
  return new Promise((resolve) => {
    const choice = chooseSpawn(cmd, args);
    let child;
    // Track engine activity for heartbeat + tail buffer.
    let lastByteAt = Date.now();
    let totalBytes = 0;
    const tail = [];
    let tailBytes = 0;
    // Whether the engine's stdout ever contained the structured-output START
    // marker. Used by main() to distinguish a real answer from empty/refused/
    // sandbox-blocked output. envCarry holds the trailing bytes of the last
    // stdout chunk so a marker split across two chunks is still detected.
    let sawEnvelope = false;
    let envCarry = '';
    // Tolerant START-marker matcher: accept near-misses real engines emit, e.g.
    // `<<<SECOND_OPINION_START>>` (two '>') from cmd, stray inner whitespace, or
    // 2+ angle brackets either side. An over-strict exact match here discards a
    // perfectly good review as "no output" (false exit 3).
    const START_RE = /<{2,}\s*SECOND_OPINION_START\s*>{2,}/;
    // Longest carry needed to catch a marker split across two chunks.
    const ENV_CARRY = 48;

    function scanEnvelope(chunk) {
      if (sawEnvelope) return;
      const s = envCarry + chunk.toString('utf8');
      if (START_RE.test(s)) sawEnvelope = true;
      // Keep a tail long enough that a marker straddling the next chunk matches.
      envCarry = s.slice(-ENV_CARRY);
    }

    function recordBytes(chunk) {
      lastByteAt = Date.now();
      totalBytes += chunk.length;
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes > TAIL_BYTES_ON_EXIT && tail.length > 1) {
        const dropped = tail.shift();
        tailBytes -= dropped.length;
      }
    }

    // stdio: 'ignore' on stdin — engines must NOT inherit the agent
    // harness stdin. Codex `exec` (and others) treat a non-TTY non-EOF
    // stdin as supplementary prompt input and block forever waiting for
    // EOF. Closing stdin makes them use only the argv prompt.
    try {
      child = spawn(choice.cmd, choice.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ status: null, error: err, killedByTimeout: false });
      return;
    }

    let scriptFellBack = false;
    let killedByTimeout = false;
    let heartbeatTimer = null;
    let timeoutTimer = null;
    let killTimer = null;

    function clearTimers() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      heartbeatTimer = timeoutTimer = killTimer = null;
    }

    function settle(result) {
      clearTimers();
      resolve(result);
    }

    function emitHeartbeat() {
      const elapsed = Math.round((Date.now() - lastByteAt) / 1000);
      const totalElapsed = Math.round((Date.now() - started) / 1000);
      // When the engine has produced ZERO bytes since launch, this is not
      // ordinary mid-stream silence — it usually means the upstream model is
      // unavailable/queued, or the engine is wedged before emitting anything.
      // Flag it distinctly so a 0-byte run is recognizable in the log/stderr
      // rather than looking like normal "thinking" silence.
      const outage =
        totalBytes === 0
          ? ' — NO OUTPUT YET; possible upstream model unavailability'
          : '';
      const msg = `# heartbeat +${totalElapsed}s (no engine output for ${elapsed}s, bytes-so-far=${totalBytes})${outage}\n`;
      if (logStream) logStream.write(msg);
      process.stderr.write(
        `review.js: alive +${totalElapsed}s (silent ${elapsed}s, bytes=${totalBytes})${outage}\n`
      );
    }

    child.on('error', (err) => {
      // `script` missing — fall back to direct spawn once.
      if (choice.viaScript && !scriptFellBack && err && err.code === 'ENOENT') {
        scriptFellBack = true;
        process.stderr.write(
          "review.js: 'script' not found on PATH; running without PTY (output may buffer)\n"
        );
        const direct = spawn(cmd, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        wireStreams(direct);
        attachLifecycle(direct);
        return;
      }
      settle({ status: null, error: err, killedByTimeout });
    });

    function wireStreams(c) {
      c.stdout.on('data', (chunk) => {
        recordBytes(chunk);
        scanEnvelope(chunk);
        if (!stdoutSuppressed) process.stdout.write(chunk);
        if (logStream) logStream.write(chunk);
      });
      c.stderr.on('data', (chunk) => {
        recordBytes(chunk);
        process.stderr.write(chunk);
        if (logStream) logStream.write(chunk);
      });
    }

    function attachLifecycle(c) {
      // Heartbeat: every heartbeatSec, if no bytes seen since the last
      // tick, emit a liveness line to both the log and stderr.
      if (heartbeatSec > 0) {
        let lastTickAt = Date.now();
        heartbeatTimer = setInterval(() => {
          if (lastByteAt > lastTickAt) {
            // We saw bytes this interval — quiet.
            lastTickAt = Date.now();
            return;
          }
          lastTickAt = Date.now();
          emitHeartbeat();
        }, heartbeatSec * 1000);
        if (heartbeatTimer.unref) heartbeatTimer.unref();
      }

      // Timeout: SIGTERM after timeoutSec, SIGKILL after KILL_GRACE_MS.
      if (timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
          killedByTimeout = true;
          const totalElapsed = Math.round((Date.now() - started) / 1000);
          const msg = `# TIMEOUT after ${totalElapsed}s (--timeout=${timeoutSec}); sending SIGTERM\n`;
          if (logStream) logStream.write(msg);
          process.stderr.write(`review.js: ${msg.replace(/^# /, '')}`);
          try {
            c.kill('SIGTERM');
          } catch {
            /* already exited */
          }
          killTimer = setTimeout(() => {
            const m2 = `# escalating to SIGKILL after ${KILL_GRACE_MS}ms grace\n`;
            if (logStream) logStream.write(m2);
            process.stderr.write(`review.js: ${m2.replace(/^# /, '')}`);
            try {
              c.kill('SIGKILL');
            } catch {
              /* already exited */
            }
          }, KILL_GRACE_MS);
          if (killTimer.unref) killTimer.unref();
        }, timeoutSec * 1000);
        if (timeoutTimer.unref) timeoutTimer.unref();
      }

      c.on('exit', (code, signal) => {
        // On exit, flush tail to stdout if it was suppressed and there's
        // something to show.
        if (stdoutSuppressed && tail.length > 0) {
          const tailBuf = Buffer.concat(tail);
          process.stdout.write(
            `\n--- engine output tail (last ${tailBuf.length} bytes; full log via Read tool) ---\n`
          );
          process.stdout.write(tailBuf);
          if (!tailBuf.toString('utf8').endsWith('\n'))
            process.stdout.write('\n');
          process.stdout.write('--- end tail ---\n');
        }
        settle({
          status: signal ? 128 + signum(signal) : code,
          error: null,
          killedByTimeout,
          totalBytes,
          sawEnvelope,
        });
      });
    }

    wireStreams(child);
    attachLifecycle(child);
  });
}

// Map a signal name ('SIGTERM') to its number via os.constants for the
// conventional 128+N exit-code convention.
function signum(sig) {
  const table = os.constants && os.constants.signals;
  if (table && typeof table[sig] === 'number') return table[sig];
  const fallback = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return fallback[sig] || 0;
}

// Per-engine sandbox / plan / read-only flags. These are the *only* flags
// that --unrestricted strips out. Functional flags (--print, -p, exec, run,
// etc.) stay in the case blocks below because removing them breaks the
// invocation entirely. Order matters within a single engine's array, but
// the array is treated as a contiguous span.
//
// IMPORTANT: test/safety.test.js parses this object literally with a regex.
// Keep each engine's flags on simple string-literal lines (no spreads, no
// computed values) so the test can verify the safety contract.
const SAFETY_FLAGS = {
  opencode: ['--agent', 'plan'],
  gemini: ['-s', '--approval-mode', 'plan'],
  codex: ['-s', 'read-only'],
  claude: ['--permission-mode', 'plan'],
  copilot: ['-s', '--plan', '--allow-all-tools', '--deny-tool=write'],
  qwen: ['-s', '--approval-mode', 'plan'],
  kilo: ['--agent', 'plan'],
  agy: ['--sandbox'],
  cmd: ['--permission-mode', 'plan'],
  agent: ['--plan'],
};

function safetyFor(eng) {
  return unrestricted ? [] : SAFETY_FLAGS[eng];
}

function buildEngineCmd() {
  switch (engine) {
    case 'opencode':
      if (!model) {
        process.stderr.write(
          'review.js: opencode requires --model=<provider/model>\n'
        );
        process.exit(1);
      }
      // --dir <cwd> scopes opencode's sandbox file-access root to the review
      // directory. Without it, opencode picks its own root and treats reads of
      // the --cwd subtree as `external_directory`, auto-rejecting them and
      // returning an empty review. Functional, not a safety flag — survives
      // --unrestricted.
      return [
        'opencode',
        [
          'run',
          '--dir',
          cwd,
          '--model',
          model,
          ...safetyFor('opencode'),
          ...extraEngineArgs,
          combinedPrompt,
        ],
      ];

    case 'gemini':
      // --skip-trust bypasses gemini's "not running in a trusted directory"
      // hard-fail in headless mode. Functional, NOT a safety flag (read-only
      // is enforced by -s/--approval-mode plan), so it survives --unrestricted.
      return [
        'gemini',
        [
          ...safetyFor('gemini'),
          '--skip-trust',
          ...extraEngineArgs,
          '-p',
          combinedPrompt,
        ],
      ];

    case 'codex': {
      // --skip-git-repo-check stops `codex exec` from hard-failing ("Not
      // inside a trusted directory ...") when --cwd is not a git repo. The
      // review is read-only (safetyFor('codex') → -s read-only), so skipping
      // the git-trust gate cannot cause writes. Functional, not a safety flag
      // — survives --unrestricted.
      const codexArgs = [
        'exec',
        ...safetyFor('codex'),
        '--skip-git-repo-check',
      ];
      if (model) codexArgs.push('-m', model);
      codexArgs.push(...extraEngineArgs);
      codexArgs.push(combinedPrompt);
      return ['codex', codexArgs];
    }

    case 'claude': {
      const claudeArgs = ['--print', ...safetyFor('claude')];
      if (model) claudeArgs.push('--model', model);
      claudeArgs.push(...extraEngineArgs);
      claudeArgs.push(combinedPrompt);
      return ['claude', claudeArgs];
    }

    case 'copilot': {
      const copilotArgs = [...safetyFor('copilot')];
      if (model) copilotArgs.push('--model', model);
      copilotArgs.push(...extraEngineArgs, '-p', combinedPrompt);
      return ['copilot', copilotArgs];
    }

    case 'qwen': {
      const qwenArgs = [...safetyFor('qwen')];
      if (model) qwenArgs.push('-m', model);
      qwenArgs.push(...extraEngineArgs);
      qwenArgs.push(combinedPrompt);
      return ['qwen', qwenArgs];
    }

    case 'kilo': {
      const kiloArgs = ['run', ...safetyFor('kilo')];
      if (model) kiloArgs.push('-m', model);
      kiloArgs.push(...extraEngineArgs);
      kiloArgs.push(combinedPrompt);
      return ['kilo', kiloArgs];
    }

    case 'agy': {
      // Antigravity CLI (`agy`) — single-prompt mode via --print.
      // agy >=1.0.1 supports a --model flag (`agy models` lists choices);
      // forward it when a model is given, otherwise let agy pick its default.
      // extraEngineArgs go BEFORE --print so the prompt stays adjacent to
      // its flag (same pattern as gemini's -p).
      const agyArgs = [...safetyFor('agy')];
      if (model) agyArgs.push('--model', model);
      agyArgs.push(...extraEngineArgs, '--print', combinedPrompt);
      return ['agy', agyArgs];
    }

    case 'cmd': {
      // Command Code (`cmd`) — single-prompt mode via --print. Model optional
      // (`cmd --list-models`); forward as -m when given, else let cmd pick its
      // default. --skip-onboarding is functional, NOT a safety flag: it stops
      // the interactive taste-onboarding prompt from hanging an automated run,
      // so it stays outside safetyFor() and survives --unrestricted. Mirrors
      // the claude block otherwise.
      const cmdArgs = ['--print', ...safetyFor('cmd'), '--skip-onboarding'];
      if (model) cmdArgs.push('-m', model);
      cmdArgs.push(...extraEngineArgs);
      cmdArgs.push(combinedPrompt);
      return ['cmd', cmdArgs];
    }

    case 'agent': {
      // Cursor CLI — binary `agent` (aliases `cursor`, `cursor-agent` are
      // normalized to `agent` upstream). Single-prompt headless mode via
      // --print. --plan is the gated safety flag (read-only plan mode; stripped
      // by --unrestricted). --trust is functional, NOT a safety flag: headless
      // --print mode otherwise prompts to trust the workspace and hangs an
      // automated run, so it stays outside safetyFor() and survives
      // --unrestricted. Model optional (`agent --list-models`); forward as
      // --model when given.
      const agentArgs = ['--print', ...safetyFor('agent'), '--trust'];
      if (model) agentArgs.push('--model', model);
      agentArgs.push(...extraEngineArgs);
      agentArgs.push(combinedPrompt);
      return ['agent', agentArgs];
    }

    default:
      process.stderr.write(`review.js: unhandled engine '${engine}'\n`);
      process.exit(1);
  }
}

// `started` is read by emitHeartbeat / timeout messages, so declare at
// module scope for clarity.
const started = Date.now();

async function main() {
  if (unrestricted) {
    process.stderr.write(
      `review.js: --unrestricted — dropping safety flags for ${engine} ` +
        `(${SAFETY_FLAGS[engine].join(' ')}). The engine may edit files or run ` +
        'arbitrary commands.\n'
    );
  }

  const [cmd, args] = buildEngineCmd();

  // Pre-flight: fail fast with a clear error if the engine CLI isn't on
  // PATH, rather than letting spawn surface ENOENT mid-stream.
  preflightCheck(cmd);

  // Set up output capture. We pipe child stdout/stderr through this process,
  // optionally tee'ing every chunk into a log file so callers (especially
  // agent harnesses) can recover the full output even if their stdout was
  // truncated by `| head`, `| tail`, or buffered until exit.
  const logPath = resolveLogPath();
  let logStream = null;
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logStream = fs.createWriteStream(logPath, { flags: 'w' });
    } catch (err) {
      process.stderr.write(
        `review.js: could not open log file '${logPath}': ${err.message}\n`
      );
      logStream = null;
    }
  }

  const stdoutSuppressed = !!logStream && !process.stdout.isTTY;
  if (logStream) {
    const header = [
      `# review.js ${engine}${model ? ` (${model})` : ''}`,
      `# cwd: ${cwd}`,
      `# started: ${new Date(started).toISOString()}`,
      `# prompt-bytes: ${Buffer.byteLength(combinedPrompt, 'utf8')}`,
      `# timeout: ${timeoutSec}s, heartbeat: ${heartbeatSec}s`,
      diffSpec
        ? `# diff: ${diffSpec}`
        : filePaths.length
          ? `# file: ${filePaths.join(', ')}`
          : '# scope: prompt-only',
      '',
    ].join('\n');
    logStream.write(header);
    // Print a loud banner on BOTH stdout and stderr so it survives any kind
    // of agent-side stream redirection — `| tail -N`, `2>/dev/null`,
    // `> file`, etc. The banner explicitly tells the caller to Read the log
    // path rather than scrape the command output.
    const banner = stdoutSuppressed
      ? [
          '===========================================================',
          `REVIEW IN PROGRESS — ${engine}${model ? ` (${model})` : ''}`,
          `LOG FILE: ${logPath}`,
          `TIMEOUT: ${timeoutSec}s, HEARTBEAT: ${heartbeatSec}s`,
          'Engine output is being written to the log file only.',
          'After this command exits, use the Read tool on the LOG FILE path',
          'above to retrieve the full review. A short tail will be printed',
          'on stdout after the engine exits.',
          '===========================================================',
        ].join('\n')
      : `review.js: logging to ${logPath} (tee'd)`;
    process.stdout.write(banner + '\n');
    process.stderr.write(`review.js: logging to ${logPath}\n`);
  }

  const result = await runEngine(cmd, args, logStream);
  const dur = ((Date.now() - started) / 1000).toFixed(1);

  // Output-quality verdict — only for a CLEAN exit (no launch error, no
  // timeout, status 0). An engine that "succeeds" yet returns nothing, or
  // returns text without the structured-output envelope, is silently useless
  // (an empty review reported as success). Computed here, before the log is
  // closed, so the note also lands in the log trailer.
  //   - 0 bytes              → always flagged (empty output is never useful)
  //   - no envelope, wrapped → flagged unless --no-wrap (no envelope expected)
  let qualityExit = null;
  let qualityNote = '';
  if (!result.error && !result.killedByTimeout && result.status === 0) {
    if ((result.totalBytes ?? 0) === 0) {
      qualityExit = EXIT_NO_OUTPUT;
      qualityNote =
        `engine '${engine}' exited 0 but produced NO OUTPUT — possible ` +
        'upstream model unavailability, or the sandbox blocked all reads';
    } else if (!noWrap && !result.sawEnvelope) {
      qualityExit = EXIT_NO_OUTPUT;
      qualityNote =
        `engine '${engine}' exited 0 with output but NO ` +
        '<<<SECOND_OPINION_START>>> envelope — likely truncated, refused, or ' +
        'sandbox-blocked';
    }
  }

  if (logStream) {
    const trailer =
      `\n\n# exit: ${result.status ?? 'unknown'} duration: ${dur}s` +
      (result.killedByTimeout ? ' (timeout)' : '') +
      (qualityExit !== null ? `\n# NO USABLE OUTPUT: ${qualityNote}` : '') +
      '\n';
    logStream.write(trailer);
    await new Promise((r) => logStream.end(r));
    let bytes = 0;
    try {
      bytes = fs.statSync(logPath).size;
    } catch {
      /* ignore */
    }
    const finalLine = `REVIEW COMPLETE — read with Read tool: ${logPath} (${bytes}B, exit=${result.status ?? 'unknown'}, ${dur}s${result.killedByTimeout ? ', TIMEOUT' : ''})`;
    process.stdout.write(finalLine + '\n');
    process.stderr.write(
      `review.js: log ${logPath} (${bytes}B, exit=${result.status ?? 'unknown'}, ${dur}s${result.killedByTimeout ? ', TIMEOUT' : ''})\n`
    );
  }

  if (result.error) {
    if (result.error.code === 'E2BIG') {
      process.stderr.write(
        `review.js: argv too large for OS (E2BIG). Lower PROMPT_BYTE_LIMIT or narrow the diff range.\n`
      );
      process.exit(1);
    }
    process.stderr.write(
      `review.js: failed to launch '${engine}': ${result.error.message}\n`
    );
    process.exit(1);
  }
  // Timeout exits with a distinct code (124, matching GNU `timeout`).
  if (result.killedByTimeout) process.exit(124);
  // Clean exit but no usable output → dedicated EXIT_NO_OUTPUT (see above).
  if (qualityExit !== null) {
    process.stderr.write(
      `review.js: ${qualityNote}. Treating as failure (exit ${qualityExit}).\n`
    );
    process.exit(qualityExit);
  }
  process.exit(result.status ?? 1);
}

// Run `worker(item, idx)` over `items` with at most `limit` in flight at once.
// Results preserve item order. limit === Infinity runs everything at once
// (Promise.all equivalent — the historical fusion behavior). Workers are
// expected to resolve (never reject), matching the fusion child contract.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  const lanes = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  async function lane() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

// Fusion mode: spawn one child review.js per engine. By default every slot
// runs at once; --concurrency=<n> caps how many run in parallel (1 = strictly
// serial, for rate-limited providers). Each child goes through the normal
// single-engine codepath (log file, output envelope, safety flags, etc.) —
// the parent only orchestrates and aggregates.
async function runFusion() {
  const tmp = (process.env.TMPDIR || '/tmp').replace(/\/+$/, '');
  const fusionDir = path.join(tmp, `second-opinion-fusion-${Date.now()}`);
  try {
    fs.mkdirSync(fusionDir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `review.js: could not create fusion dir ${fusionDir}: ${err.message}\n`
    );
    return 1;
  }

  // Strip --engine, --model, and --log from the inherited argv. The parent
  // re-injects them per child. Everything else (--cwd, --diff, --file,
  // --unrestricted, --no-embed, --no-wrap, --timeout, --heartbeat,
  // --engine-arg=..., --, the prompt) flows through unchanged.
  //
  // Args after a bare `--` are extraEngineArgs and must be passed through
  // verbatim — they may legitimately contain '--engine=', '--model=', or
  // '--log=' tokens intended for the engine CLI itself, not review.js.
  const stripped = [];
  let pastDoubleDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!pastDoubleDash && a === '--') {
      pastDoubleDash = true;
      stripped.push(a);
      continue;
    }
    if (
      !pastDoubleDash &&
      (a.startsWith('--engine=') ||
        a.startsWith('--model=') ||
        a.startsWith('--log=') ||
        a.startsWith('--concurrency='))
    ) {
      continue;
    }
    stripped.push(a);
  }

  // Build collision-free log filenames. Same engine with different models is
  // allowed, so encode the model in the filename when present.
  function slotLogName(slot) {
    if (!slot.model) return `${slot.engine}.log`;
    const safe = slot.model.replace(/[^A-Za-z0-9._-]/g, '_');
    return `${slot.engine}__${safe}.log`;
  }

  const slotPaths = slots.map((s) => ({
    ...s,
    logPath: path.join(fusionDir, slotLogName(s)),
  }));

  const concurrencyLine = Number.isFinite(concurrency)
    ? `CONCURRENCY: ${concurrency} at a time${concurrency === 1 ? ' (serial)' : ''}`
    : 'CONCURRENCY: unbounded (all slots at once)';
  const banner = [
    '===========================================================',
    `FUSION REVIEW — ${slotPaths.length} slots`,
    `FUSION DIR: ${fusionDir}`,
    concurrencyLine,
    ...slotPaths.map(
      (s) => `  ${s.engine}${s.model ? ` (${s.model})` : ''}: ${s.logPath}`
    ),
    'Read each log file after exit; each log is',
    'wrapped with <<<SECOND_OPINION_START/END>>> markers (unless --no-wrap).',
    '===========================================================',
  ].join('\n');
  process.stdout.write(banner + '\n');
  process.stderr.write(`review.js: fusion dir ${fusionDir}\n`);

  // Track every spawned child so a parent-level signal (SIGINT/SIGTERM) can
  // tear them all down together. Without this, Ctrl-C on the parent leaves
  // children running headless in the background, eating quota and ignoring
  // user intent.
  const liveChildren = new Set();
  function reapAll(signal) {
    for (const c of liveChildren) {
      try {
        c.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
  let forwardedSignal = null;
  function onParentSignal(sig) {
    if (forwardedSignal) return;
    forwardedSignal = sig;
    process.stderr.write(
      `review.js: fusion: received ${sig}, forwarding to ${liveChildren.size} child(ren)\n`
    );
    reapAll('SIGTERM');
    // Grace then SIGKILL anything still alive.
    setTimeout(() => reapAll('SIGKILL'), KILL_GRACE_MS).unref();
  }
  process.on('SIGINT', onParentSignal);
  process.on('SIGTERM', onParentSignal);

  // Parent-level heartbeat. Children are stdio-silenced, so the parent
  // process is otherwise inert from the caller's perspective for the full
  // duration of the slowest engine. Emit one short stderr line every
  // heartbeatSec while any child is alive, so the caller (and `tail -f` on
  // the user's terminal) can tell the run hasn't hung. Disabled by
  // --heartbeat=0.
  const fusionStarted = Date.now();
  let fusionHeartbeatTimer = null;
  if (heartbeatSec > 0) {
    fusionHeartbeatTimer = setInterval(() => {
      const alive = liveChildren.size;
      if (alive === 0) return;
      const elapsed = Math.round((Date.now() - fusionStarted) / 1000);
      process.stderr.write(
        `review.js: fusion: ${alive}/${slotPaths.length} alive +${elapsed}s ` +
          `(read logs in ${fusionDir} for engine output)\n`
      );
    }, heartbeatSec * 1000);
    if (fusionHeartbeatTimer.unref) fusionHeartbeatTimer.unref();
  }

  // Wrap the await in try/finally so the SIGINT/SIGTERM handlers and the
  // heartbeat interval get torn down even if an unexpected error reaches
  // here. (Child promises only resolve, never reject, so a leak is
  // unlikely in practice — but unref'd or not, leaving a setInterval
  // running past its scope is sloppy.)
  let results;
  try {
    results = await runPool(slotPaths, concurrency, (s) => {
      // Pass the slot's (engine, model) inline as a single --engine=name:model
      // arg. --model= no longer exists at the CLI surface.
      const childArgs = [
        __filename,
        ...stripped,
        `--engine=${s.engine}${s.model ? `:${s.model}` : ''}`,
        `--log=${s.logPath}`,
      ];
      return new Promise((resolve) => {
        // Suppress child stdio entirely. Each child's log file is opened
        // via fs.createWriteStream and captures engine stdout AND stderr
        // independently of the process pipes, so nothing useful is lost.
        // Inheriting would surface the per-child "REVIEW IN PROGRESS"
        // banner, heartbeats, and engine-output tail to the parent — all
        // already captured in the log. For an agent harness that reads
        // the parent's stdout, that doubles token usage for no signal.
        const child = spawn(process.execPath, childArgs, {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        liveChildren.add(child);
        child.on('exit', (code, signal) => {
          liveChildren.delete(child);
          resolve({
            slot: s,
            code: signal ? 128 + (signum(signal) || 0) : (code ?? 1),
            signal,
          });
        });
        child.on('error', (err) => {
          liveChildren.delete(child);
          process.stderr.write(
            `review.js: fusion child for '${s.engine}' failed to spawn: ${err.message}\n`
          );
          resolve({ slot: s, code: 1, err });
        });
      });
    });
  } finally {
    process.off('SIGINT', onParentSignal);
    process.off('SIGTERM', onParentSignal);
    if (fusionHeartbeatTimer) clearInterval(fusionHeartbeatTimer);
  }

  const trailer = [
    '',
    '===========================================================',
    'FUSION COMPLETE',
    ...results.map((r) => {
      // Annotate each slot's exit code: 124 = timeout, EXIT_NO_OUTPUT (3) =
      // engine ran but returned nothing usable (empty / no envelope), any
      // other non-zero = engine-reported failure.
      const label =
        r.code === 124
          ? ' (TIMEOUT)'
          : r.code === EXIT_NO_OUTPUT
            ? ' (NO USABLE OUTPUT — empty or missing envelope)'
            : r.code !== 0
              ? ' (FAILED)'
              : '';
      return (
        `  ${r.slot.engine}${r.slot.model ? ` (${r.slot.model})` : ''}: ` +
        `exit=${r.code}${label} log=${r.slot.logPath}`
      );
    }),
    `Read each log with the Read tool and extract the LAST complete`,
    `<<<SECOND_OPINION_START>>> … <<<SECOND_OPINION_END>>> pair (engines may`,
    `echo the format instructions or duplicate output; the last pair is the answer).`,
    '===========================================================',
  ].join('\n');
  process.stdout.write(trailer + '\n');

  // Aggregate exit code: 124 (timeout) dominates, then any non-zero, then 0.
  const codes = results.map((r) => r.code);
  if (codes.includes(124)) return 124;
  return codes.find((c) => c !== 0) ?? 0;
}

(async () => {
  try {
    if (isFusion) {
      const code = await runFusion();
      process.exit(code);
    } else {
      await main();
    }
  } catch (err) {
    process.stderr.write(
      `review.js: unexpected error: ${err.stack || err.message}\n`
    );
    process.exit(1);
  }
})();
