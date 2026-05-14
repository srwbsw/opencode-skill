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
  if (arg.startsWith('--engine-arg=')) extraEngineArgs.push(arg.slice('--engine-arg='.length));
  else if (arg.startsWith('--engine=')) engine = arg.slice('--engine='.length);
  else if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
  else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
  else if (arg.startsWith('--diff=')) diffSpec = arg.slice('--diff='.length);
  else if (arg.startsWith('--file=')) filePath = arg.slice('--file='.length);
  else if (!prompt) prompt = arg;
  else {
    process.stderr.write(`review.js: unexpected argument '${arg}'\n`);
    process.stderr.write('Use --engine-arg=<arg> or -- to pass extra engine-specific args.\n');
    process.exit(1);
  }
}

if (showHelp) {
  printHelp();
  process.exit(0);
}

const SUPPORTED_ENGINES = ['opencode', 'gemini', 'codex', 'claude', 'copilot', 'qwen', 'kilo'];

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
  process.stderr.write('review.js: prompt is required as a positional argument\n');
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
    process.stderr.write(`review.js: git ${args.join(' ')} produced no output — nothing to review\n`);
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
    process.stderr.write(`review.js: --file '${p}' looks binary (NUL byte detected); pass a text file or use --diff\n`);
    process.exit(1);
  }
  return buf.toString('utf8');
}

// Escape closing tags so embedded content cannot break out of the wrapper block.
function escapeForBlock(content, tag) {
  const close = `</${tag}>`;
  return content.split(close).join(`</​${tag}>`);
}

// Cap on the final combined prompt size. macOS ARG_MAX is ~256KB after env;
// Linux is typically 128KB-2MB. Stay well under the smallest realistic limit.
const PROMPT_BYTE_LIMIT = 200_000;

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
// stretches that look like a hang. Wrap the engine in `script` to allocate a
// pseudo-TTY so each chunk streams as it is produced.
//
// `script` syntax differs by platform:
//   macOS/BSD:   script -q /dev/null <cmd> [args...]
//   Linux/util-linux: script -qfc '<cmd args...>' /dev/null
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function runWithStreaming(cmd, args) {
  const wantPty = !process.stdout.isTTY && process.platform !== 'win32';
  if (!wantPty) {
    return spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  }
  if (process.platform === 'darwin') {
    return spawnSync('script', ['-q', '/dev/null', cmd, ...args], { cwd, stdio: 'inherit' });
  }
  // Linux: -f flushes output, -c takes the command as a shell string.
  const cmdline = [cmd, ...args].map(shellQuote).join(' ');
  return spawnSync('script', ['-qfc', cmdline, '/dev/null'], { cwd, stdio: 'inherit' });
}

let result;

switch (engine) {
  case 'opencode':
    if (!model) {
      process.stderr.write('review.js: opencode requires --model=<provider/model>\n');
      process.exit(1);
    }
    result = runWithStreaming('opencode', ['run', '--model', model, '--agent', 'plan', ...extraEngineArgs, combinedPrompt]);
    break;

  case 'gemini':
    result = runWithStreaming('gemini', ['-s', '--approval-mode', 'plan', ...extraEngineArgs, '-p', combinedPrompt]);
    break;

  case 'codex': {
    const codexArgs = ['exec', '-s', 'read-only'];
    if (model) codexArgs.push('-m', model);
    codexArgs.push(...extraEngineArgs);
    codexArgs.push(combinedPrompt);
    result = runWithStreaming('codex', codexArgs);
    break;
  }

  case 'claude': {
    const claudeArgs = ['--print', '--permission-mode', 'plan'];
    if (model) claudeArgs.push('--model', model);
    claudeArgs.push(...extraEngineArgs);
    claudeArgs.push(combinedPrompt);
    result = runWithStreaming('claude', claudeArgs);
    break;
  }

  case 'copilot': {
    const copilotArgs = ['-s', '--plan', '--allow-all-tools', '--deny-tool=write'];
    if (model) copilotArgs.push('--model', model);
    copilotArgs.push(...extraEngineArgs, '-p', combinedPrompt);
    result = runWithStreaming('copilot', copilotArgs);
    break;
  }

  case 'qwen': {
    const qwenArgs = ['-s', '--approval-mode', 'plan'];
    if (model) qwenArgs.push('-m', model);
    qwenArgs.push(...extraEngineArgs);
    qwenArgs.push(combinedPrompt);
    result = runWithStreaming('qwen', qwenArgs);
    break;
  }

  case 'kilo': {
    const kiloArgs = ['run', '--agent', 'plan'];
    if (model) kiloArgs.push('-m', model);
    kiloArgs.push(...extraEngineArgs);
    kiloArgs.push(combinedPrompt);
    result = runWithStreaming('kilo', kiloArgs);
    break;
  }
}

if (result.error) {
  process.stderr.write(`review.js: failed to launch '${engine}': ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
