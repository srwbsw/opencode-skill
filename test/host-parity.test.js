#!/usr/bin/env node
/**
 * Host parity test.
 *
 * Invariant (see skills/AGENTS.md → "Host parity"): the set of supported HOST
 * harnesses must equal the set of supported ENGINES. Every engine you can
 * review WITH must also be a harness you can install INTO.
 *
 * Source of truth:
 *   - engines: `SUPPORTED_ENGINES` in bin/review.js
 *   - hosts:   the `HOSTS=` line in install.sh
 * The cursor host corresponds to the `agent` engine (Cursor's CLI binary), so
 * the two names are treated as equivalent.
 *
 * If you add/remove an engine, add/remove the matching host in install.sh in
 * the same change — or record a documented exception in EXCEPTIONS below.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let allPass = true;
function record(name, ok, detail) {
  console.log(
    `${ok ? 'PASS' : 'FAIL'} [${name}]${ok || !detail ? '' : `: ${detail}`}`
  );
  if (!ok) allPass = false;
}

// Engines whose harness genuinely has no host/skill mechanism stay engine-only
// and are listed here with a reason (keeps them out of the parity diff).
const EXCEPTIONS = {};

// engine name → host name (and vice versa) normalization.
const ENGINE_TO_HOST = { agent: 'cursor' };

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const reviewJs = fs.readFileSync(path.join(root, 'bin', 'review.js'), 'utf8');
const installSh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');

// Extract SUPPORTED_ENGINES = [ '...', '...' ]
const engBlock = reviewJs.match(
  /const\s+SUPPORTED_ENGINES\s*=\s*\[([\s\S]*?)\]/
);
if (!engBlock) fail('SUPPORTED_ENGINES not found in bin/review.js');
const engines = [...engBlock[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map(
  (m) => ENGINE_TO_HOST[m[1]] || m[1]
);

// Extract HOSTS="a b c ..." from install.sh
const hostLine = installSh.match(/^HOSTS="([^"]+)"/m);
if (!hostLine) fail('HOSTS="..." not found in install.sh');
const hosts = hostLine[1].trim().split(/\s+/);

const engineSet = new Set(engines);
const hostSet = new Set(hosts);

// Every engine must be a host (or a recorded exception).
for (const e of engineSet) {
  const ok = hostSet.has(e) || e in EXCEPTIONS;
  record(
    `engine '${e}' has a host`,
    ok,
    `no host integration in install.sh (add it, or add to EXCEPTIONS)`
  );
}

// Every host must be a real engine — no orphan host entries.
for (const h of hostSet) {
  record(
    `host '${h}' maps to an engine`,
    engineSet.has(h),
    `install.sh installs into '${h}' but it is not a SUPPORTED_ENGINE`
  );
}

// Each non-exception host must have an actual install block in install.sh.
for (const h of hosts) {
  if (h in EXCEPTIONS) continue;
  record(
    `install.sh has a block for '${h}'`,
    new RegExp(`if want ${h};`).test(installSh),
    `no \`if want ${h};\` install block`
  );
}

process.exit(allPass ? 0 : 1);
