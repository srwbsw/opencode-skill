---
name: second-opinion
description: Get a second opinion or code review from an AI engine of your choice. Use when the user asks for "a second opinion", "another perspective", "independent review", "cross-model review", or wants a review without specifying a particular engine. Ask which engine to use first, then follow that engine's complete review workflow. For engine-specific requests ("ask gemini", "use opencode", "codex review", "claude review"), invoke the corresponding engine skill directly instead.
---

# Second Opinion

Orchestrates a cross-engine code review. All execution goes through `review.js` — resolve it once, then reuse it for every engine.

## Golden path

Resolve the runner, run it, read the answer. This is the whole workflow for a plain review.

```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

`$LIST_SCRIPT` is only needed for opencode/kilo provider+model discovery:

```bash
LIST_SCRIPT="${SECOND_OPINION_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-opinion-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
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

- Always invoke reviews through `"$REVIEW_SCRIPT"`. Never call `codex`, `gemini`, `claude`, `copilot`, `qwen`, `kilo`, `agy`, `cmd`, or `agent` directly for review work.
- Always read the ANSWER FILE with the Read tool. No ANSWER FILE line → read the LOG FILE path instead.
- Treat exit `3` as no-answer: retry the same engine or switch to another one.
- Prefer the default embedded-content path (`--diff=`/`--file=`). Reach for `--no-embed` only on very large diffs, and only with a shell-capable engine.
- Assume the spawned engine inherits the parent harness's sandbox; `--unrestricted` only lifts `review.js`'s own read-only flags, not outer harness permissions. Details: `references/troubleshooting.md`.

## Choose an engine and model

If the user already named an engine, use it — ask at most one bundled question: "default model, or a specific one? want a second engine to compare against?" For a bare "second opinion" request, ask one question with a recommended default (e.g. Gemini for a fast plain review, or a small fusion for higher-stakes changes).

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

**Model rules**, one line each:

- Gemini: no selection — bare `--engine=gemini`.
- Antigravity (agy): default `--engine=agy`, or list `agy models` and pass `--engine=agy:<model>` (quote the whole spec — names contain spaces/parens).
- opencode: default `--engine=opencode`, or two-step via `$LIST_SCRIPT` (`providers` then `models --provider=<p>`) → `--engine=opencode:<provider/model>`.
- Kilo: same two-step as opencode, free models listed first → `--engine=kilo:<provider/model>`.
- Codex: prefer bare `--engine=codex` unless the user names an exact model — never invent one. If a pinned model turns out unavailable, surface the failure and ask before retrying bare.
- Claude Code / Copilot / Qwen: type-in only (no listing command) → `--engine=<eng>:<model>`, or bare for default.
- Command Code (cmd): default `--engine=cmd`, or list `cmd --list-models` → `--engine=cmd:<model>`.
- Cursor (agent): default `--engine=cursor`, or list `agent --list-models` → `--engine=cursor:<model>` (`cursor`/`cursor-agent`/`agent` are interchangeable).

Adding the same `(engine, model)` tuple twice is deduped silently — `review.js` dedups too. The same engine with different models is fine, and is how you compare two models head-to-head.

## What to review

`review.js` embeds diff/file content directly into the prompt as a `<diff>`/`<file>` block — engines don't self-read by default, so no manual fetch instructions are needed. `--diff=unstaged` also includes untracked files; repeat `--file=` for multiple files, or prefer `--diff=unstaged` when the change spans new + modified files.

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

Model selection is always inline (`--engine=name:model`); there is no separate `--model=` flag.

Single engine, default model:

```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=. --diff=branch "Review this diff for correctness, regressions, and missing tests."
```

Specific engine, specific model:

```bash
"$REVIEW_SCRIPT" --engine=claude:sonnet-4 --cwd=. --file="$PWD/src/app.ts" "Review this file for bugs and maintainability issues."
```

Fusion — three engines, one prompt, aggregated result:

```bash
"$REVIEW_SCRIPT" --engine=gemini --engine=codex:gpt-5 --engine=claude --cwd=. --diff=branch "Review this diff for architecture, security, and test gaps."
```

Multi-engine mechanics (parallel vs sequential, rate limiting, log layout, exit-code aggregation): `references/fusion.md`.

## Safety (`--unrestricted`)

Each engine defaults to a read-only / sandboxed / plan mode (e.g. codex `-s read-only`, claude `--permission-mode plan`, gemini `-s --approval-mode plan`). That is the right default for a pure second opinion. Pass `--unrestricted` only when the task genuinely needs the engine to edit files, run tests, or execute commands — decide deliberately, since `review.js` drops the safety flags and logs a stderr warning.

## Secrets (`--include-secrets`)

`review.js` keeps `.env`-style files out of the engine by default: it refuses `--file=.env`, skips untracked `.env` files from `--diff=unstaged`, and redacts `.env` hunks from diffs. Pass `--include-secrets` only when the user explicitly wants a real secrets file reviewed — see `references/troubleshooting.md` for the exact matching rules.

## More detail

- Prompt tiers (specific-question vs plain-diff vs large-diff) and the full template set: `references/prompts.md`
- Multi-engine fusion mechanics, concurrency, rate limits, exit-code aggregation: `references/fusion.md`
- Anti-patterns, sandbox/login-shell notes, `--no-embed` caveats, launcher verification, exit codes: `references/troubleshooting.md`
- Adding a new engine to `review.js`/`list.js`: `references/adding-engines.md`
