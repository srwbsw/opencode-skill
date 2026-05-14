#!/usr/bin/env node
/**
 * Verify shellQuote is injection-safe by round-tripping hostile inputs
 * through /bin/sh -c. The shell must reproduce the exact original bytes.
 */

'use strict';

const { spawnSync } = require('child_process');
const { shellQuote } = require('../bin/shell-quote');

const cases = [
  'plain',
  '',
  "it's",
  "multi'ple's",
  '$(rm -rf /)',
  '`whoami`',
  '"double"',
  '\\backslash',
  'a; b && c | d',
  'new\nline',
  'tab\there',
  '*?[glob]',
  'all together: \'";`$()\\n',
  '--flag=value with spaces',
  "'''-leading",
];

let allPass = true;

for (const input of cases) {
  const cmd = `printf %s ${shellQuote(input)}`;
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(
      `FAIL [${JSON.stringify(input)}]: sh exit ${r.status}: ${r.stderr}`
    );
    allPass = false;
    continue;
  }
  if (r.stdout !== input) {
    console.log(
      `FAIL [${JSON.stringify(input)}]: got ${JSON.stringify(r.stdout)}`
    );
    allPass = false;
    continue;
  }
  console.log(`PASS [${JSON.stringify(input)}]`);
}

process.exit(allPass ? 0 : 1);
