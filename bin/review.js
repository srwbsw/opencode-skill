#!/usr/bin/env node
// second-opinion-skill review runner
// Usage: review.js --engine=<engine> [--model=<model>] --cwd=<path>
//                  [--diff=<spec> | --file=<path>] "<prompt>"
// Engines: opencode, gemini, codex, copilot, qwen, kilo
//
// --diff=<spec> shortcuts (review.js runs git in --cwd and writes a temp file):
//   unstaged     → git diff
//   staged       → git diff --staged
//   last-commit  → git diff HEAD~1
//   branch       → git diff origin/main..HEAD (fallback: HEAD~1..HEAD)
//   <custom>     → git diff <custom>        (e.g. "HEAD~3..HEAD")
//
// --file=<path>  Engine reads that file directly (no temp file created).
//
// When --diff or --file is used, review.js prepends a read instruction to the
// prompt so every engine — including those without shell access (gemini, qwen) —
// can review via its file-read tool.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let engine = '';
let model = '';
let cwd = process.cwd();
let diffSpec = '';
let filePath = '';
let prompt = '';

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--engine=')) engine = arg.slice('--engine='.length);
  else if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
  else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
  else if (arg.startsWith('--diff=')) diffSpec = arg.slice('--diff='.length);
  else if (arg.startsWith('--file=')) filePath = arg.slice('--file='.length);
  else prompt = arg;
}

if (!engine) {
  process.stderr.write(
    'Usage: review.js --engine=<engine> [--model=<model>] [--cwd=<path>] ' +
      '[--diff=<spec> | --file=<path>] "<prompt>"\n'
  );
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

// Fetch diff content and write to a temp file. Returns the temp file path.
function fetchDiffToTempFile(spec) {
  const shortcuts = {
    unstaged: ['diff'],
    staged: ['diff', '--staged'],
    'last-commit': ['diff', 'HEAD~1'],
    branch: ['diff', 'origin/main..HEAD'],
  };
  let args;
  if (shortcuts[spec]) {
    args = shortcuts[spec];
  } else {
    // Custom spec — pass as raw arg to git diff, e.g. "HEAD~3..HEAD"
    args = ['diff', spec];
  }

  let result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  // Fallback for branch: if origin/main..HEAD fails, try HEAD~1..HEAD
  if (spec === 'branch' && result.status !== 0) {
    result = spawnSync('git', ['diff', 'HEAD~1..HEAD'], { cwd, encoding: 'utf8' });
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

  const tmpFile = path.join(os.tmpdir(), `review-${Date.now()}-${process.pid}.diff`);
  fs.writeFileSync(tmpFile, result.stdout);
  return tmpFile;
}

let tempFile = '';
let combinedPrompt = prompt;

if (diffSpec) {
  tempFile = fetchDiffToTempFile(diffSpec);
  combinedPrompt =
    `Use your file-read tool to read the git diff at ${tempFile} (do not attempt shell commands). Then:\n\n` +
    prompt;
} else if (filePath) {
  combinedPrompt =
    `Use your file-read tool to read ${filePath} (do not attempt shell commands). Then:\n\n` + prompt;
}

function cleanup() {
  if (tempFile) {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', cleanup);

let result;

switch (engine) {
  case 'opencode':
    if (!model) {
      process.stderr.write('review.js: opencode requires --model=<provider/model>\n');
      process.exit(1);
    }
    result = spawnSync('opencode', ['run', '--model', model, '--agent', 'plan', combinedPrompt], {
      cwd,
      stdio: 'inherit',
    });
    break;

  case 'gemini':
    result = spawnSync('gemini', ['-s', '--approval-mode', 'plan', '-p', combinedPrompt], {
      cwd,
      stdio: 'inherit',
    });
    break;

  case 'codex': {
    const codexArgs = ['exec', '-s', 'read-only'];
    if (model) codexArgs.push('-m', model);
    codexArgs.push(combinedPrompt);
    result = spawnSync('codex', codexArgs, { cwd, stdio: 'inherit' });
    break;
  }

  case 'copilot': {
    const copilotArgs = ['-p', combinedPrompt, '-s', '--plan', '--allow-all-tools', '--deny-tool=write'];
    if (model) copilotArgs.push('--model', model);
    result = spawnSync('copilot', copilotArgs, { cwd, stdio: 'inherit' });
    break;
  }

  case 'qwen': {
    const qwenArgs = ['-s', '--approval-mode', 'plan'];
    if (model) qwenArgs.push('-m', model);
    qwenArgs.push(combinedPrompt);
    result = spawnSync('qwen', qwenArgs, { cwd, stdio: 'inherit' });
    break;
  }

  case 'kilo': {
    const kiloArgs = ['run', '--agent', 'plan'];
    if (model) kiloArgs.push('-m', model);
    kiloArgs.push(combinedPrompt);
    result = spawnSync('kilo', kiloArgs, { cwd, stdio: 'inherit' });
    break;
  }

  default:
    process.stderr.write(`review.js: unknown engine '${engine}'\n`);
    process.stderr.write('Supported engines: opencode, gemini, codex, copilot, qwen, kilo\n');
    process.exit(1);
}

if (result.error) {
  process.stderr.write(`review.js: failed to launch '${engine}': ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
