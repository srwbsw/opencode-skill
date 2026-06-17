#!/usr/bin/env node
/**
 * Unit test for bin/env-guard.js — the secret-file matcher review.js uses to
 * keep .env contents out of engine prompts. Verifies the .env / .env.* / *.env
 * patterns match, the example/sample/template exemption holds, directory
 * components are ignored, and look-alikes (environment.yml, .envrc) do not
 * match.
 */

'use strict';

const { isLikelyEnvSecret } = require('../bin/env-guard');

// [input, expected]
const cases = [
  // canonical + variants → secret
  ['.env', true],
  ['.env.local', true],
  ['.env.production', true],
  ['.env.production.local', true],
  ['prod.env', true],
  ['local.env', true],
  ['/abs/path/to/.env', true],
  ['nested/dir/.env.staging', true],
  ['C:\\win\\path\\.env', true],
  // exemptions → not a secret
  ['.env.example', false],
  ['example.env', false],
  ['.env.sample', false],
  ['env.sample', false],
  ['.env.template', false],
  ['.env.EXAMPLE', false], // case-insensitive
  ['/repo/.env.example', false],
  // look-alikes / unrelated → not a secret
  ['environment.yml', false],
  ['prevent.txt', false],
  ['.envrc', false], // direnv — out of scope by design
  ['readme.md', false],
  ['env', false],
  ['', false],
  [null, false],
  [undefined, false],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const got = isLikelyEnvSecret(input);
  if (got === expected) {
    pass += 1;
    console.log(`PASS [${JSON.stringify(input)}] → ${got}`);
  } else {
    fail += 1;
    console.log(
      `FAIL [${JSON.stringify(input)}]: expected ${expected}, got ${got}`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
