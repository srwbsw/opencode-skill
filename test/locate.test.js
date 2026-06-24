#!/usr/bin/env node
/**
 * Drift test for the "Locating the runner" snippet.
 *
 * `skills/AGENTS.md` owns the canonical PATH-first discovery blocks (REVIEW +
 * LIST) between `<!-- BEGIN locate-* -->` / `<!-- END locate-* -->` markers.
 * Every SKILL.md must embed the REVIEW block verbatim; any skill that uses
 * `$LIST_SCRIPT` must also embed the LIST block verbatim. This prevents the
 * per-skill divergence that crept in when each skill carried its own glob
 * chain (mismatched fallbacks, a missing `grep -v '\*'` guard, etc.).
 *
 * It also fails on stale phrasings/old block forms so a half-finished edit
 * cannot leave a skill on the previous resolution logic.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const skillsDir = path.join(__dirname, '..', 'skills');
const agentsMd = path.join(skillsDir, 'AGENTS.md');

let allPass = true;
function record(name, ok, detail) {
  if (ok) {
    console.log(`PASS [${name}]`);
  } else {
    console.log(`FAIL [${name}]${detail ? `: ${detail}` : ''}`);
    allPass = false;
  }
}

// Extract a fenced canonical block from skills/AGENTS.md by marker name.
function extractBlock(md, name) {
  const re = new RegExp(
    `<!-- BEGIN ${name} -->\\s*\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\`\\s*<!-- END ${name} -->`
  );
  const m = md.match(re);
  if (!m) {
    throw new Error(`canonical block '${name}' not found in skills/AGENTS.md`);
  }
  return m[1];
}

let agents;
try {
  agents = fs.readFileSync(agentsMd, 'utf8');
} catch (err) {
  console.error(`FAIL: could not read ${agentsMd}: ${err.message}`);
  process.exit(1);
}

let reviewBlock;
let listBlock;
try {
  reviewBlock = extractBlock(agents, 'locate-review');
  listBlock = extractBlock(agents, 'locate-list');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

// Stale forms that must not survive anywhere in a skill's Locating section.
const STALE = [
  'if [ ! -x "$REVIEW_SCRIPT" ]; then',
  'Resolve the installed path',
  'Find the script with',
  // Old tilde-glob discovery block. The canonical snippet uses "$HOME"/.claude,
  // so a literal ~/.claude printf only survives if an old block was left behind.
  "printf '%s\\n' ~/.claude/plugins/cache",
];

// Every <engine>/SKILL.md (each dir under skills/ that has one).
const skillFiles = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(skillsDir, d.name, 'SKILL.md'))
  .filter((p) => fs.existsSync(p));

if (skillFiles.length === 0) {
  console.error('FAIL: no SKILL.md files found under skills/');
  process.exit(1);
}

for (const file of skillFiles) {
  const rel = path.relative(skillsDir, file);
  const content = fs.readFileSync(file, 'utf8');

  record(
    `${rel}: embeds canonical REVIEW block`,
    content.includes(reviewBlock)
  );

  // Any skill that drives provider/model discovery must carry the LIST block.
  if (content.includes('LIST_SCRIPT')) {
    record(`${rel}: embeds canonical LIST block`, content.includes(listBlock));
  }

  for (const stale of STALE) {
    record(
      `${rel}: no stale form (${stale.slice(0, 28)}…)`,
      !content.includes(stale),
      `found stale snippet: ${stale}`
    );
  }
}

// Host adapters (Cursor CLI rule, opencode command) embed the same REVIEW block
// so they resolve review.js identically — drift-check them too.
const repoRoot = path.join(__dirname, '..');
const hostAdapters = [
  path.join(repoRoot, '.opencode', 'command', 'second-opinion.md'),
  path.join(repoRoot, '.cursor', 'rules', 'second-opinion.mdc'),
];

for (const file of hostAdapters) {
  const rel = path.relative(repoRoot, file);
  if (!fs.existsSync(file)) {
    record(`${rel}: present`, false, 'host adapter file missing');
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  record(
    `${rel}: embeds canonical REVIEW block`,
    content.includes(reviewBlock)
  );
  for (const stale of STALE) {
    record(
      `${rel}: no stale form (${stale.slice(0, 28)}…)`,
      !content.includes(stale),
      `found stale snippet: ${stale}`
    );
  }
}

process.exit(allPass ? 0 : 1);
