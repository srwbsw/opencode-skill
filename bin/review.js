#!/usr/bin/env node
// second-opinion-skill review runner
// Usage: review.js --engine=<engine> [--model=<model>] --cwd=<path>
//                  [--diff=<spec> | --file=<path>] "<prompt>"
//                  [--engine-arg=<arg> ... | -- <engine-args...>]
// Engines: opencode, gemini, codex, claude, copilot, qwen, kilo
//
// --diff=<spec> shortcuts (review.js runs git in --cwd):
//   unstaged     → git diff
//   staged       → git diff --staged
//   last-commit  → git diff HEAD~1
//   branch       → git diff origin/main..HEAD (fallback: HEAD~1..HEAD)
//   <custom>     → git diff <custom>        (e.g. "HEAD~3..HEAD")
//
// --file=<path>  Read file content from disk.
//
// Diff/file content is embedded directly in the prompt as a <diff> or <file>
// block. No temp files written, no model-side file reads, no sandbox carve-outs.
// Engines without shell access (gemini, qwen) and sandboxed engines (codex,
// opencode) all get the same deterministic inline content.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const { shellQuote } = require('./shell-quote');

let engine = '';
let model = '';
let cwd = process.cwd();
let diffSpec = '';
let filePath = '';
let prompt = '';
let extraEngineArgs = [];
let showHelp = false;

const argv = process.argv.slice(2);

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  review.js --engine=<engine> [--model=<model>] --cwd=<path> [--diff=<spec> | --file=<path>] "<prompt>"',
      '            [--engine-arg=<arg> ... | -- <engine-args...>]',
      '',
      'Engines:',
      '  opencode, gemini, codex, claude, copilot, qwen, kilo',
      '',
      'Diff/file shortcuts:',
      '  --diff=unstaged     git diff',
      '  --diff=staged       git diff --staged',
      '  --diff=last-commit  git diff HEAD~1',
      '  --diff=branch       git diff origin/main..HEAD (fallback: HEAD~1..HEAD)',
      '  --diff=<range>      git diff <range>',
      '  --file=<path>       review a specific file',
      '',
      'Extra engine args:',
      '  --engine-arg=<arg>  Forward one extra arg to the engine CLI (repeatable)',
      '  --                  Forward all remaining args to the engine CLI',
      '',
      'Examples:',
      '  review.js --engine=claude --cwd=. "Review this" --engine-arg=--verbose',
      '  review.js --engine=codex --cwd=. "Review this" -- --model o3',
    ].join('\n') + '\n'
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
  else if (arg.startsWith('--engine=')) engine = arg.slice('--engine='.length);
  else if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
  else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
  else if (arg.startsWith('--diff=')) diffSpec = arg.slice('--diff='.length);
  else if (arg.startsWith('--file=')) filePath = arg.slice('--file='.length);
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
];

if (!engine) {
  printHelp();
  process.exit(1);
}

if (!SUPPORTED_ENGINES.includes(engine)) {
  process.stderr.write(`review.js: unknown engine '${engine}'\n`);
  process.stderr.write(`Supported engines: ${SUPPORTED_ENGINES.join(', ')}\n`);
  process.exit(1);
}

if (!prompt) {
  process.stderr.write(
    'review.js: prompt is required as a positional argument\n'
  );
  process.exit(1);
}

if (diffSpec && filePath) {
  process.stderr.write('review.js: --diff and --file are mutually exclusive\n');
  process.exit(1);
}

// Fetch raw diff content for a given spec. Returns the string.
function fetchDiffContent(spec) {
  const shortcuts = {
    unstaged: ['diff'],
    staged: ['diff', '--staged'],
    'last-commit': ['diff', 'HEAD~1'],
    branch: ['diff', 'origin/main..HEAD'],
  };
  let args = shortcuts[spec] ?? ['diff', spec];

  let result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  // Fallback for branch: if origin/main..HEAD fails, try HEAD~1..HEAD
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

  if (!result.stdout.trim()) {
    process.stderr.write(
      `review.js: git ${args.join(' ')} produced no output — nothing to review\n`
    );
    process.exit(1);
  }

  return result.stdout;
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

let combinedPrompt = prompt;

if (diffSpec) {
  const diffContent = escapeForBlock(fetchDiffContent(diffSpec), 'diff');
  combinedPrompt = `<diff>\n${diffContent}\n</diff>\n\nReview the diff above. Then:\n\n${prompt}`;
} else if (filePath) {
  const fileContent = escapeForBlock(readFileContent(filePath), 'file');
  combinedPrompt = `<file path="${filePath}">\n${fileContent}\n</file>\n\nReview the file above. Then:\n\n${prompt}`;
}

checkPromptSize(combinedPrompt);

// Many engine CLIs (codex exec, claude --print, gemini -p, etc.) detect a
// non-TTY stdout and buffer output until completion. When review.js is run
// from a background shell (CI, agent harness, `&`), this produces long silent
// stretches that look like a hang. We allocate a pseudo-TTY so each chunk
// streams as it is produced.
//
// Streaming strategy (in order of preference):
//   1. vendored node-pty (darwin only)  — in-process PTY, works regardless of
//                                         parent stdio type. Prebuilt binaries
//                                         shipped under vendor/node-pty/.
//   2. `script` command                 — BSD on macOS (requires TTY stdin),
//                                         util-linux on Linux (no TTY needed).
//   3. direct spawn                     — last resort; output buffered by CLI.
function spawnDirect(cmd, args) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  return { status: r.status, error: r.error };
}

function spawnViaScript(cmd, args) {
  const scriptArgs =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', cmd, ...args]
      : ['-qfc', [cmd, ...args].map(shellQuote).join(' '), '/dev/null'];
  const r = spawnSync('script', scriptArgs, { cwd, stdio: 'inherit' });
  return { status: r.status, error: r.error };
}

function tryLoadVendoredPty() {
  // Vendored prebuilds only cover darwin-{arm64,x64}. Anything else falls
  // through to the script/direct path.
  if (process.platform !== 'darwin') return null;
  if (!['arm64', 'x64'].includes(process.arch)) return null;

  const path = require('path');
  const vendorPath = path.join(__dirname, '..', 'vendor', 'node-pty');
  try {
    fs.statSync(vendorPath);
  } catch {
    return null;
  }

  // Ensure spawn-helper has its executable bit. Git preserves the mode bit,
  // but some download/extract paths (pnpm + prebuild-install in particular)
  // strip it, and we want the loader to be self-healing.
  try {
    const helper = path.join(
      vendorPath,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    );
    const st = fs.statSync(helper);
    if (!(st.mode & 0o111)) fs.chmodSync(helper, 0o755);
  } catch {
    return null;
  }

  try {
    return require(vendorPath);
  } catch {
    return null;
  }
}

function spawnViaPty(pty, cmd, args) {
  return new Promise((resolve) => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    let term;
    try {
      term = pty.spawn(cmd, args, {
        name: process.env.TERM || 'xterm-256color',
        cols,
        rows,
        cwd,
        env: process.env,
      });
    } catch (err) {
      resolve({ status: null, error: err });
      return;
    }

    term.onData((d) => process.stdout.write(d));

    const onResize = () => {
      try {
        term.resize(
          process.stdout.columns || cols,
          process.stdout.rows || rows
        );
      } catch {
        /* ignore */
      }
    };
    if (process.stdout.isTTY) process.stdout.on('resize', onResize);

    let stdinForward;
    if (process.stdin.isTTY) {
      stdinForward = (chunk) => term.write(chunk.toString('utf8'));
      process.stdin.on('data', stdinForward);
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
      process.stdin.resume();
    }

    const cleanup = () => {
      if (process.stdout.isTTY) process.stdout.off('resize', onResize);
      if (stdinForward) {
        process.stdin.off('data', stdinForward);
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
        process.stdin.pause();
      }
    };

    term.onExit(({ exitCode, signal }) => {
      cleanup();
      resolve({ status: signal ? 128 + signal : exitCode, error: null });
    });
  });
}

async function runWithStreaming(cmd, args) {
  if (process.platform === 'win32') return spawnDirect(cmd, args);

  // Already on a TTY — engine streams natively, no wrapping needed.
  if (process.stdout.isTTY) return spawnDirect(cmd, args);

  // Try vendored node-pty first. Works regardless of parent stdio type.
  const pty = tryLoadVendoredPty();
  if (pty) {
    const r = await spawnViaPty(pty, cmd, args);
    if (!r.error) return r;
  }

  // BSD `script` (macOS) cannot run when stdin is not a TTY. Linux util-linux
  // `script -qfc` works without a TTY on stdin.
  if (process.platform === 'darwin' && !process.stdin.isTTY) {
    return spawnDirect(cmd, args);
  }

  const r = spawnViaScript(cmd, args);
  if (r.error && r.error.code === 'ENOENT') {
    process.stderr.write(
      "review.js: 'script' not found and vendored PTY unavailable; running without PTY (output may buffer)\n"
    );
    return spawnDirect(cmd, args);
  }
  return r;
}

async function main() {
  let result;

  switch (engine) {
    case 'opencode':
      if (!model) {
        process.stderr.write(
          'review.js: opencode requires --model=<provider/model>\n'
        );
        process.exit(1);
      }
      result = await runWithStreaming('opencode', [
        'run',
        '--model',
        model,
        '--agent',
        'plan',
        ...extraEngineArgs,
        combinedPrompt,
      ]);
      break;

    case 'gemini':
      result = await runWithStreaming('gemini', [
        '-s',
        '--approval-mode',
        'plan',
        ...extraEngineArgs,
        '-p',
        combinedPrompt,
      ]);
      break;

    case 'codex': {
      const codexArgs = ['exec', '-s', 'read-only'];
      if (model) codexArgs.push('-m', model);
      codexArgs.push(...extraEngineArgs);
      codexArgs.push(combinedPrompt);
      result = await runWithStreaming('codex', codexArgs);
      break;
    }

    case 'claude': {
      const claudeArgs = ['--print', '--permission-mode', 'plan'];
      if (model) claudeArgs.push('--model', model);
      claudeArgs.push(...extraEngineArgs);
      claudeArgs.push(combinedPrompt);
      result = await runWithStreaming('claude', claudeArgs);
      break;
    }

    case 'copilot': {
      const copilotArgs = [
        '-s',
        '--plan',
        '--allow-all-tools',
        '--deny-tool=write',
      ];
      if (model) copilotArgs.push('--model', model);
      copilotArgs.push(...extraEngineArgs, '-p', combinedPrompt);
      result = await runWithStreaming('copilot', copilotArgs);
      break;
    }

    case 'qwen': {
      const qwenArgs = ['-s', '--approval-mode', 'plan'];
      if (model) qwenArgs.push('-m', model);
      qwenArgs.push(...extraEngineArgs);
      qwenArgs.push(combinedPrompt);
      result = await runWithStreaming('qwen', qwenArgs);
      break;
    }

    case 'kilo': {
      const kiloArgs = ['run', '--agent', 'plan'];
      if (model) kiloArgs.push('-m', model);
      kiloArgs.push(...extraEngineArgs);
      kiloArgs.push(combinedPrompt);
      result = await runWithStreaming('kilo', kiloArgs);
      break;
    }
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
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  process.stderr.write(
    `review.js: unexpected error: ${err.stack || err.message}\n`
  );
  process.exit(1);
});
