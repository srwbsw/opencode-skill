---
name: second-agent
description: Get a second opinion, code review, or delegate a task (write code, fix a bug, refactor) to Gemini, opencode, Codex, Claude Code, Copilot, Qwen, Kilo, Antigravity (agy), Command Code (cmd), Cursor, or Kiro CLI. Covers generic requests ("a second opinion", "another perspective", "independent review", "cross-model review") and engine-named ones ("ask Gemini", "codex review", "use opencode", "have Cursor fix this", "Qwen's take", "ask Copilot", "agy review", "cmd review", "kilo's take", "ask kiro-cli", "Claude review"). Named engine → use it directly, skip to model selection, don't ask which engine. Unnamed → ask once, with a recommended default.
---

# Second Agent

Orchestrates cross-engine review and task delegation. Review goes through `review.js`; tasks through its sibling `agent.js` (`## Task mode` below) — resolve the one you need, then reuse it per engine.

## Golden path

Resolve the runner, run it, read the answer. This is the whole workflow for a plain review.

```bash
REVIEW_SCRIPT="${SECOND_AGENT_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-agent-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

`$LIST_SCRIPT` is only needed for opencode/kilo provider+model discovery:

```bash
LIST_SCRIPT="${SECOND_AGENT_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-agent-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```

Then run it and read the result:

```bash
# 1. Run (REVIEW_SCRIPT resolved by the snippet above):
"$REVIEW_SCRIPT" --engine=<engine> --cwd=<repo> --diff=unstaged "<review prompt>"
# 2. Result: stdout prints `ANSWER FILE: <path>`; the last line is a SECOND_OPINION_RESULT JSON.
#    Read the ANSWER FILE with the Read tool — it is the engine's clean answer.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```

## Execution contract

- Always invoke reviews through `"$REVIEW_SCRIPT"`, never the engine CLIs directly. Exit `3` = no-answer: retry or switch engines.
- Prefer the default embedded-content path (`--diff=`/`--file=`); `--no-embed` only for very large diffs, with a shell-capable engine.
- Spawned engines inherit the parent harness's sandbox; `--unrestricted` only lifts `review.js`'s own read-only flags, not outer permissions. Details: `references/troubleshooting.md`.

## Choose an engine and model

Named engine → use it directly, skip straight to model selection (ask at most one bundled question: default/specific model, plus a second engine to compare?). No engine named → ask one question, recommended default (e.g. Gemini for speed, fusion for higher stakes).

**Engines**:

| Engine | Model selection | Notes |
|---|---|---|
| Gemini CLI | Automatic (no model selector) | sandbox + plan mode |
| opencode | Optional — pick from registry, or default | 50+ models across providers |
| Codex CLI | Optional — type-in, no listing | `-s read-only` |
| Claude Code | Optional — type-in, no listing | `--print --permission-mode plan` |
| GitHub Copilot CLI | Optional — type-in | `-s --plan --allow-all-tools --deny-tool=write`; needs `copilot` in PATH |
| Qwen Code CLI | Optional — type-in | `-s --approval-mode plan` |
| Kilo | Provider → model (free first) | `--agent plan` |
| Antigravity (agy) | Optional — list via `agy models`, or default | `--sandbox --print` |
| Command Code (cmd) | Optional — list via `cmd --list-models`, or default | `--print --permission-mode plan --skip-onboarding` |
| Cursor (agent) | Optional — list via `agent --list-models`, or default | `--print --plan --trust` |
| Kiro CLI (kiro-cli) | Optional — `kiro-cli chat --list-models`, or default | `chat --no-interactive --trust-tools=` (additive — `--unrestricted` adds `--trust-all-tools`) |

**Model rules**, one line each:

- Gemini: no selection — bare `--engine=gemini`.
- Antigravity (agy): default `--engine=agy`, or list `agy models` and pass `--engine=agy:<model>` (quote the whole spec — names contain spaces/parens).
- opencode: default `--engine=opencode`, or two-step via `$LIST_SCRIPT` (`providers` then `models --provider=<p>`) → `--engine=opencode:<provider/model>`.
- Kilo: same two-step as opencode, free models listed first → `--engine=kilo:<provider/model>`.
- Codex: prefer bare `--engine=codex` — never invent a model. If a pinned model is unavailable, surface the failure and ask before retrying bare.
- Claude Code / Copilot / Qwen: type-in only (no listing command) → `--engine=<eng>:<model>`, or bare for default.
- Command Code (cmd): default `--engine=cmd`, or list `cmd --list-models` → `--engine=cmd:<model>`.
- Cursor (agent): default `--engine=cursor`, or list `agent --list-models` → `--engine=cursor:<model>` (`cursor`/`cursor-agent`/`agent` are interchangeable).
- Kiro CLI: default `--engine=kiro-cli`, or list `kiro-cli chat --list-models` → `--engine=kiro-cli:<model>` (alias `kiro`).

The same `(engine, model)` tuple twice dedupes silently; the same engine with different models is fine — that's how you compare two models head-to-head.

## What to review

`review.js` embeds diff/file content directly into the prompt as a `<diff>`/`<file>` block — engines don't self-read by default. `--diff=unstaged` also includes untracked files; repeat `--file=` for multiple files, or prefer `--diff=unstaged` when the change spans new + modified files.

| What to review | Flag |
|---|---|
| Unstaged changes (incl. untracked) | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom revision range | `--diff="HEAD~3..HEAD"` |
| Specific file(s) | `--file=<absolute-path>` (repeatable) |
| General question | *(no flag — prompt is standalone)* |

## Run it

```bash
"$REVIEW_SCRIPT" --engine=<name>[:<model>] [--engine=...] --cwd=<repo-path> \
  [--diff=<spec>|--file=<path>] [--no-embed] [--unrestricted] [--concurrency=<n>] \
  "<prompt>" [--engine-arg=<arg> ... | -- <engine-args...>]
```

Model selection is always inline (`--engine=name:model`); there is no separate `--model=` flag. Example:

```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=. --diff=branch "Review this diff for correctness, regressions, and missing tests."
```

Fusion (repeat `--engine=` for multiple slots, one aggregated result) — mechanics, parallel vs sequential, rate limiting, log layout, exit-code aggregation: `references/fusion.md`.

## Safety (`--unrestricted`)

Each engine defaults to a read-only / sandboxed / plan mode (e.g. codex `-s read-only`, claude `--permission-mode plan`). That is right for a pure second opinion. Pass `--unrestricted` only when the task genuinely needs the engine to edit files or run commands — `review.js` drops the safety flags and logs a stderr warning.

## Secrets (`--include-secrets`)

`review.js` keeps `.env`-style files out by default: refuses `--file=.env`, skips untracked `.env` files, and redacts `.env` diff hunks. Pass `--include-secrets` only when the user explicitly wants a real secrets file reviewed — matching rules: `references/troubleshooting.md`.

## Task mode — delegating a task instead of reviewing it

`agent.js` is `review.js`'s sibling: it asks one engine to DO a task (write tests, fix a bug, refactor) inside `--cwd`, instead of just commenting. Use it only when read-only consultation isn't enough.

Resolve the task runner:

```bash
AGENT_SCRIPT="${SECOND_AGENT_TASK:-$(command -v agent.js || true)}"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$HOME/plugins/second-agent-skill/bin/agent.js"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/agent.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$PWD/bin/agent.js"
```

Run it, then read the result:

```bash
# 1. Run (AGENT_SCRIPT resolved by the snippet above). --unrestricted is a
#    deliberate acknowledgment that the engine may edit files and run
#    commands inside --cwd — there is no read-only mode for agent.js:
"$AGENT_SCRIPT" --engine=<engine> --cwd=<repo> --unrestricted "<task prompt>"
# 2. Result: stdout prints a CHANGED FILES: block, then `ANSWER FILE: <path>`;
#    the last line is a SECOND_AGENT_RESULT JSON (includes `changes`).
#    Read the ANSWER FILE with the Read tool for the engine's report.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```

One engine per call, no fusion. `--unrestricted` is REQUIRED (hard gate, exit 1 without it) — no read-only mode exists here. Same engine/model selection as above. `--diff=`/`--file=` are context, not the task — state the task in the prompt. `CHANGED FILES:`/`changes` in `SECOND_AGENT_RESULT` are ground truth: `NO REPORT` (changes, no envelope) isn't a failure, but `exit: 3` means neither landed.

### Default task prompt

```
<task statement — what to build/fix/change, and why>

Constraints:
- Make the minimal change needed; do not refactor unrelated code.
- Follow this repo's existing conventions, style, and file layout.
- Do not touch test files unless the task explicitly asks for it.

Verify by running the project's test suite (and linter/typecheck, if any)
before reporting done. If no test suite exists, say so explicitly.

Report:
**Changed**: files touched, and why
**Verified**: tests/commands run, and their results
**Left undone**: anything incomplete, deferred, or out of scope
```

## More detail

- Prompt tiers and the full template set: `references/prompts.md`
- Fusion mechanics, concurrency, rate limits, exit-code aggregation: `references/fusion.md`
- Anti-patterns, sandbox notes, `--no-embed` caveats, exit codes: `references/troubleshooting.md`
- Adding a new engine to `review.js`/`agent.js`/`list.js`: `references/adding-engines.md`
