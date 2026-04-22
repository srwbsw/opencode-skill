#!/usr/bin/env node
// second-opinion-skill review runner
// Usage: review.js --engine=<engine> [--model=<model>] --cwd=<path> "<prompt>"
// Engines: opencode, gemini, codex

'use strict';

const { spawnSync } = require('child_process');

let engine = '';
let model = '';
let cwd = process.cwd();
let prompt = '';

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--engine=')) {
    engine = arg.slice('--engine='.length);
  } else if (arg.startsWith('--model=')) {
    model = arg.slice('--model='.length);
  } else if (arg.startsWith('--cwd=')) {
    cwd = arg.slice('--cwd='.length);
  } else {
    prompt = arg;
  }
}

if (!engine) {
  process.stderr.write('Usage: review.js --engine=<engine> [--model=<model>] [--cwd=<path>] "<prompt>"\n');
  process.exit(1);
}

if (!prompt) {
  process.stderr.write('review.js: prompt is required as a positional argument\n');
  process.exit(1);
}

let result;

switch (engine) {
  case 'opencode':
    if (!model) {
      process.stderr.write('review.js: opencode requires --model=<provider/model>\n');
      process.exit(1);
    }
    result = spawnSync('opencode', ['run', '--model', model, '--agent', 'plan', prompt], {
      cwd,
      stdio: 'inherit',
    });
    break;

  case 'gemini':
    result = spawnSync('gemini', ['-s', '--approval-mode', 'plan', '-p', prompt], {
      cwd,
      stdio: 'inherit',
    });
    break;

  case 'codex': {
    const codexArgs = ['exec', '-s', 'read-only'];
    if (model) {
      codexArgs.push('-m', model);
    }
    codexArgs.push(prompt);
    result = spawnSync('codex', codexArgs, { cwd, stdio: 'inherit' });
    break;
  }

  default:
    process.stderr.write(`review.js: unknown engine '${engine}'\n`);
    process.stderr.write('Supported engines: opencode, gemini, codex\n');
    process.exit(1);
}

if (result.error) {
  process.stderr.write(`review.js: failed to launch '${engine}': ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
