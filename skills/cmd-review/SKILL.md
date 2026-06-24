---
name: cmd-review
description: Get a second opinion or code review from Command Code (`cmd`). Use this skill whenever the user says "ask Command Code", "cmd review", "review with cmd", "get Command Code's opinion", or wants a Command-Code-specific review. Also invoke proactively after completing any non-trivial code change — before declaring the task done — to get an independent perspective from a model trained differently. Model is optional — cmd uses its default unless the user specifies one with `--engine=cmd:<model>` (list choices with `cmd --list-models`).
---

# Command Code (cmd) Review

Use Command Code (`cmd`) to get a second opinion. Model is optional — `cmd` uses its default unless a model is given. All execution goes through `review.js`.

## Locating review.js

Resolve the runner (PATH first, then known install locations):
```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

Store the result as `REVIEW_SCRIPT`. Do not call `cmd` directly.

## Determining what to review

Pass the appropriate flag to `review.js` (it handles fetching and embeds diff/file content inline before the prompt):

| What to review | Flag |
|---|---|
| Unstaged changes | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom range | `--diff="HEAD~3..HEAD"` |
| Specific file | `--file=<absolute-path>` |
| General question | *(no flag)* |

## Running

```bash
"$REVIEW_SCRIPT" --engine=cmd --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

Model is optional. Bare `--engine=cmd` lets `cmd` pick its default. To pin a model, list the choices and pass the id verbatim:

```bash
cmd --list-models   # grouped list, e.g. "claude-sonnet-4-6", "gpt-5.5", "deepseek/deepseek-v4-flash"
"$REVIEW_SCRIPT" --engine=cmd:claude-sonnet-4-6 --cwd=<repo-path> [...] "<review template>"
```

`review.js` splits the engine spec on the first `:` only, so any model id survives intact. The runner launches it as `cmd --print --permission-mode plan --skip-onboarding [-m <model>] "<prompt>"`, so all calls run non-interactively in read-only plan mode with taste-onboarding skipped (no interactive hang in an automated run).

## Composing the prompt

For the full guidance on how to compose the prompt — when to embed the user's ongoing task / context (Tier A), when to fall back to default templates (Tier B), and when to use `--no-embed` for very large diffs (Tier C) — read the `second-opinion` skill. The default templates live there too.

## Safety toggle

By default `review.js` applies this engine's read-only / plan-mode flags (`--permission-mode plan`). Pass `--unrestricted` only when the engine genuinely needs to edit files or run commands; `review.js` will drop the safety flags and log a stderr warning. (`--skip-onboarding` is functional, not a safety flag, so it stays on even with `--unrestricted`.)

## Output envelope

`review.js` wraps every prompt with `<<<SECOND_OPINION_START>>>` / `<<<SECOND_OPINION_END>>>` markers and asks the engine to emit its real answer between them. After reading the log file, extract the text between the markers — that is the clean payload, free of reasoning traces and tool noise. Pass `--no-wrap` to disable.

## Capturing output

When `review.js` runs from an agent harness (non-TTY stdout), engine output is **not** streamed to stdout. It's written to a temp file, and stdout receives only a banner with the log path. After the command exits, use the Read tool on the path shown after `LOG FILE:` to get the full Command Code review. Don't pipe to `| tail -N` / `| head -N` — the engine output isn't on stdout in this mode. Pass `--log=<path>` for a known location; pass `--log=-` to restore tee-to-stdout behavior.

## Presenting results

Show Command Code's full response under a `## Command Code's Take` heading. Don't filter or summarize — let the raw review speak. If Command Code raises issues that need fixing, address them and note what changed.
