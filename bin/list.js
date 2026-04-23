#!/usr/bin/env node
// second-opinion-skill model/provider discovery
// Usage: list.js --engine=<engine> <command> [--provider=<provider>]
// Commands: providers, models
// Engines: opencode, kilo
//
// Output rules (baked into the script so the LLM doesn't have to):
//   - opencode providers: 'opencode' first (default), then alphabetical
//   - opencode models:    dated preview variants stripped
//                         (-preview-MM-DD or -YYYY-MM-DD patterns)
//   - kilo models:        free models first (lines matching 'free$'),
//                         then paid, each group sorted alphabetically

'use strict';

const { spawnSync } = require('child_process');

let engine = '';
let provider = '';
let command = '';

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--engine=')) engine = arg.slice('--engine='.length);
  else if (arg.startsWith('--provider=')) provider = arg.slice('--provider='.length);
  else command = arg;
}

if (!engine || !command) {
  process.stderr.write('Usage: list.js --engine=<engine> <command> [--provider=<provider>]\n');
  process.stderr.write('Commands: providers, models\n');
  process.stderr.write('Engines:  opencode, kilo\n');
  process.exit(1);
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function fetchModels(cli) {
  const result = spawnSync(cli, ['models', '--refresh'], { encoding: 'utf8' });
  if (result.error) {
    process.stderr.write(`list.js: failed to launch '${cli}': ${result.error.message}\n`);
    process.exit(1);
  }
  return (result.stdout + result.stderr).split('\n').map(stripAnsi);
}

function requireProvider() {
  if (!provider) {
    process.stderr.write(`list.js: --provider is required for 'models'\n`);
    process.exit(1);
  }
}

// Detect dated preview variants: -preview-MM-DD or -YYYY-MM-DD at end of name
const DATED_PREVIEW = /-preview-\d{2}-\d{2,4}$|-\d{4}-\d{2}-\d{2}$/;

// Detect free models: line ending in 'free' (handles ':free' and '/free')
const FREE_MODEL = /free$/;

switch (engine) {
  case 'opencode': {
    const lines = fetchModels('opencode').filter(l => l.includes('/') && !l.startsWith('['));

    if (command === 'providers') {
      const providers = [...new Set(lines.map(l => l.split('/')[0]).filter(Boolean))]
        .sort((a, b) => {
          if (a === 'opencode') return -1;
          if (b === 'opencode') return 1;
          return a.localeCompare(b);
        });
      console.log(providers.join('\n'));
    } else if (command === 'models') {
      requireProvider();
      const models = [...new Set(
        lines
          .filter(l => l.startsWith(`${provider}/`))
          .filter(l => !DATED_PREVIEW.test(l))
      )].sort();
      console.log(models.join('\n'));
    } else {
      process.stderr.write(`list.js: unknown command '${command}'\n`);
      process.exit(1);
    }
    break;
  }

  case 'kilo': {
    const lines = fetchModels('kilo').filter(l => l.startsWith('kilo/'));

    if (command === 'providers') {
      const providers = [...new Set(lines.map(l => l.split('/')[1]).filter(Boolean))].sort();
      console.log(providers.join('\n'));
    } else if (command === 'models') {
      requireProvider();
      const models = [...new Set(lines.filter(l => l.startsWith(`kilo/${provider}/`)))];
      const free = models.filter(l => FREE_MODEL.test(l)).sort();
      const paid = models.filter(l => !FREE_MODEL.test(l)).sort();
      console.log([...free, ...paid].join('\n'));
    } else {
      process.stderr.write(`list.js: unknown command '${command}'\n`);
      process.exit(1);
    }
    break;
  }

  default:
    process.stderr.write(`list.js: unknown engine '${engine}'\n`);
    process.stderr.write('Supported engines: opencode, kilo\n');
    process.exit(1);
}
