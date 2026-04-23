---
name: qwen-review
description: Get a second opinion or code review from Qwen CLI. Use this skill whenever the user says "ask Qwen", "review with Qwen", "Qwen's take", "get Qwen's opinion", or wants a Qwen-specific review. Also invoke proactively after completing any non-trivial code change — before declaring the task done — to get an independent perspective from a model trained differently. No model selection needed — Qwen CLI uses its configured default, but user can optionally specify a model with `-m <model>`.
version: 1.0.0
---

# Qwen Review

Use Qwen CLI to get a second opinion. No model selection step required — Qwen CLI handles that automatically. All execution goes through `review.js`.

## Locating review.js

Find the script with:
```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | sort -V | tail -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `qwen` directly.

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
"$REVIEW_SCRIPT" --engine=qwen [--model=<model>] --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

No `--model` flag is required — Qwen CLI uses its configured default. If the user wants to specify a model, ask "use default or specify a model?" and include `--model=<model>` if they provide one.

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show Qwen's full response under a `## Qwen's Take` heading (or `## Qwen's Take (<model>)` if a specific model was requested). Don't filter or summarize — let the raw review speak. If Qwen raises issues that need fixing, address them and note what changed.
