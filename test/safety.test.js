#!/usr/bin/env node
/**
 * Safety test for bin/review.js
 * Verifies that each engine uses its required read-only/sandbox flags.
 * Engines launch from the repo directory via --cwd and read content natively.
 * Prevents accidental removal of safety flags when modifying engines.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const reviewScript = path.join(__dirname, '..', 'bin', 'review.js');

// Define required flags per engine
const requiredFlags = {
  opencode: ['--agent', 'plan'],
  gemini: ['--approval-mode', 'plan', '-s'],
  codex: ['-s', 'read-only'],
  copilot: ['--plan', '--deny-tool=write'],
  qwen: ['-s', '--approval-mode', 'plan'],
  kilo: ['--agent', 'plan'],
};

// Read the review script
let content;
try {
  content = fs.readFileSync(reviewScript, 'utf8');
} catch (err) {
  console.error(`FAIL: Could not read ${reviewScript}: ${err.message}`);
  process.exit(1);
}

let allPass = true;

// Check each engine
for (const [engine, flags] of Object.entries(requiredFlags)) {
  // Find the case block for this engine
  const caseRegex = new RegExp(`case\\s+'${engine}':[\\s\\S]*?(?=case\\s+|default:|^(?!\\s))`, 'm');
  const caseMatch = content.match(caseRegex);

  if (!caseMatch) {
    console.log(`FAIL [${engine}]: engine case block not found`);
    allPass = false;
    continue;
  }

  const caseBlock = caseMatch[0];
  let enginePass = true;

  // Check for each required flag
  for (const flag of flags) {
    const quoted = `'${flag}'`;
    const doubleQuoted = `"${flag}"`;
    if (!caseBlock.includes(quoted) && !caseBlock.includes(doubleQuoted)) {
      console.log(`FAIL [${engine}]: missing flag '${flag}'`);
      enginePass = false;
      allPass = false;
    }
  }

  if (enginePass) {
    console.log(`PASS [${engine}]`);
  }
}

process.exit(allPass ? 0 : 1);
