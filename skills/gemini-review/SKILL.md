---
name: gemini-review
description: Get a second opinion or code review from Gemini CLI. Use this skill whenever the user says "ask Gemini", "review with Gemini", "get Gemini's opinion", "what does Gemini think", or wants a Gemini-specific review. Also invoke proactively after completing any non-trivial code change — before declaring the task done — to get an independent perspective from a model trained differently. No model selection needed — Gemini CLI picks automatically.
version: 2.0.0
---

# Gemini Review

Use Gemini CLI to get a second opinion. No model selection step — Gemini CLI handles that automatically. All execution goes through `review.js`.

## Locating review.js

Find the script with:
```bash
ls ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | tail -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `gemini` directly.

## Determining what to review

Ask or infer what to review, then build the prompt accordingly.

| What to review | Read instruction prefix |
|---|---|
| Unstaged changes | `"Run \`git diff\` to see unstaged changes in this repository, then:"` |
| Staged changes | `"Run \`git diff --staged\` to see staged changes, then:"` |
| Last commit | `"Run \`git diff HEAD~1\` to see the last commit, then:"` |
| Specific file | `"Read the file at <absolute-path>, then:"` |
| General question | *(no prefix — pass the question directly)* |

Construct the full prompt as:

```
<read instruction>

<review template>
```

## Running

```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=<repo-path> "<structured prompt>"
```

No `--model` flag needed — Gemini CLI picks automatically.

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show Gemini's full response under a `## Gemini's Take` heading. Don't filter or summarize — let the raw review speak. If Gemini raises issues that need fixing, address them and note what changed.
