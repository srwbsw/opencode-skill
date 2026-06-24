# second-opinion-skill

**A universal multi-engine plugin that routes code reviews to the AI engine of your choice — Gemini, opencode, Codex, Claude Code, Copilot, Qwen, Kilo, Antigravity, Command Code, Cursor.**

No single model catches everything. This plugin makes cross-engine review a first-class part of your workflow: pick an engine, optionally pick a model, get an independent perspective in seconds.

This repo also ships plugin manifests for Claude Code and Codex, so the same bundle can be recognized across both ecosystems.

## Engines

| Engine | Model selection | Read-only flags |
|---|---|---|
| **Gemini CLI** | Automatic | `-s --approval-mode plan` |
| **opencode** | Provider → model (from registry) | `--agent plan` |
| **Codex CLI** | Optional (type-in) | `-s read-only` |
| **Claude Code** | Optional (type-in) | `--print --permission-mode plan` |
| **GitHub Copilot CLI** | Optional (type-in) | `--plan --deny-tool=write --allow-all-tools` |
| **Qwen Code CLI** | Optional (type-in) | `-s --approval-mode plan` |
| **Kilo** | Provider → model (free shown first) | `--agent plan` |
| **Antigravity (agy)** | Optional (`agy models`, or default) | `--sandbox` |
| **Command Code (cmd)** | Optional (`cmd --list-models`, or default) | `--print --permission-mode plan --skip-onboarding` |
| **Cursor (agent)** | Optional (`agent --list-models`, or default) | `--print --plan --trust` |

All engines launch from the repo directory (`--cwd`) and read content via native filesystem tools — no stdin piping.

Beyond the read-only flags above, `review.js` auto-applies a few **functional** flags so non-interactive runs don't hard-fail or hang (these survive `--unrestricted`): `codex` gets `--skip-git-repo-check` (so a non-git `--cwd` doesn't abort), `gemini` gets `--skip-trust` (bypasses the "untrusted directory" gate), and `opencode` gets `--dir <cwd>` (scopes its sandbox file-access root so subtree reads aren't rejected as `external_directory`).

> **Note:** opencode's `big-pickle` model is high-latency on review-sized prompts and may approach the default 600s timeout. Prefer a faster model, or raise `--timeout`, when using it.

## Execution contract

If you are invoking this from another agent or harness, the contract is:

- Run the installed plugin runner via `"$REVIEW_SCRIPT"`. Do not call engine CLIs directly for review work.
- Child engines inherit the parent process context. If the parent command is sandboxed, spawned engines are sandboxed too.
- `--unrestricted` only removes engine-specific safety flags inside `review.js`; it does not escape the outer sandbox.
- `zsh -lc` / `bash -lc` may normalize `PATH` and shell init, but they do not change permissions.
- Prefer normal embedded review calls. Use `--no-embed` only for very large diffs and only when the chosen engine can run `git` in the current harness.
- In non-TTY runs, read the log file path that `review.js` prints. Do not scrape stdout with `| tail` / `| head`.

System-level requirement:

- Running from an installed plugin path is not enough by itself. `"$REVIEW_SCRIPT"` still inherits the parent harness permissions.
- If you want to verify whether an engine works on the host system, the parent command itself must run outside the harness sandbox.
- A sandboxed plugin-runner invocation is useful for checking the launcher path, but not for proving that host-level engine auth, writable state directories, or network access work.

Troubleshooting:

- If the same installed-plugin command fails only inside a sandboxed harness, diagnose the parent execution mode before changing `review.js`.
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

- If this fails only inside a sandboxed harness but succeeds at system level, the issue is the harness execution mode, not `review.js`.

## Skills

| Skill | Trigger phrases |
|---|---|
| `second-opinion` | "second opinion", "independent review", "cross-model review" |
| `gemini-review` | "ask Gemini", "review with Gemini", "Gemini's take" |
| `opencode-review` | "use opencode", "ask opencode", "review with opencode" |
| `codex-review` | "ask Codex", "review with Codex", "Codex's take" |
| `copilot-review` | "ask Copilot", "review with Copilot", "Copilot review" |
| `qwen-review` | "ask Qwen", "review with Qwen", "Qwen's take" |
| `kilo-review` | "ask Kilo", "review with Kilo", "Kilo's take" |
| `agy-review` | "ask Antigravity", "agy review", "review with agy" |
| `cmd-review` | "ask Command Code", "cmd review", "review with cmd" |
| `cursor-review` | "ask Cursor", "cursor review", "review with cursor" |

## Use cases

- **Code review** — senior-engineer-style critique with parallel sub-agent coverage (security, test coverage, regression, design)
- **Second opinion** — independent take on an architectural or design decision
- **Security review** — scan for injection, auth flaws, data exposure, input validation
- **General consultation** — any technical question with a structured answer

## Requirements

- Node.js (for running `bin/review.js` and `bin/list.js` — any modern version)
- The CLI for each engine you want to use:
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `gemini-review`
  - [opencode](https://opencode.ai) — `opencode-review`
  - [Codex CLI](https://github.com/openai/codex) — `codex-review`
  - [Claude Code](https://claude.ai/code) — `claude-review`
  - [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) — `copilot-review`
  - [Qwen Code CLI](https://github.com/QwenLM/qwen-code) — `qwen-review`
  - [Kilo](https://kilocode.ai) — `kilo-review`
  - [Antigravity (agy)](https://antigravity.google.com) — `agy-review`
  - [Command Code (cmd)](https://commandcode.ai/docs) — `cmd-review`
  - [Cursor CLI (agent)](https://cursor.com/cli) — `cursor-review`

You only need the CLIs for the engines you actually use.

## Versioning

Release versions are managed by GitHub Actions. The workflow updates `package.json`, the Claude marketplace metadata, and the Codex plugin manifest together, so you do not need to edit version numbers by hand.

## Permissions

All engine execution goes through `bin/review.js`, and all provider/model discovery goes through `bin/list.js`. Resolve the installed paths from the current harness, then grant permissions for those exact paths.

Typical locations:

- Codex local install from this repo's helper script:
  - `~/plugins/second-opinion-skill/bin/review.js`
  - `~/plugins/second-opinion-skill/bin/list.js`
- Claude Code marketplace install:
  - `~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/<version>/bin/review.js`
  - `~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/<version>/bin/list.js`
- Repo-local development:
  - `<repo>/bin/review.js`
  - `<repo>/bin/list.js`

Codex example:

```bash
REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
LIST_SCRIPT="$HOME/plugins/second-opinion-skill/bin/list.js"
```

Codex permissions are managed by the harness command approval flow. For Claude Code, add concrete resolved paths, for example:

```json
{
  "permissions": {
    "allow": [
      "Bash(~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js*)",
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
Code (cmd)**. It also symlinks the runner (`review.js`, `list.js`) onto your
`PATH` so every harness resolves it via `command -v` (the ones with no plugin
cache rely on this). Idempotent (safe to re-run); supports
`--only=claude,codex,cursor,opencode,gemini,qwen,copilot,agy,kilo,cmd`,
`--ref=<branch>`, and `--uninstall`. Or clone the repo and run `./install.sh`.

After installing: in Claude Code / Codex / Copilot / agy / cmd the review skills
load as plugins/skills; in opencode / kilo / Gemini / Qwen run
`/second-opinion <engine> <what to review>`; in Cursor ask for *"a second
opinion from codex on these changes"*.

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
cp .cursor/rules/second-opinion.mdc      ~/.cursor/rules/                  # Cursor
cp .opencode/command/second-opinion.md   ~/.config/opencode/command/       # opencode
cp .opencode/command/second-opinion.md   ~/.config/kilo/command/           # kilo (opencode fork)
cp commands/second-opinion.toml          ~/.qwen/commands/                 # Qwen (gemini fork)
```

Hosts without a plugin cache (Cursor, opencode, kilo, Gemini, Qwen) rely on
`review.js` being resolvable — `install.sh` puts it on `PATH`; otherwise also
install in a plugin-cache host (Claude Code / Codex) or set
`SECOND_OPINION_REVIEW=/abs/path/to/review.js`. All adapters embed the same
discovery snippet and are kept in sync by `test/locate.test.js`; the
host↔engine parity itself is enforced by `test/host-parity.test.js`.

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

When no engine is specified, the `second-opinion` skill asks you to pick one. Each engine-specific skill handles its own model flow: Gemini runs immediately; opencode and Kilo walk through provider → model selection; Codex, Claude Code, Copilot, and Qwen optionally let you type in a model; Antigravity optionally lets you pick from `agy models` (or uses its default); Command Code optionally lets you pick from `cmd --list-models` (or uses its default); Cursor optionally lets you pick from `agent --list-models` (or uses its default).

Results are structured: **Summary**, **Issues** (HIGH/MED/LOW tagged by domain), **Concerns**, **Positives**. The code review prompt instructs engines to spawn parallel sub-agents per domain where supported.

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

`review.js` never feeds `.env`-style secret files to an engine. By default it **refuses `--file=.env`**, **skips untracked `.env` files** from `--diff=unstaged`, and **redacts `.env` hunks** from any diff — matching `.env`, `.env.*`, and `*.env`, while exempting `*example*` / `*sample*` / `*template*` names. A prompt-level reminder also tells engines not to open env files themselves (covers `--no-embed` and sandbox engines that walk the tree). This is enforced in the runner, not left to the model. Pass `--include-secrets` to opt out when you genuinely need a `.env` reviewed.

### Exit codes

`review.js` exits `0` on success, `124` on timeout (matching GNU `timeout`), and **`3` when an engine exits cleanly but returns no usable output** — zero bytes (e.g. a transient upstream model outage), or, when wrapping is on, output missing the `<<<SECOND_OPINION_START>>>` envelope (truncated, refused, or sandbox-blocked). Any other non-zero code is the engine CLI's own. In a fusion run, each slot's code is annotated in the `FUSION COMPLETE` summary.

## Why cross-engine review?

Different models are trained on different data with different architectures. Gemini flags different categories of issues than Claude Code. opencode and Kilo give you access to GPT, Llama, Mistral, Qwen, and dozens of others. Running your changes through a differently-trained model before declaring done is the same instinct as a second engineer reading your PR — except it takes seconds.

## License

MIT
