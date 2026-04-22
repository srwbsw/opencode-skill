---
name: codex-review
description: Get a second opinion or code review from Codex CLI. Use this skill whenever the user says "ask Codex", "review with Codex", "Codex review", "get Codex's opinion", or wants a Codex-specific review. No model is required — Codex uses its configured default. If the user wants a specific model, they can provide the name.
version: 1.0.0
---

# Codex Review

Use Codex CLI to get a second opinion. All execution goes through `review.js` with `--sandbox read-only`.

## Locating review.js

Find the script with:
```bash
find ~/.claude -name "review.js" -path "*/second-opinion-skill/*" 2>/dev/null | head -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `codex` directly.

## Model selection (optional)

Codex uses its configured default model if no model is specified. Ask the user whether they want to specify a model or use the default. If they choose to specify, prompt for the model name (they must know it; there is no listing command).

Pass `--model=<model>` to `review.js` if provided. Omit the flag entirely for the default.

## Getting content to pipe

**Staged or unstaged git changes:**
```bash
git -C <repo-path> diff
git -C <repo-path> diff --staged
```

**Recent commit:**
```bash
git -C <repo-path> diff HEAD~1
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

**Without model (use default):**
```bash
<content> | "$REVIEW_SCRIPT" --engine=codex "<structured prompt>"
```

**With a specific model:**
```bash
<content> | "$REVIEW_SCRIPT" --engine=codex --model=<model> "<structured prompt>"
```

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show Codex's full response under a `## Codex's Take` heading (include model name if one was specified: `## Codex's Take (<model>)`). Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
