'use strict';

// Diff/file content fetching + the secret-file guard applied to it. Every
// function takes `cwd`/`includeSecrets` as explicit parameters (rather than
// reading module-level state) so this module has nothing shared across
// entry points to get out of sync.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isLikelyEnvSecret } = require('../env-guard');

// Resolve the default remote branch once so --diff=branch can target it
// instead of guessing origin/main. Falls back to HEAD~1..HEAD in fetchDiff.
function resolveDefaultBranchRef(cwd) {
  // git symbolic-ref refs/remotes/origin/HEAD → 'refs/remotes/origin/main'
  const r = spawnSync(
    'git',
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd, encoding: 'utf8' }
  );
  if (r.status === 0 && r.stdout) {
    return r.stdout.trim(); // e.g. 'origin/main'
  }
  return null;
}

// Build a synthetic diff for untracked files (new files git would otherwise
// omit from `git diff`). Read-only: lists untracked paths honoring .gitignore,
// then renders each as an add-style diff via `git diff --no-index /dev/null
// <file>`. Binary files (NUL in first 8KB) are skipped with a note so they
// don't blow up the prompt or corrupt it. Returns '' when there are none.
function fetchUntrackedContent(cwd, includeSecrets) {
  const ls = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd, encoding: 'utf8' }
  );
  if (ls.status !== 0 || !ls.stdout) return '';
  const files = ls.stdout.split('\0').filter(Boolean);
  if (files.length === 0) return '';

  const parts = [];
  for (const rel of files) {
    // Never embed a .env-style secret file's contents (unless --include-secrets).
    if (!includeSecrets && isLikelyEnvSecret(rel)) {
      parts.push(
        `# (skipped potential secret file: ${rel} — pass --include-secrets to include)\n`
      );
      continue;
    }
    const abs = path.join(cwd, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue; // raced away / unreadable — skip
    }
    const sniff = buf.subarray(0, Math.min(buf.length, 8192));
    if (sniff.includes(0)) {
      parts.push(`# (skipped binary untracked file: ${rel})\n`);
      continue;
    }
    // `git diff --no-index` exits 1 when files differ (they always do here vs
    // /dev/null); that's expected, so we use stdout regardless of status.
    const d = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', rel], {
      cwd,
      encoding: 'utf8',
    });
    if (d.stdout) parts.push(d.stdout);
  }
  return parts.join('');
}

// Decide whether a `diff --git` header line names an .env-style secret file.
// Handles git's c-quoted form — `diff --git "a/…" "b/…"` — emitted when a path
// contains non-ASCII or special bytes (core.quotePath, on by default), as well
// as the bare form. Tests BOTH path tokens (a-side and b-side) so a rename
// to/from a secret is caught. Errs toward redaction on an unparseable header.
function diffHeaderTouchesEnvSecret(headerLine) {
  const rest = headerLine.replace(/^diff --git\s+/, '');
  let toks;
  // Quoted form: git quotes BOTH sides together. Capture inside each "...".
  const q = rest.match(/^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"\s*$/);
  if (q) {
    toks = [q[1], q[2]];
  } else {
    // Bare form: filenames never contain spaces here (git quotes those), so
    // the two tokens are `a/<old>` and `b/<new>` separated by " b/".
    const m = rest.match(/^a\/(.*?) b\/(.*?)\s*$/);
    toks = m ? [m[1], m[2]] : rest.split(/\s+/);
  }
  // Strip any surrounding quote and the a//b/ prefix, then match on basename.
  const clean = (t) => t.replace(/^"/, '').replace(/^[ab]\//, '');
  return toks.some((t) => isLikelyEnvSecret(clean(t)));
}

// Redact .env-style secret files from a unified diff so a tracked secret
// (committing a real .env is bad practice but happens) never reaches an engine.
// Splits on `diff --git` section boundaries, identifies each section's path
// from its header, and replaces secret sections with a one-line note while
// keeping every other file's hunks intact. No-op under --include-secrets.
function redactEnvFromDiff(diff, includeSecrets) {
  if (includeSecrets || !diff) return diff;
  // Lookahead split keeps the `diff --git` line attached to its section; the
  // first element is any preamble before the first header (usually empty).
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .map((sec) => {
      if (!sec.startsWith('diff --git ')) return sec;
      const nl = sec.indexOf('\n');
      const headerLine = nl >= 0 ? sec.slice(0, nl) : sec;
      if (diffHeaderTouchesEnvSecret(headerLine)) {
        // Keep the header (the filename is not the secret — the hunk is) so
        // the reviewer can see WHICH file was withheld; drop the body.
        return (
          headerLine +
          '\n# (redacted potential secret file — contents withheld; ' +
          'pass --include-secrets to include)\n'
        );
      }
      return sec;
    })
    .join('');
}

// Fetch raw diff content for a given spec. Returns the string.
//
// For `unstaged` we also append untracked files (see fetchUntrackedContent):
// plain `git diff` omits them, so a WIP review of work that ADDS files would
// silently miss the new files. The other specs (staged, last-commit, branch,
// custom range) are commit/index scoped and intentionally exclude untracked.
function fetchDiffContent(spec, cwd, includeSecrets) {
  const shortcuts = {
    unstaged: ['diff'],
    staged: ['diff', '--staged'],
    'last-commit': ['diff', 'HEAD~1'],
  };
  let args;
  if (spec === 'branch') {
    const base = resolveDefaultBranchRef(cwd);
    args = base ? ['diff', `${base}..HEAD`] : ['diff', 'HEAD~1..HEAD'];
  } else {
    args = shortcuts[spec] ?? ['diff', spec];
  }

  let result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  // Fallback for branch: if the auto-detected base ref didn't work
  // (shallow clone, no upstream), fall back to HEAD~1..HEAD.
  if (spec === 'branch' && result.status !== 0) {
    args = ['diff', 'HEAD~1..HEAD'];
    result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  }

  if (result.error || result.status !== 0) {
    process.stderr.write(
      `review.js: git ${args.join(' ')} failed: ${result.stderr || result.error?.message || 'unknown'}\n`
    );
    process.exit(1);
  }

  let combined = redactEnvFromDiff(result.stdout, includeSecrets);
  if (spec === 'unstaged')
    combined += fetchUntrackedContent(cwd, includeSecrets);

  if (!combined.trim()) {
    process.stderr.write(
      `review.js: git ${args.join(' ')} produced no output — nothing to review\n`
    );
    process.exit(1);
  }

  return combined;
}

function readFileContent(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (err) {
    process.stderr.write(`review.js: could not read ${p}: ${err.message}\n`);
    process.exit(1);
  }
  // Reject binary files: NUL byte in the first 8KB is a strong signal.
  const sniff = buf.subarray(0, Math.min(buf.length, 8192));
  if (sniff.includes(0)) {
    process.stderr.write(
      `review.js: --file '${p}' looks binary (NUL byte detected); pass a text file or use --diff\n`
    );
    process.exit(1);
  }
  return buf.toString('utf8');
}

// Escape closing tags so embedded content cannot break out of the wrapper block.
function escapeForBlock(content, tag) {
  const close = `</${tag}>`;
  return content.split(close).join(`</​${tag}>`);
}

// Cap on the final combined prompt size. Linux ARG_MAX is often 128KB after
// environment overhead; macOS is ~256KB. Stay under the smallest realistic
// limit so `spawnSync` doesn't fail with E2BIG.
const PROMPT_BYTE_LIMIT = 120_000;

function checkPromptSize(p) {
  const size = Buffer.byteLength(p, 'utf8');
  if (size > PROMPT_BYTE_LIMIT) {
    process.stderr.write(
      `review.js: combined prompt is ${size} bytes (limit ${PROMPT_BYTE_LIMIT}). ` +
        'Narrow the diff range or split the file.\n'
    );
    process.exit(1);
  }
}

// git pathspecs that exclude .env-style files, so the --no-embed `git diff`
// the engine runs itself never emits secret content. (In embed mode we redact
// instead; this is the system-level guard for the self-fetch path.) Slightly
// over-excludes .env.example etc, which is the safe direction for no-embed.
const ENV_EXCLUDE_PATHSPECS = [
  ':(exclude,glob)**/.env',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/*.env',
];

// Resolve the actual git args we would use for a given diff spec, so
// --no-embed mode can show the engine the same range we would have fetched.
// Appends env-file exclude pathspecs unless --include-secrets.
function resolveDiffArgs(spec, cwd, includeSecrets) {
  const shortcuts = {
    unstaged: ['diff'],
    staged: ['diff', '--staged'],
    'last-commit': ['diff', 'HEAD~1'],
  };
  let args;
  if (spec === 'branch') {
    const base = resolveDefaultBranchRef(cwd);
    args = base ? ['diff', `${base}..HEAD`] : ['diff', 'HEAD~1..HEAD'];
  } else {
    args = shortcuts[spec] ?? ['diff', spec];
  }
  if (!includeSecrets) args = [...args, '--', ...ENV_EXCLUDE_PATHSPECS];
  return args;
}

module.exports = {
  resolveDefaultBranchRef,
  fetchUntrackedContent,
  diffHeaderTouchesEnvSecret,
  redactEnvFromDiff,
  fetchDiffContent,
  readFileContent,
  escapeForBlock,
  PROMPT_BYTE_LIMIT,
  checkPromptSize,
  ENV_EXCLUDE_PATHSPECS,
  resolveDiffArgs,
};
