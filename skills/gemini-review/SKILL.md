---
name: gemini-review
description: Get a second opinion or code review from Gemini CLI. Use this skill whenever the user says "ask Gemini", "review with Gemini", "get Gemini's opinion", "what does Gemini think", or wants a Gemini-specific review. Also invoke proactively after completing any non-trivial code change — before declaring the task done — to get an independent perspective from a model trained differently. No model selection needed — Gemini CLI picks automatically.
---

# Gemini Review

Use Gemini CLI to get a second opinion. No model selection step — Gemini CLI handles that automatically. All execution goes through `review.js`.

## Locating review.js

Find the script with:
```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | sort -V | tail -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `gemini` directly.

## Determining what to review

Pass the appropriate flag to `review.js` (it handles fetching and injects the read instruction automatically):

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
"$REVIEW_SCRIPT" --engine=gemini --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

No `--model` flag needed — Gemini CLI picks automatically.

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show Gemini's full response under a `## Gemini's Take` heading. Don't filter or summarize — let the raw review speak. If Gemini raises issues that need fixing, address them and note what changed.
