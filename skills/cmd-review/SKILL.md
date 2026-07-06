---
name: cmd-review
description: Get a second opinion or code review from Command Code (`cmd`). Use this skill whenever the user says "ask Command Code", "cmd review", "review with cmd", "get Command Code's opinion", or wants a Command-Code-specific review. Also invoke proactively after completing any non-trivial code change — before declaring the task done — to get an independent perspective from a model trained differently. Model is optional — cmd uses its default unless the user specifies one with `--engine=cmd:<model>` (list choices with `cmd --list-models`).
---

# Command Code (cmd) Review

Use Command Code (`cmd`) to get a second opinion, routed through `review.js`. Model is optional — `cmd` uses its default unless you pin one.

## Golden path

Resolve the runner:

```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

Run it:

```bash
# 1. Run (REVIEW_SCRIPT resolved by the snippet above):
"$REVIEW_SCRIPT" --engine=<engine> --cwd=<repo> --diff=unstaged "<review prompt>"
# 2. Result: stdout prints `ANSWER FILE: <path>`; the last line is a SECOND_OPINION_RESULT JSON.
#    Read the ANSWER FILE with the Read tool — it is the engine's clean answer.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```

## Model selection

Bare `--engine=cmd` uses the default. To pin one, run `cmd --list-models` (grouped list, e.g. "claude-sonnet-4-6", "gpt-5.5", "deepseek/deepseek-v4-flash") and pass `--engine=cmd:<model>`.

## What to review

Pass one flag — `review.js` embeds the content inline:

| What to review | Flag |
|---|---|
| Unstaged changes | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom range | `--diff="HEAD~3..HEAD"` |
| Specific file | `--file=<absolute-path>` |
| General question | *(no flag)* |

## Default review prompt

Use as-is with no extra context to add; for more, see the `second-opinion` skill's `references/prompts.md`.

```
Review this as a senior engineer. Cover:
- **Correctness**: logic errors, edge cases, error handling, concurrency/race conditions, boundary bugs
- **Security**: injection, auth/access-control gaps, unsafe input handling, secrets exposure
- **Regression**: what existing behavior this could break
- **Test coverage**: what's untested or would fail silently
- **Maintainability**: naming, readability, duplication, dead code

Output:
**Summary**: what this does, one sentence
**Issues**: [HIGH/MED/LOW] description → fix
**Concerns**: minor notes not worth a fix
**Positives**: what's done well (brief)

If nothing is wrong, say so plainly. Prioritize HIGH-severity correctness/security findings over style.
```

## Run it

```bash
# Default model:
"$REVIEW_SCRIPT" --engine=cmd --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review prompt>"

# Pinned model:
"$REVIEW_SCRIPT" --engine=cmd:claude-sonnet-4-6 --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review prompt>"
```

Launches as `cmd --print --permission-mode plan --skip-onboarding [-m <model>] "<prompt>"` — `--skip-onboarding` is functional, not safety, so it survives `--unrestricted` (avoids an interactive-onboarding hang).

## Reading the result

Stdout prints `ANSWER FILE: <path>`; the last line is a `SECOND_OPINION_RESULT: {...}` JSON. Read the ANSWER FILE with the Read tool for Command Code's clean answer.
No ANSWER FILE line? Read the LOG FILE path instead. Exit `3` means no usable answer — retry, or switch engines.

## Safety toggle

By default `review.js` adds `--permission-mode plan`. Pass `--unrestricted` only when `cmd` needs to edit files or run commands — `review.js` drops that flag (not `--skip-onboarding`), logged to stderr.

## Presenting results

Show the full response under `## Command Code's Take` (`(<model>)` if pinned). Don't filter or summarize — fix issues raised and note what changed.
