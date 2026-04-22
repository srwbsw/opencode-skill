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
ls ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | tail -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `codex` directly.

## Model selection (optional)

Codex uses its configured default model if no model is specified. Ask the user whether they want to specify a model or use the default. If they choose to specify, prompt for the model name (they must know it; there is no listing command).

Pass `--model=<model>` to `review.js` if provided. Omit the flag entirely for the default.

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

**Without model (use default):**
```bash
"$REVIEW_SCRIPT" --engine=codex --cwd=<repo-path> "<structured prompt>"
```

**With a specific model:**
```bash
"$REVIEW_SCRIPT" --engine=codex --model=<model> --cwd=<repo-path> "<structured prompt>"
```

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show Codex's full response under a `## Codex's Take` heading (include model name if one was specified: `## Codex's Take (<model>)`). Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
