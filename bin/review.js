#!/usr/bin/env node
// second-opinion-skill review runner
// Usage: review.js --engine=<engine> [--model=<model>] --cwd=<path>
//                  [--diff=<spec> | --file=<path>] "<prompt>"
//                  [--engine-arg=<arg> ... | -- <engine-args...>]
// Engines: opencode, gemini, codex, claude, copilot, qwen, kilo
//
// --diff=<spec> shortcuts (review.js runs git in --cwd):
//   unstaged     → git diff
//   staged       → git diff --staged
//   last-commit  → git diff HEAD~1
//   branch       → git diff origin/main..HEAD (fallback: HEAD~1..HEAD)
//   <custom>     → git diff <custom>        (e.g. "HEAD~3..HEAD")
//
// --file=<path>  Read file content from disk.
//
// Diff/file content is embedded directly in the prompt as a <diff> or <file>
// block. No temp files written, no model-side file reads, no sandbox carve-outs.
// Engines without shell access (gemini, qwen) and sandboxed engines (codex,
// opencode) all get the same deterministic inline content.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { shellQuote } = require('./shell-quote');

let engine = '';
let model = '';
let cwd = process.cwd();
let diffSpec = '';
let filePath = '';
let prompt = '';
let extraEngineArgs = [];
let showHelp = false;
let logArg = null; // null = unset, '' = auto-disabled with --log=-, string = explicit path

const argv = process.argv.slice(2);

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  review.js --engine=<engine> [--model=<model>] --cwd=<path> [--diff=<spec> | --file=<path>] "<prompt>"',
      '            [--engine-arg=<arg> ... | -- <engine-args...>]',
      '',
      'Engines:',
      '  opencode, gemini, codex, claude, copilot, qwen, kilo',
      '',
      'Diff/file shortcuts:',
      '  --diff=unstaged     git diff',
      '  --diff=staged       git diff --staged',
      '  --diff=last-commit  git diff HEAD~1',
      '  --diff=branch       git diff origin/main..HEAD (fallback: HEAD~1..HEAD)',
      '  --diff=<range>      git diff <range>',
      '  --file=<path>       review a specific file',
      '',
      'Extra engine args:',
      '  --engine-arg=<arg>  Forward one extra arg to the engine CLI (repeatable)',
      '  --                  Forward all remaining args to the engine CLI',
      '',
      'Output capture:',
      '  --log=<path>        Tee engine output to <path> (in addition to stdout)',
      '  --log=-             Disable auto-logging (force stdout-only)',
      '  (default)           Auto-log to $TMPDIR/second-opinion-<engine>-<ts>.log',
      '                      when stdout is not a TTY (agent harness, pipes, CI)',
      '',
      'Examples:',
      '  review.js --engine=claude --cwd=. "Review this" --engine-arg=--verbose',
      '  review.js --engine=codex --cwd=. "Review this" -- --model o3',
      '  review.js --engine=gemini --cwd=. --log=/tmp/r.log "Review this"',
    ].join('\n') + '\n'
  );
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '-h' || arg === '--help') {
    showHelp = true;
    break;
  }
  if (arg === '--') {
    extraEngineArgs = argv.slice(i + 1);
    break;
  }
  if (arg.startsWith('--engine-arg='))
    extraEngineArgs.push(arg.slice('--engine-arg='.length));
  else if (arg.startsWith('--engine=')) engine = arg.slice('--engine='.length);
  else if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
  else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
  else if (arg.startsWith('--diff=')) diffSpec = arg.slice('--diff='.length);
  else if (arg.startsWith('--file=')) filePath = arg.slice('--file='.length);
  else if (arg.startsWith('--log=')) logArg = arg.slice('--log='.length);
  else if (!prompt) prompt = arg;
  else {
    process.stderr.write(`review.js: unexpected argument '${arg}'\n`);
    process.stderr.write(
      'Use --engine-arg=<arg> or -- to pass extra engine-specific args.\n'
    );
    process.exit(1);
  }
}

if (showHelp) {
  printHelp();
  process.exit(0);
}

const SUPPORTED_ENGINES = [
  'opencode',
  'gemini',
  'codex',
  'claude',
  'copilot',
  'qwen',
  'kilo',
];

if (!engine) {
  printHelp();
  process.exit(1);
}

if (!SUPPORTED_ENGINES.includes(engine)) {
  process.stderr.write(`review.js: unknown engine '${engine}'\n`);
  process.stderr.write(`Supported engines: ${SUPPORTED_ENGINES.join(', ')}\n`);
  process.exit(1);
}

if (!prompt) {
  process.stderr.write(
    'review.js: prompt is required as a positional argument\n'
  );
  process.exit(1);
}

if (diffSpec && filePath) {
  process.stderr.write('review.js: --diff and --file are mutually exclusive\n');
  process.exit(1);
}

// Fetch raw diff content for a given spec. Returns the string.
function fetchDiffContent(spec) {
  const shortcuts = {
    unstaged: ['diff'],
    staged: ['diff', '--staged'],
    'last-commit': ['diff', 'HEAD~1'],
    branch: ['diff', 'origin/main..HEAD'],
  };
  let args = shortcuts[spec] ?? ['diff', spec];

  let result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  // Fallback for branch: if origin/main..HEAD fails, try HEAD~1..HEAD
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

  if (!result.stdout.trim()) {
    process.stderr.write(
      `review.js: git ${args.join(' ')} produced no output — nothing to review\n`
    );
    process.exit(1);
  }

  return result.stdout;
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

let combinedPrompt = prompt;

if (diffSpec) {
  const diffContent = escapeForBlock(fetchDiffContent(diffSpec), 'diff');
  combinedPrompt = `<diff>\n${diffContent}\n</diff>\n\nReview the diff above. Then:\n\n${prompt}`;
} else if (filePath) {
  const fileContent = escapeForBlock(readFileContent(filePath), 'file');
  combinedPrompt = `<file path="${filePath}">\n${fileContent}\n</file>\n\nReview the file above. Then:\n\n${prompt}`;
}

checkPromptSize(combinedPrompt);

// Determine where to write the captured copy of engine output (the "log").
// Priority:
//   --log=<path>   → explicit file path
//   --log=-        → disable (force stdout-only)
//   stdout is TTY  → no log (interactive use)
//   otherwise      → auto-generate $TMPDIR/second-opinion-<engine>-<ts>.log
// Returning null means "don't write a log file, just stream to stdout".
function resolveLogPath() {
  if (logArg === '-') return null;
  if (logArg) return path.resolve(logArg);
  if (process.stdout.isTTY) return null;
  const tmp = (process.env.TMPDIR || '/tmp').replace(/\/+$/, '');
  return path.join(tmp, `second-opinion-${engine}-${Date.now()}.log`);
}

// Many engine CLIs (codex exec, claude --print, gemini -p, etc.) detect a
// non-TTY stdout and buffer output until completion. When review.js is run
// from a background shell (CI, agent harness, `&`), this produces long silent
// stretches that look like a hang. Wrap the engine in `script(1)` to allocate
// a pseudo-TTY so each chunk streams as it is produced.
//
// `script` syntax differs by platform:
//   macOS/BSD:        script -q /dev/null <cmd> [args...]
//   Linux util-linux: script -qfc '<cmd args...>' /dev/null
//
// We use streaming `spawn` (not `spawnSync`) so we can pipe chunks into both
// the parent stdio and an optional log file. The dispatcher below awaits the
// returned promise.
function chooseSpawn(cmd, args) {
  // Whether to attempt a `script(1)` PTY wrap. Helps engines that buffer on
  // non-TTY stdout. Not needed when stdout is already a TTY.
  const wantPty = !process.stdout.isTTY && process.platform !== 'win32';
  // BSD `script` (macOS) calls tcgetattr() on its own stdin and aborts when
  // stdin is not a real TTY (agent harness, CI, piped input). Linux util-linux
  // `script -qfc` does not require a TTY on stdin.
  const ptyUsable =
    wantPty && (process.platform !== 'darwin' || process.stdin.isTTY);

  if (!ptyUsable) {
    return { cmd, args, viaScript: false };
  }
  const scriptArgs =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', cmd, ...args]
      : ['-qfc', [cmd, ...args].map(shellQuote).join(' '), '/dev/null'];
  return { cmd: 'script', args: scriptArgs, viaScript: true };
}

// When a log file is in use AND stdout is not a TTY, suppress engine output
// from the parent's stdout entirely. Models invoking review.js from an agent
// harness routinely pipe to `| tail -N`, which truncates long reviews and
// loses content. By keeping engine bytes off stdout in that mode, we force
// callers to read the log file — there is literally nothing else to consume.
// Stderr (engine diagnostics) still passes through so launch failures are
// visible to the caller without needing the log file.
function runEngine(cmd, args, logStream) {
  const stdoutSuppressed = !!logStream && !process.stdout.isTTY;
  return new Promise((resolve) => {
    const choice = chooseSpawn(cmd, args);
    let child;
    try {
      child = spawn(choice.cmd, choice.args, {
        cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ status: null, error: err });
      return;
    }

    let scriptFellBack = false;
    child.on('error', (err) => {
      // `script` missing — fall back to direct spawn once.
      if (choice.viaScript && !scriptFellBack && err && err.code === 'ENOENT') {
        scriptFellBack = true;
        process.stderr.write(
          "review.js: 'script' not found on PATH; running without PTY (output may buffer)\n"
        );
        const direct = spawn(cmd, args, {
          cwd,
          stdio: ['inherit', 'pipe', 'pipe'],
        });
        wireStreams(direct);
        direct.on('exit', (code, signal) =>
          resolve({
            status: signal ? 128 + os_signum(signal) : code,
            error: null,
          })
        );
        direct.on('error', (e2) => resolve({ status: null, error: e2 }));
        return;
      }
      resolve({ status: null, error: err });
    });

    function wireStreams(c) {
      c.stdout.on('data', (chunk) => {
        if (!stdoutSuppressed) process.stdout.write(chunk);
        if (logStream) logStream.write(chunk);
      });
      c.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        if (logStream) logStream.write(chunk);
      });
    }
    wireStreams(child);

    child.on('exit', (code, signal) => {
      resolve({ status: signal ? 128 + os_signum(signal) : code, error: null });
    });
  });
}

// node returns signal as a string ('SIGTERM') — translate to a stable number
// for the conventional 128+N exit-code convention.
function os_signum(sig) {
  const table = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[sig] || 0;
}

function buildEngineCmd() {
  switch (engine) {
    case 'opencode':
      if (!model) {
        process.stderr.write(
          'review.js: opencode requires --model=<provider/model>\n'
        );
        process.exit(1);
      }
      return [
        'opencode',
        [
          'run',
          '--model',
          model,
          '--agent',
          'plan',
          ...extraEngineArgs,
          combinedPrompt,
        ],
      ];

    case 'gemini':
      return [
        'gemini',
        [
          '-s',
          '--approval-mode',
          'plan',
          ...extraEngineArgs,
          '-p',
          combinedPrompt,
        ],
      ];

    case 'codex': {
      const codexArgs = ['exec', '-s', 'read-only'];
      if (model) codexArgs.push('-m', model);
      codexArgs.push(...extraEngineArgs);
      codexArgs.push(combinedPrompt);
      return ['codex', codexArgs];
    }

    case 'claude': {
      const claudeArgs = ['--print', '--permission-mode', 'plan'];
      if (model) claudeArgs.push('--model', model);
      claudeArgs.push(...extraEngineArgs);
      claudeArgs.push(combinedPrompt);
      return ['claude', claudeArgs];
    }

    case 'copilot': {
      const copilotArgs = [
        '-s',
        '--plan',
        '--allow-all-tools',
        '--deny-tool=write',
      ];
      if (model) copilotArgs.push('--model', model);
      copilotArgs.push(...extraEngineArgs, '-p', combinedPrompt);
      return ['copilot', copilotArgs];
    }

    case 'qwen': {
      const qwenArgs = ['-s', '--approval-mode', 'plan'];
      if (model) qwenArgs.push('-m', model);
      qwenArgs.push(...extraEngineArgs);
      qwenArgs.push(combinedPrompt);
      return ['qwen', qwenArgs];
    }

    case 'kilo': {
      const kiloArgs = ['run', '--agent', 'plan'];
      if (model) kiloArgs.push('-m', model);
      kiloArgs.push(...extraEngineArgs);
      kiloArgs.push(combinedPrompt);
      return ['kilo', kiloArgs];
    }

    default:
      process.stderr.write(`review.js: unhandled engine '${engine}'\n`);
      process.exit(1);
  }
}

async function main() {
  const [cmd, args] = buildEngineCmd();

  // Set up output capture. We pipe child stdout/stderr through this process,
  // optionally tee'ing every chunk into a log file so callers (especially
  // agent harnesses) can recover the full output even if their stdout was
  // truncated by `| head`, `| tail`, or buffered until exit.
  const logPath = resolveLogPath();
  let logStream = null;
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logStream = fs.createWriteStream(logPath, { flags: 'w' });
    } catch (err) {
      process.stderr.write(
        `review.js: could not open log file '${logPath}': ${err.message}\n`
      );
      logStream = null;
    }
  }

  const started = Date.now();
  const stdoutSuppressed = !!logStream && !process.stdout.isTTY;
  if (logStream) {
    const header = [
      `# review.js ${engine}${model ? ` (${model})` : ''}`,
      `# cwd: ${cwd}`,
      `# started: ${new Date(started).toISOString()}`,
      `# prompt-bytes: ${Buffer.byteLength(combinedPrompt, 'utf8')}`,
      diffSpec
        ? `# diff: ${diffSpec}`
        : filePath
          ? `# file: ${filePath}`
          : '# scope: prompt-only',
      '',
    ].join('\n');
    logStream.write(header);
    // Print a loud banner on BOTH stdout and stderr so it survives any kind
    // of agent-side stream redirection — `| tail -N`, `2>/dev/null`,
    // `> file`, etc. The banner explicitly tells the caller to Read the log
    // path rather than scrape the command output.
    const banner = stdoutSuppressed
      ? [
          '===========================================================',
          `REVIEW IN PROGRESS — ${engine}${model ? ` (${model})` : ''}`,
          `LOG FILE: ${logPath}`,
          'Engine output is being written to the log file only.',
          'After this command exits, use the Read tool on the LOG FILE path',
          'above to retrieve the full review. Do not pipe to tail/head — the',
          'engine output is not on stdout in this mode.',
          '===========================================================',
        ].join('\n')
      : `review.js: logging to ${logPath} (tee'd)`;
    process.stdout.write(banner + '\n');
    process.stderr.write(`review.js: logging to ${logPath}\n`);
  }

  const result = await runEngine(cmd, args, logStream);
  const dur = ((Date.now() - started) / 1000).toFixed(1);

  if (logStream) {
    const trailer = `\n\n# exit: ${result.status ?? 'unknown'} duration: ${dur}s\n`;
    logStream.write(trailer);
    await new Promise((r) => logStream.end(r));
    let bytes = 0;
    try {
      bytes = fs.statSync(logPath).size;
    } catch {
      /* ignore */
    }
    const finalLine = `REVIEW COMPLETE — read with Read tool: ${logPath} (${bytes}B, exit=${result.status ?? 'unknown'}, ${dur}s)`;
    process.stdout.write(finalLine + '\n');
    process.stderr.write(
      `review.js: log ${logPath} (${bytes}B, exit=${result.status ?? 'unknown'}, ${dur}s)\n`
    );
  }

  if (result.error) {
    if (result.error.code === 'E2BIG') {
      process.stderr.write(
        `review.js: argv too large for OS (E2BIG). Lower PROMPT_BYTE_LIMIT or narrow the diff range.\n`
      );
      process.exit(1);
    }
    process.stderr.write(
      `review.js: failed to launch '${engine}': ${result.error.message}\n`
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  process.stderr.write(
    `review.js: unexpected error: ${err.stack || err.message}\n`
  );
  process.exit(1);
});
