#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const commitMsg = process.argv[2] || '';

function bumpType(msg) {
  if (/BREAKING[\s-]CHANGE|^[^:]+!:/.test(msg)) return 'major';
  if (/^feat(\(.+\))?:/.test(msg)) return 'minor';
  if (/^(fix|chore|refactor|perf)(\(.+\))?:/.test(msg)) return 'patch';
  return null;
}

function nextVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const type = bumpType(commitMsg);
if (!type) {
  console.log(`No version bump for: "${commitMsg}"`);
  process.exit(0);
}

// package.json
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const next = nextVersion(current, type);
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// marketplace.json
const mktPath = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const mkt = JSON.parse(fs.readFileSync(mktPath, 'utf8'));
mkt.metadata.version = next;
mkt.plugins[0].version = next;
fs.writeFileSync(mktPath, JSON.stringify(mkt, null, 2) + '\n');

console.log(`${type}: ${current} → ${next}`);
