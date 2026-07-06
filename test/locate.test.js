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
 *
 * The same extraction mechanism now guards two more canonical blocks that the
 * small-model refactor moves into `skills/AGENTS.md` (so each engine skill can
 * shrink to a thin wrapper instead of re-deriving them):
 *   <!-- BEGIN golden-path -->     ```bash …one-command locate→run→read recipe… ```    <!-- END golden-path -->
 *   <!-- BEGIN review-template --> ``` …compact default review prompt… ```             <!-- END review-template -->
 * Every `<engine>-review/SKILL.md` must embed BOTH verbatim and drop the old
 * envelope-extraction prose; `second-opinion/SKILL.md` embeds GOLDEN (it owns
 * the full template set, so TEMPLATE is optional there) and must stay compact.
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
  path.join(repoRoot, 'commands', 'second-opinion.toml'), // gemini + qwen
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

// ---------------------------------------------------------------------------
// Canonical GOLDEN path + default review TEMPLATE blocks (small-model refactor)
// ---------------------------------------------------------------------------
//
// Two more canonical blocks live in skills/AGENTS.md, extracted the same way as
// locate-review / locate-list — by BEGIN/END markers:
//
//   <!-- BEGIN golden-path -->      ```bash  …one-command golden path…  ```   <!-- END golden-path -->
//   <!-- BEGIN review-template -->  ``` …compact default review prompt… ```    <!-- END review-template -->
//
// GOLDEN is the single copy-paste "locate → run → read the ANSWER FILE" recipe;
// TEMPLATE is the compact default review prompt. Every <engine>-review skill
// embeds BOTH verbatim (that's what lets the per-engine skill stay thin);
// second-opinion embeds GOLDEN (it owns the full template set, so TEMPLATE is
// optional there). Edit these blocks in skills/AGENTS.md, never per-file.

const GOLDEN_MARKER = 'golden-path';
const TEMPLATE_MARKER = 'review-template';

// Whole region between BEGIN/END markers (fences included), or null if absent.
function extractRegion(md, name) {
  const m = md.match(
    new RegExp(`<!-- BEGIN ${name} -->([\\s\\S]*?)<!-- END ${name} -->`)
  );
  return m ? m[1] : null;
}

// Inner text of the single fenced code block between the markers (any language
// tag, or none — TEMPLATE is a bare ``` fence), or null if markers/fence absent.
function extractFenced(md, name) {
  const m = md.match(
    new RegExp(
      `<!-- BEGIN ${name} -->\\s*\`\`\`[^\\n]*\\n([\\s\\S]*?)\\n\`\`\`\\s*<!-- END ${name} -->`
    )
  );
  return m ? m[1] : null;
}

// Count of fence markers (```), used to assert a *single* fenced block.
function fenceCount(region) {
  return (region.match(/```/g) || []).length;
}

const goldenRegion = extractRegion(agents, GOLDEN_MARKER);
const goldenBlock = extractFenced(agents, GOLDEN_MARKER);
const templateRegion = extractRegion(agents, TEMPLATE_MARKER);
const templateBlock = extractFenced(agents, TEMPLATE_MARKER);

// --- Shape of the GOLDEN block itself ---
record(
  `AGENTS.md: defines GOLDEN block (<!-- BEGIN ${GOLDEN_MARKER} -->)`,
  goldenBlock !== null,
  `no ${GOLDEN_MARKER} block in skills/AGENTS.md`
);
if (goldenBlock !== null) {
  record('GOLDEN block: non-empty', goldenBlock.trim().length > 0);
  const goldenHasBash = /```bash\n/.test(goldenRegion);
  record(
    'GOLDEN block: single fenced bash block',
    goldenHasBash && fenceCount(goldenRegion) === 2,
    `fences=${fenceCount(goldenRegion)}, bash-fence=${goldenHasBash}`
  );
  record(
    'GOLDEN block: references "$REVIEW_SCRIPT"',
    goldenBlock.includes('"$REVIEW_SCRIPT"')
  );
  record(
    'GOLDEN block: mentions ANSWER FILE',
    goldenBlock.includes('ANSWER FILE')
  );
}

// --- Shape of the TEMPLATE block itself ---
record(
  `AGENTS.md: defines TEMPLATE block (<!-- BEGIN ${TEMPLATE_MARKER} -->)`,
  templateBlock !== null,
  `no ${TEMPLATE_MARKER} block in skills/AGENTS.md`
);
if (templateBlock !== null) {
  record('TEMPLATE block: non-empty', templateBlock.trim().length > 0);
  record(
    'TEMPLATE block: single fenced block',
    fenceCount(templateRegion) === 2,
    `fences=${fenceCount(templateRegion)}`
  );
  const lineCount = templateBlock.split('\n').length;
  record(
    'TEMPLATE block: at most 25 lines',
    lineCount <= 25,
    `${lineCount} lines`
  );
}

// --- Every <engine>-review skill embeds BOTH blocks + drops old envelope prose
// Engine skills are the `<engine>-review/` dirs (second-opinion is the hub and
// is handled separately below).
const engineSkillFiles = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.endsWith('-review'))
  .map((d) => path.join(skillsDir, d.name, 'SKILL.md'))
  .filter((p) => fs.existsSync(p));

record(
  'engine skills discovered (*-review/SKILL.md)',
  engineSkillFiles.length > 0,
  'no *-review/SKILL.md found under skills/'
);

for (const file of engineSkillFiles) {
  const rel = path.relative(skillsDir, file);
  const content = fs.readFileSync(file, 'utf8');

  record(
    `${rel}: embeds canonical GOLDEN block`,
    Boolean(goldenBlock) && content.includes(goldenBlock),
    goldenBlock === null
      ? 'GOLDEN block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
  record(
    `${rel}: embeds canonical TEMPLATE block`,
    Boolean(templateBlock) && content.includes(templateBlock),
    templateBlock === null
      ? 'TEMPLATE block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
  // Guards against a skill that kept only old envelope-parsing guidance.
  record(`${rel}: mentions ANSWER FILE`, content.includes('ANSWER FILE'));
  // The old envelope-extraction instruction is retired; it must be gone.
  record(
    `${rel}: no retired "extract the text between" prose`,
    !/extract the text between/i.test(content),
    'still carries the retired envelope-extraction instruction'
  );
}

// --- Hub (second-opinion): embeds GOLDEN verbatim; body stays compact ---
const hubSkill = path.join(skillsDir, 'second-opinion', 'SKILL.md');
if (!fs.existsSync(hubSkill)) {
  record('second-opinion/SKILL.md: present', false, 'hub skill missing');
} else {
  const hub = fs.readFileSync(hubSkill, 'utf8');
  record(
    'second-opinion/SKILL.md: embeds canonical GOLDEN block',
    Boolean(goldenBlock) && hub.includes(goldenBlock),
    goldenBlock === null
      ? 'GOLDEN block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
  // wc -w parity: whitespace-delimited token count over the whole file.
  const words = hub.trim().split(/\s+/).filter(Boolean).length;
  record(
    'second-opinion/SKILL.md: body under 1400 words',
    words < 1400,
    `${words} words`
  );
}

process.exit(allPass ? 0 : 1);
