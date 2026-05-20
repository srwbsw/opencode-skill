#!/usr/bin/env node
// second-opinion-skill review runner
// Usage: review.js --engine=<engine> [--model=<model>] --cwd=<path>
//                  [--diff=<spec> | --file=<path>] "<prompt>"
//                  [--engine-arg=<arg> ... | -- <engine-args...>]
// Engines: opencode, gemini, codex, claude, copilot, qwen, kilo, agy
//
// --diff=<spec> shortcuts (review.js runs git in --cwd):
//   unstaged     → git diff
//   staged       → git diff --staged
//   last-commit  → git diff HEAD~1
//   branch       → git diff <auto-detected default>..HEAD
//                  (fallback: HEAD~1..HEAD)
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
const os = require('os');
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
let timeoutArg = null; // null = use default, number = seconds, 0 = no timeout
let heartbeatArg = null; // null = use default, number = seconds, 0 = disabled

// Defaults. Override via --timeout / --heartbeat or env vars (for harness tuning).
const DEFAULT_TIMEOUT_SEC = Number(process.env.SOS_TIMEOUT_SEC) || 600;
const DEFAULT_HEARTBEAT_SEC = Number(process.env.SOS_HEARTBEAT_SEC) || 30;
// Bytes of recent engine stdout to flush to the parent's stdout on exit when
// the live stream was suppressed. Helps callers see a tail without opening the
// log file, while still forcing them to Read the log for the full content.
const TAIL_BYTES_ON_EXIT = 4096;
// Grace period between SIGTERM and SIGKILL when --timeout fires.
const KILL_GRACE_MS = 5000;

const argv = process.argv.slice(2);

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  review.js --engine=<engine> [--model=<model>] --cwd=<path> [--diff=<spec> | --file=<path>] "<prompt>"',
      '            [--engine-arg=<arg> ... | -- <engine-args...>]',
      '',
      'Engines:',
      '  opencode, gemini, codex, claude, copilot, qwen, kilo, agy',
      '',
      'Diff/file shortcuts:',
      '  --diff=unstaged     git diff',
      '  --diff=staged       git diff --staged',
      '  --diff=last-commit  git diff HEAD~1',
      '  --diff=branch       git diff <default-branch>..HEAD (auto-detected)',
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
      'Liveness:',
      `  --timeout=<sec>     Kill engine after N seconds (default ${DEFAULT_TIMEOUT_SEC}, 0=disable)`,
      `  --heartbeat=<sec>   Heartbeat interval when engine silent (default ${DEFAULT_HEARTBEAT_SEC}, 0=disable)`,
      '',
      'Examples:',
      '  review.js --engine=claude --cwd=. "Review this" --engine-arg=--verbose',
      '  review.js --engine=codex --cwd=. "Review this" -- --model o3',
      '  review.js --engine=gemini --cwd=. --log=/tmp/r.log "Review this"',
      '  review.js --engine=codex --cwd=. --timeout=300 --heartbeat=15 "Review this"',
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
  else if (arg.startsWith('--timeout='))
    timeoutArg = arg.slice('--timeout='.length);
  else if (arg.startsWith('--heartbeat='))
    heartbeatArg = arg.slice('--heartbeat='.length);
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
  'agy',
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

function parseSecondsArg(name, raw, fallback) {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(
      `review.js: --${name}=<seconds> must be a non-negative number, got '${raw}'\n`
    );
    process.exit(1);
  }
  return n;
}

const timeoutSec = parseSecondsArg('timeout', timeoutArg, DEFAULT_TIMEOUT_SEC);
const heartbeatSec = parseSecondsArg(
  'heartbeat',
  heartbeatArg,
  DEFAULT_HEARTBEAT_SEC
);

// Resolve the default remote branch once so --diff=branch can target it
// instead of guessing origin/main. Falls back to HEAD~1..HEAD in fetchDiff.
function resolveDefaultBranchRef() {
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

// Fetch raw diff content for a given spec. Returns the string.
function fetchDiffContent(spec) {
  const shortcuts = {
    unstaged: ['diff'],
    staged: ['diff', '--staged'],
    'last-commit': ['diff', 'HEAD~1'],
  };
  let args;
  if (spec === 'branch') {
    const base = resolveDefaultBranchRef();
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

// Resolve a command on PATH. Returns the absolute path or null if missing.
// Used for pre-flight checks AND for picking the PTY wrapper.
function whichCmd(cmd) {
  // `command -v` is the POSIX-standard way and is a shell builtin, so we
  // have to invoke it via /bin/sh. Pass the full pipeline as a single
  // string to avoid Node's DEP0190 warning about array args + shell.
  // shellQuote guards against any path-injection via the input arg.
  const r = spawnSync('/bin/sh', ['-c', `command -v ${shellQuote(cmd)}`], {
    encoding: 'utf8',
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  // Some `command -v` builtins refuse to print non-builtin paths; fall back
  // to `which` which exists nearly everywhere POSIX.
  const r2 = spawnSync('which', [cmd], { encoding: 'utf8' });
  if (r2.status === 0 && r2.stdout) return r2.stdout.trim();
  return null;
}

const INSTALL_HINTS = {
  opencode: 'https://opencode.ai',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  codex: 'https://github.com/openai/codex',
  claude: 'https://claude.ai/code',
  copilot: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  qwen: 'https://github.com/QwenLM/qwen-code',
  kilo: 'https://kilocode.ai',
  agy: 'https://antigravity.google.com',
};

function preflightCheck(cmd) {
  const found = whichCmd(cmd);
  if (found) return;
  const hint = INSTALL_HINTS[engine]
    ? `\n  Install: ${INSTALL_HINTS[engine]}`
    : '';
  process.stderr.write(
    `review.js: '${cmd}' not found on PATH. Cannot run --engine=${engine}.${hint}\n`
  );
  process.exit(127);
}

// Many engine CLIs (codex exec, claude --print, gemini -p, etc.) detect a
// non-TTY stdout and buffer output until completion. When review.js is run
// from a background shell (CI, agent harness, `&`), this produces long silent
// stretches that look like a hang.
//
// We probe wrappers in this order, picking the first that exists AND is
// usable in the current environment:
//
//   1. `unbuffer -p` (expect package). Cross-platform, no TTY-on-stdin
//      requirement. Best when available.
//   2. `script(1)`. Per-platform syntax. BSD `script` calls tcgetattr() on
//      its own stdin and aborts when stdin is not a TTY, so on darwin we
//      can only use it when stdin is a real TTY. Linux util-linux is fine.
//   3. Direct spawn — engine bytes may buffer until exit, but at least the
//      process runs.
//
// We use streaming `spawn` (not `spawnSync`) so we can pipe chunks into both
// the parent stdio and an optional log file.
function chooseSpawn(cmd, args) {
  // No PTY needed when stdout is already a TTY (interactive use).
  if (process.stdout.isTTY || process.platform === 'win32') {
    return { cmd, args, viaScript: false, viaUnbuffer: false };
  }

  // Step 1: unbuffer (from `expect`). Works cross-platform without needing
  // a real TTY on stdin. Preferred when present.
  if (whichCmd('unbuffer')) {
    return {
      cmd: 'unbuffer',
      args: ['-p', cmd, ...args],
      viaScript: false,
      viaUnbuffer: true,
    };
  }

  // Step 2: script(1). Skip on darwin if stdin isn't a TTY (BSD script
  // aborts via tcgetattr). Linux util-linux `script -qfc` has no such
  // requirement.
  const scriptUsable = process.platform !== 'darwin' || process.stdin.isTTY;
  if (scriptUsable && whichCmd('script')) {
    const scriptArgs =
      process.platform === 'darwin'
        ? ['-q', '/dev/null', cmd, ...args]
        : ['-qfc', [cmd, ...args].map(shellQuote).join(' '), '/dev/null'];
    return {
      cmd: 'script',
      args: scriptArgs,
      viaScript: true,
      viaUnbuffer: false,
    };
  }

  // Step 3: give up on PTY. Engine may buffer output until exit.
  return { cmd, args, viaScript: false, viaUnbuffer: false };
}

// When a log file is in use AND stdout is not a TTY, suppress live engine
// output from the parent's stdout entirely. Models invoking review.js from an
// agent harness routinely pipe to `| tail -N`, which truncates long reviews
// and loses content. By keeping engine bytes off stdout in that mode, we force
// callers to read the log file — there is literally nothing else to consume
// live. We DO flush a final tail (TAIL_BYTES_ON_EXIT) to stdout when the
// engine exits so callers always see at least the end of the review without
// having to open the log file.
function runEngine(cmd, args, logStream) {
  const stdoutSuppressed = !!logStream && !process.stdout.isTTY;
  return new Promise((resolve) => {
    const choice = chooseSpawn(cmd, args);
    let child;
    // Track engine activity for heartbeat + tail buffer.
    let lastByteAt = Date.now();
    let totalBytes = 0;
    const tail = [];
    let tailBytes = 0;

    function recordBytes(chunk) {
      lastByteAt = Date.now();
      totalBytes += chunk.length;
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes > TAIL_BYTES_ON_EXIT && tail.length > 1) {
        const dropped = tail.shift();
        tailBytes -= dropped.length;
      }
    }

    // stdio: 'ignore' on stdin — engines must NOT inherit the agent
    // harness stdin. Codex `exec` (and others) treat a non-TTY non-EOF
    // stdin as supplementary prompt input and block forever waiting for
    // EOF. Closing stdin makes them use only the argv prompt.
    try {
      child = spawn(choice.cmd, choice.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ status: null, error: err, killedByTimeout: false });
      return;
    }

    let scriptFellBack = false;
    let killedByTimeout = false;
    let heartbeatTimer = null;
    let timeoutTimer = null;
    let killTimer = null;

    function clearTimers() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      heartbeatTimer = timeoutTimer = killTimer = null;
    }

    function settle(result) {
      clearTimers();
      resolve(result);
    }

    function emitHeartbeat() {
      const elapsed = Math.round((Date.now() - lastByteAt) / 1000);
      const totalElapsed = Math.round((Date.now() - started) / 1000);
      const msg = `# heartbeat +${totalElapsed}s (no engine output for ${elapsed}s, bytes-so-far=${totalBytes})\n`;
      if (logStream) logStream.write(msg);
      process.stderr.write(
        `review.js: alive +${totalElapsed}s (silent ${elapsed}s, bytes=${totalBytes})\n`
      );
    }

    child.on('error', (err) => {
      // `script` missing — fall back to direct spawn once.
      if (choice.viaScript && !scriptFellBack && err && err.code === 'ENOENT') {
        scriptFellBack = true;
        process.stderr.write(
          "review.js: 'script' not found on PATH; running without PTY (output may buffer)\n"
        );
        const direct = spawn(cmd, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        wireStreams(direct);
        attachLifecycle(direct);
        return;
      }
      settle({ status: null, error: err, killedByTimeout });
    });

    function wireStreams(c) {
      c.stdout.on('data', (chunk) => {
        recordBytes(chunk);
        if (!stdoutSuppressed) process.stdout.write(chunk);
        if (logStream) logStream.write(chunk);
      });
      c.stderr.on('data', (chunk) => {
        recordBytes(chunk);
        process.stderr.write(chunk);
        if (logStream) logStream.write(chunk);
      });
    }

    function attachLifecycle(c) {
      // Heartbeat: every heartbeatSec, if no bytes seen since the last
      // tick, emit a liveness line to both the log and stderr.
      if (heartbeatSec > 0) {
        let lastTickAt = Date.now();
        heartbeatTimer = setInterval(() => {
          if (lastByteAt > lastTickAt) {
            // We saw bytes this interval — quiet.
            lastTickAt = Date.now();
            return;
          }
          lastTickAt = Date.now();
          emitHeartbeat();
        }, heartbeatSec * 1000);
        if (heartbeatTimer.unref) heartbeatTimer.unref();
      }

      // Timeout: SIGTERM after timeoutSec, SIGKILL after KILL_GRACE_MS.
      if (timeoutSec > 0) {
        timeoutTimer = setTimeout(() => {
          killedByTimeout = true;
          const totalElapsed = Math.round((Date.now() - started) / 1000);
          const msg = `# TIMEOUT after ${totalElapsed}s (--timeout=${timeoutSec}); sending SIGTERM\n`;
          if (logStream) logStream.write(msg);
          process.stderr.write(`review.js: ${msg.replace(/^# /, '')}`);
          try {
            c.kill('SIGTERM');
          } catch {
            /* already exited */
          }
          killTimer = setTimeout(() => {
            const m2 = `# escalating to SIGKILL after ${KILL_GRACE_MS}ms grace\n`;
            if (logStream) logStream.write(m2);
            process.stderr.write(`review.js: ${m2.replace(/^# /, '')}`);
            try {
              c.kill('SIGKILL');
            } catch {
              /* already exited */
            }
          }, KILL_GRACE_MS);
          if (killTimer.unref) killTimer.unref();
        }, timeoutSec * 1000);
        if (timeoutTimer.unref) timeoutTimer.unref();
      }

      c.on('exit', (code, signal) => {
        // On exit, flush tail to stdout if it was suppressed and there's
        // something to show.
        if (stdoutSuppressed && tail.length > 0) {
          const tailBuf = Buffer.concat(tail);
          process.stdout.write(
            `\n--- engine output tail (last ${tailBuf.length} bytes; full log via Read tool) ---\n`
          );
          process.stdout.write(tailBuf);
          if (!tailBuf.toString('utf8').endsWith('\n'))
            process.stdout.write('\n');
          process.stdout.write('--- end tail ---\n');
        }
        settle({
          status: signal ? 128 + signum(signal) : code,
          error: null,
          killedByTimeout,
        });
      });
    }

    wireStreams(child);
    attachLifecycle(child);
  });
}

// Map a signal name ('SIGTERM') to its number via os.constants for the
// conventional 128+N exit-code convention.
function signum(sig) {
  const table = os.constants && os.constants.signals;
  if (table && typeof table[sig] === 'number') return table[sig];
  const fallback = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return fallback[sig] || 0;
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

    case 'agy': {
      // Antigravity CLI (`agy`) — single-prompt mode via --print, with
      // --sandbox for terminal-restricted execution (mirrors gemini's -s).
      // The CLI has no --model flag in 1.0.0; ignore any --model passed.
      // extraEngineArgs go BEFORE --print so the prompt stays adjacent to
      // its flag (same pattern as gemini's -p).
      return [
        'agy',
        ['--sandbox', ...extraEngineArgs, '--print', combinedPrompt],
      ];
    }

    default:
      process.stderr.write(`review.js: unhandled engine '${engine}'\n`);
      process.exit(1);
  }
}

// `started` is read by emitHeartbeat / timeout messages, so declare at
// module scope for clarity.
const started = Date.now();

async function main() {
  const [cmd, args] = buildEngineCmd();

  // Pre-flight: fail fast with a clear error if the engine CLI isn't on
  // PATH, rather than letting spawn surface ENOENT mid-stream.
  preflightCheck(cmd);

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

  const stdoutSuppressed = !!logStream && !process.stdout.isTTY;
  if (logStream) {
    const header = [
      `# review.js ${engine}${model ? ` (${model})` : ''}`,
      `# cwd: ${cwd}`,
      `# started: ${new Date(started).toISOString()}`,
      `# prompt-bytes: ${Buffer.byteLength(combinedPrompt, 'utf8')}`,
      `# timeout: ${timeoutSec}s, heartbeat: ${heartbeatSec}s`,
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
          `TIMEOUT: ${timeoutSec}s, HEARTBEAT: ${heartbeatSec}s`,
          'Engine output is being written to the log file only.',
          'After this command exits, use the Read tool on the LOG FILE path',
          'above to retrieve the full review. A short tail will be printed',
          'on stdout after the engine exits.',
          '===========================================================',
        ].join('\n')
      : `review.js: logging to ${logPath} (tee'd)`;
    process.stdout.write(banner + '\n');
    process.stderr.write(`review.js: logging to ${logPath}\n`);
  }

  const result = await runEngine(cmd, args, logStream);
  const dur = ((Date.now() - started) / 1000).toFixed(1);

  if (logStream) {
    const trailer =
      `\n\n# exit: ${result.status ?? 'unknown'} duration: ${dur}s` +
      (result.killedByTimeout ? ' (timeout)' : '') +
      '\n';
    logStream.write(trailer);
    await new Promise((r) => logStream.end(r));
    let bytes = 0;
    try {
      bytes = fs.statSync(logPath).size;
    } catch {
      /* ignore */
    }
    const finalLine = `REVIEW COMPLETE — read with Read tool: ${logPath} (${bytes}B, exit=${result.status ?? 'unknown'}, ${dur}s${result.killedByTimeout ? ', TIMEOUT' : ''})`;
    process.stdout.write(finalLine + '\n');
    process.stderr.write(
      `review.js: log ${logPath} (${bytes}B, exit=${result.status ?? 'unknown'}, ${dur}s${result.killedByTimeout ? ', TIMEOUT' : ''})\n`
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
  // Timeout exits with a distinct code (124, matching GNU `timeout`).
  if (result.killedByTimeout) process.exit(124);
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  process.stderr.write(
    `review.js: unexpected error: ${err.stack || err.message}\n`
  );
  process.exit(1);
});
