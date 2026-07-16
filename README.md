# Second Agent

**A universal multi-engine plugin that routes second opinions, code reviews, and engineering tasks to the AI engine of your choice — Gemini, opencode, Codex, Claude Code, Copilot, Qwen, Kilo, Antigravity, Command Code, Cursor.**

No single model catches everything. This plugin makes cross-engine review **and** task delegation first-class parts of your workflow: pick an engine, optionally pick a model, and either get an independent perspective in seconds (`review.js`) or have that engine actually do the work — write tests, fix a bug, refactor — inside your repo, with a full change report (`agent.js`, see [Task mode](#task-mode--delegating-work-instead-of-reviewing-it)).

This repo installs as the `second-opinion-skill` plugin (same slug, now covering both workflows) and ships manifests for Claude Code and Codex, so the same bundle is recognized across both ecosystems.

## Engines

| Engine | Model selection | Read-only flags |
|---|---|---|
| **Gemini CLI** | Automatic | `-s --approval-mode plan` |
| **opencode** | Optional (provider → model, or default) | `--agent plan` |
| **Codex CLI** | Optional (type-in) | `-s read-only` |
| **Claude Code** | Optional (type-in) | `--print --permission-mode plan` |
| **GitHub Copilot CLI** | Optional (type-in) | `--plan --deny-tool=write --allow-all-tools` |
| **Qwen Code CLI** | Optional (type-in) | `-s --approval-mode plan` |
| **Kilo** | Provider → model (free shown first) | `--agent plan` |
| **Antigravity (agy)** | Optional (`agy models`, or default) | `--sandbox` |
| **Command Code (cmd)** | Optional (`cmd --list-models`, or default) | `--print --permission-mode plan --skip-onboarding` |
| **Cursor (agent)** | Optional (`agent --list-models`, or default) | `--print --plan --trust` |

All engines launch from the repo directory (`--cwd`) and read content via native filesystem tools — no stdin piping. This table describes `review.js`'s **read-only** posture; `agent.js` (task delegation) launches the same engines with these flags stripped — see [Task mode](#task-mode--delegating-work-instead-of-reviewing-it).

Beyond the read-only flags above, `review.js` auto-applies a few **functional** flags so non-interactive runs don't hard-fail or hang (these survive `--unrestricted`, and `agent.js` carries them too): `codex` gets `--skip-git-repo-check` (so a non-git `--cwd` doesn't abort), `gemini` gets `--skip-trust` (bypasses the "untrusted directory" gate), and `opencode` gets `--dir <cwd>` (scopes its sandbox file-access root so subtree reads aren't rejected as `external_directory`).

> **Note:** opencode's `big-pickle` model is high-latency on review-sized prompts and may approach the default 600s timeout. Prefer a faster model, or raise `--timeout`, when using it.

## Execution contract

If you are invoking this from another agent or harness, the contract is:

- Run the installed plugin runner via `"$REVIEW_SCRIPT"` (reviews) or `"$AGENT_SCRIPT"` (task delegation). Do not call engine CLIs directly.
- Child engines inherit the parent process context. If the parent command is sandboxed, spawned engines are sandboxed too.
- `--unrestricted` only removes engine-specific safety flags inside `review.js`/`agent.js`; it does not escape the outer sandbox.
- `zsh -lc` / `bash -lc` may normalize `PATH` and shell init, but they do not change permissions.
- Prefer normal embedded review calls. Use `--no-embed` only for very large diffs and only when the chosen engine can run `git` in the current harness.
- In non-TTY runs, read the log file path that the runner prints. Do not scrape stdout with `| tail` / `| head`.

System-level requirement:

- Running from an installed plugin path is not enough by itself. `"$REVIEW_SCRIPT"`/`"$AGENT_SCRIPT"` still inherit the parent harness permissions.
- If you want to verify whether an engine works on the host system, the parent command itself must run outside the harness sandbox.
- A sandboxed plugin-runner invocation is useful for checking the launcher path, but not for proving that host-level engine auth, writable state directories, or network access work.

Troubleshooting:

- If the same installed-plugin command fails only inside a sandboxed harness, diagnose the parent execution mode before changing `review.js`/`agent.js`.
- Some CLIs need writable home-directory state, existing login/auth sessions, or network access. Those requirements must be satisfied by the parent process environment.

Common good pattern:

```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=. --diff=branch "Review this diff for correctness and regressions."
```

Common bad patterns:

```bash
gemini -p "Review this diff"
codex exec "Review this diff"
zsh -lc '"$REVIEW_SCRIPT" ...'   # fine for PATH if needed, not a permission escape
"$REVIEW_SCRIPT" --engine=codex --cwd=. --diff=branch "..." | tail -50
```

Verified installed-plugin check:

```bash
"$REVIEW_SCRIPT" --engine=cmd --engine=claude --cwd=. --timeout=120 --heartbeat=10 "Report whether you were launched successfully and what engine you are. Reply briefly."
```

Interpretation:

- If this fails only inside a sandboxed harness but succeeds at system level, the issue is the harness execution mode, not the runner.

## Skills

| Skill | Trigger phrases |
|---|---|
| `second-agent` | "second opinion", "independent review", "cross-model review", "have another engine do this" |
| `gemini-agent` | "ask Gemini", "review with Gemini", "Gemini's take" |
| `opencode-agent` | "use opencode", "ask opencode", "review with opencode" |
| `codex-agent` | "ask Codex", "review with Codex", "Codex's take" |
| `copilot-agent` | "ask Copilot", "review with Copilot", "Copilot review" |
| `qwen-agent` | "ask Qwen", "review with Qwen", "Qwen's take" |
| `kilo-agent` | "ask Kilo", "review with Kilo", "Kilo's take" |
| `agy-agent` | "ask Antigravity", "agy review", "review with agy" |
| `cmd-agent` | "ask Command Code", "cmd review", "review with cmd" |
| `cursor-agent` | "ask Cursor", "cursor review", "review with cursor" |

Every engine skill handles both workflows — a plain review/opinion, or "have Codex fix/write/refactor this" style task delegation (see [Task mode](#task-mode--delegating-work-instead-of-reviewing-it)).

## Use cases

- **Code review** — senior-engineer-style critique with parallel sub-agent coverage (security, test coverage, regression, design)
- **Second opinion** — independent take on an architectural or design decision
- **Security review** — scan for injection, auth flaws, data exposure, input validation
- **General consultation** — any technical question with a structured answer
- **Task delegation** — have another engine actually write the tests, fix the bug, or do the refactor, with a verifiable change report

## Requirements

- Node.js (for running `bin/review.js`, `bin/agent.js`, and `bin/list.js` — any modern version)
- The CLI for each engine you want to use:
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `gemini-agent`
  - [opencode](https://opencode.ai) — `opencode-agent`
  - [Codex CLI](https://github.com/openai/codex) — `codex-agent`
  - [Claude Code](https://claude.ai/code) — `claude-agent`
  - [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) — `copilot-agent`
  - [Qwen Code CLI](https://github.com/QwenLM/qwen-code) — `qwen-agent`
  - [Kilo](https://kilocode.ai) — `kilo-agent`
  - [Antigravity (agy)](https://antigravity.google.com) — `agy-agent`
  - [Command Code (cmd)](https://commandcode.ai/docs) — `cmd-agent`
  - [Cursor CLI (agent)](https://cursor.com/cli) — `cursor-agent`

You only need the CLIs for the engines you actually use.

## Versioning

Release versions are managed by GitHub Actions. The workflow updates `package.json`, the Claude marketplace metadata, and the Codex plugin manifest together, so you do not need to edit version numbers by hand.

## Permissions

Read-only review execution goes through `bin/review.js`; task delegation goes through its sibling `bin/agent.js`; all provider/model discovery goes through `bin/list.js`. Resolve the installed paths from the current harness, then grant permissions for those exact paths.

Typical locations:

- Codex local install from this repo's helper script:
  - `~/plugins/second-opinion-skill/bin/review.js`
  - `~/plugins/second-opinion-skill/bin/agent.js`
  - `~/plugins/second-opinion-skill/bin/list.js`
- Claude Code marketplace install:
  - `~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/<version>/bin/review.js`
  - `~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/<version>/bin/agent.js`
  - `~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/<version>/bin/list.js`
- Repo-local development:
  - `<repo>/bin/review.js`
  - `<repo>/bin/agent.js`
  - `<repo>/bin/list.js`

Codex example:

```bash
REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
AGENT_SCRIPT="$HOME/plugins/second-opinion-skill/bin/agent.js"
LIST_SCRIPT="$HOME/plugins/second-opinion-skill/bin/list.js"
```

Codex permissions are managed by the harness command approval flow. For Claude Code, add concrete resolved paths, for example:

```json
{
  "permissions": {
    "allow": [
      "Bash(~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js*)",
      "Bash(~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/agent.js*)",
      "Bash(node ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js*)"
    ]
  }
}
```

## Installation

### Quick install — all harnesses, one line

```bash
curl -fsSL https://raw.githubusercontent.com/srwbsw/second-opinion-skill/main/install.sh | bash
```

`install.sh` auto-detects which agent CLIs are present and installs into each.
**Every engine is also a supported host** — install into any of: **Claude Code,
Codex, Cursor, opencode, Gemini, Qwen, Copilot, Antigravity (agy), kilo, Command
Code (cmd)**. It also symlinks the runners (`review.js`, `agent.js`, `list.js`)
onto your `PATH` so every harness resolves them via `command -v` (the ones with
no plugin cache rely on this). Idempotent (safe to re-run); supports
`--only=claude,codex,cursor,opencode,gemini,qwen,copilot,agy,kilo,cmd`,
`--ref=<branch>`, and `--uninstall`. Or clone the repo and run `./install.sh`.

After installing: in Claude Code / Codex / Copilot / agy / cmd the review and
task skills load as plugins/skills; in opencode / kilo / Gemini / Qwen run
`/second-agent <engine> <what to review, or task to delegate>`; in Cursor ask
for *"a second opinion from codex on these changes"* or *"have codex fix this
bug"*.

### Manual / per-harness

If you prefer to install one harness by hand:

```bash
# Claude Code (or /plugin in the TUI)
claude plugin marketplace add srwbsw/second-opinion-skill && claude plugin install second-opinion-skill@second-opinion-skill

# Codex CLI — .agents/plugins/marketplace.json points source at this git URL (native fetch)
codex plugin marketplace add srwbsw/second-opinion-skill && codex plugin add second-opinion-skill@second-opinion-skill

# GitHub Copilot CLI / Command Code / Antigravity — install the skills directly
copilot plugin install srwbsw/second-opinion-skill
cmd skills add srwbsw/second-opinion-skill -g
agy plugin install <path-to-checkout>          # reads the skills from a local checkout

# Gemini CLI — extension (gemini-extension.json + commands/*.toml)
gemini extensions link <path-to-checkout>      # or: gemini extensions install <git-url>

# File-drop hosts (reuse an existing adapter)
cp .cursor/rules/second-agent.mdc        ~/.cursor/rules/                  # Cursor
cp .opencode/command/second-agent.md     ~/.config/opencode/command/       # opencode
cp .opencode/command/second-agent.md     ~/.config/kilo/command/           # kilo (opencode fork)
cp commands/second-agent.toml            ~/.qwen/commands/                 # Qwen (gemini fork)
```

Hosts without a plugin cache (Cursor, opencode, kilo, Gemini, Qwen) rely on
`review.js`/`agent.js` being resolvable — `install.sh` puts them on `PATH`;
otherwise also install in a plugin-cache host (Claude Code / Codex) or set
`SECOND_OPINION_REVIEW=/abs/path/to/review.js` (and
`SECOND_OPINION_AGENT=/abs/path/to/agent.js` for task delegation). All adapters
embed the same discovery snippets and are kept in sync by `test/locate.test.js`;
the host↔engine parity itself is enforced by `test/host-parity.test.js`.

### Local development (uncommitted changes)

`install.sh` run from a checkout uses the working tree as its source. To test
**uncommitted** changes specifically against Codex's plugin cache, use
`./scripts/install-codex-plugin.sh`, which stages the current tree into Codex's
personal marketplace (`~/plugins/second-opinion-skill`, resolved relative to
`$HOME`) with a local cachebuster.

## Usage

**Engine-agnostic (orchestrator picks):**
> "Get a second opinion on this"
> "Independent review of these changes"
> "Cross-model review"
> "Have another engine fix this bug"

**Engine-specific:**
> "Ask Gemini to review this"
> "Use opencode to review this diff"
> "Codex review with o3"
> "Claude Code review with sonnet"
> "Ask Copilot's take on this approach"
> "Qwen security review"
> "Kilo review with a free model"
> "Ask Command Code to review this"
> "Ask Cursor to review this"
> "Have Codex write tests for this and run them"
> "Ask Claude to refactor this module"

When no engine is specified, the `second-agent` skill asks you to pick one. Each engine-specific skill handles its own model flow: Gemini runs immediately; opencode and Kilo optionally walk through provider → model selection (or use their default); Codex, Claude Code, Copilot, and Qwen optionally let you type in a model; Antigravity optionally lets you pick from `agy models` (or uses its default); Command Code optionally lets you pick from `cmd --list-models` (or uses its default); Cursor optionally lets you pick from `agent --list-models` (or uses its default).

Results are structured: **Summary**, **Issues** (HIGH/MED/LOW tagged by domain), **Concerns**, **Positives**. The code review prompt instructs engines to spawn parallel sub-agents per domain where supported. For task delegation instead, see [Task mode](#task-mode--delegating-work-instead-of-reviewing-it).

If you need engine-specific flags, pass them through the runner instead of editing the scripts:

```bash
"$REVIEW_SCRIPT" --engine=claude --cwd=. "Review this" --engine-arg=--verbose
"$REVIEW_SCRIPT" --engine=codex --cwd=. "Review this" -- --permission-mode bypassPermissions
"$LIST_SCRIPT" --engine=opencode models --provider=opencode --cli-arg=--refresh
```

### Reviewing work in progress

- `--diff=unstaged` includes **untracked** files (new files that plain `git diff` omits), so a WIP review of work that adds files doesn't silently miss them. Binary untracked files are skipped with a note. The other `--diff` specs (`staged`, `last-commit`, `branch`, custom ranges) are commit/index-scoped and intentionally exclude untracked.
- `--file=<path>` is **repeatable** — pass it multiple times to embed several files in one review (each as its own `<file>` block).

### Secret-file protection

`review.js` (and `agent.js`, sharing the same guard) never feeds `.env`-style secret files to an engine. By default it **refuses `--file=.env`**, **skips untracked `.env` files** from `--diff=unstaged`, and **redacts `.env` hunks** from any diff — matching `.env`, `.env.*`, and `*.env`, while exempting `*example*` / `*sample*` / `*template*` names. A prompt-level reminder also tells engines not to open env files themselves (covers `--no-embed` and sandbox engines that walk the tree). This is enforced in the runner, not left to the model. Pass `--include-secrets` to opt out when you genuinely need a `.env` reviewed.

### Exit codes

`review.js` exits `0` on success, `124` on timeout (matching GNU `timeout`), and **`3` when an engine exits cleanly but returns no usable output** — zero bytes (e.g. a transient upstream model outage), or, when wrapping is on, output missing the `<<<SECOND_OPINION_START>>>` envelope (truncated, refused, or sandbox-blocked). Any other non-zero code is the engine CLI's own. In a fusion run, each slot's code is annotated in the `FUSION COMPLETE` summary. `agent.js` has its own exit-code semantics — see [Task mode](#task-mode--delegating-work-instead-of-reviewing-it).

## Task mode — delegating work instead of reviewing it

`review.js` only comments. Its sibling `bin/agent.js` asks **one** engine to actually DO a task — write tests, fix a bug, add a feature, refactor, run commands — inside your repo, then reports back what changed. Same engine/model selection and secret guard as `review.js`; different entry point, different safety model.

### Safety model — `--unrestricted` is required

`agent.js` has **no read-only mode**. Passing `--unrestricted` is required — a deliberate acknowledgment that the engine may edit files and run commands inside `--cwd`. Omitting it exits `1` with a message pointing back to `review.js` for read-only consultation, before any spawn or preflight side effect. Once acknowledged, engines launch with the same functional flags as `review.js` (codex `--skip-git-repo-check`, gemini `--skip-trust`, opencode `--dir <cwd>`, etc.) but with every safety/plan/sandbox flag stripped.

### Golden path

```bash
AGENT_SCRIPT="${SECOND_OPINION_AGENT:-$(command -v agent.js || true)}"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$HOME/plugins/second-opinion-skill/bin/agent.js"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$PWD/bin/agent.js"

"$AGENT_SCRIPT" --engine=<engine>[:<model>] --cwd=<repo> --unrestricted "<task prompt>"
```

Exactly **one engine per invocation** — there is no fusion mode for tasks; run `agent.js` again, sequentially, for a second engine's take on the same task.

`--diff=`/`--file=` are optional *context*, not the task itself — they're embedded ahead of the task prompt, framed as "use the context above for the task below" (never `review.js`'s "self-contained, don't explore" directive — the whole point of `agent.js` is that the engine explores/modifies/runs commands in `--cwd`).

### Change reporting

Before and after the engine runs, `agent.js` snapshots `git status --porcelain` + `HEAD` in `--cwd` (skipped, `changes: null`, on a non-git `--cwd`). Stdout always prints a `CHANGED FILES:` block:

```
CHANGED FILES:
  modified  bin/foo.js
  added     test/foo.test.js
```

or `CHANGED FILES: (none)` / `CHANGED FILES: (not a git repository)`.

### Reading the result

Same envelope/answer-file mechanism as `review.js`: stdout prints `ANSWER FILE: <path>` when the engine's structured report was extracted, and the last line is always a `SECOND_AGENT_RESULT: {...}` JSON — `{engine, model, exit, log, answer, timeout, changes: {headBefore, headAfter, files: [{path, state}, ...]} | null}`.

### Exit codes (agent.js)

- `0` — success, including the **`NO REPORT`** case: the engine made real changes on disk but its output had no extractable report. The changes on disk are the deliverable; a missing prose report is only a warning (`agent.js: NO REPORT: engine completed with changes but no envelope…` on stderr), not a failure.
- `3` — clean exit with **neither** a usable report **nor** any changes on disk — nothing to show for the run.
- `124` — timeout (`SIGTERM` → `SIGKILL` grace, same as `review.js`).
- `127` — engine binary not found on `PATH`.
- anything else — the engine CLI's own non-zero code.

### Timeouts

Tasks run far longer than a review, so `agent.js` defaults to a **1800s** timeout, independently of `review.js`'s 600s default — override with `--timeout=<sec>` or the `SOS_AGENT_TIMEOUT_SEC` environment variable. Heartbeat behavior (`--heartbeat=<sec>` / `SOS_HEARTBEAT_SEC`, default 30s) is shared with `review.js`.

## Why cross-engine review & delegation?

Different models are trained on different data with different architectures. Gemini flags different categories of issues than Claude Code. opencode and Kilo give you access to GPT, Llama, Mistral, Qwen, and dozens of others. Running your changes through a differently-trained model before declaring done — or handing that model the actual task — is the same instinct as a second engineer reading (or picking up) your PR, except it takes seconds to start.

## License

MIT
