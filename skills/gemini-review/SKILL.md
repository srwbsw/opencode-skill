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
find ~/.claude -name "review.js" -path "*/second-opinion-skill/*" 2>/dev/null | head -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `gemini` directly.

## Getting content to pipe

**Staged or unstaged git changes:**
```bash
git -C <repo-path> diff
git -C <repo-path> diff --staged
```

**Recent commits:**
```bash
git -C <repo-path> diff HEAD~1
git -C <repo-path> show HEAD
```

**Specific file:**
```bash
cat <absolute-path>
```

**Multiple files:**
```bash
cat <file1> <file2>
```

If the content is already in context, pipe it via a heredoc or `echo`.

## Running

```bash
<content> | "$REVIEW_SCRIPT" --engine=gemini "<structured prompt>"
```

No `--model` flag needed — Gemini CLI picks automatically.

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show Gemini's full response under a `## Gemini's Take` heading. Don't filter or summarize — let the raw review speak. If Gemini raises issues that need fixing, address them and note what changed.
