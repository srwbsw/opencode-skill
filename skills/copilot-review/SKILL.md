---
name: copilot-review
description: Get a second opinion or code review from GitHub Copilot CLI. Use this skill whenever the user says "ask Copilot", "review with Copilot", "Copilot review", "get Copilot's opinion", or wants a Copilot-specific review. The model is optional — Copilot uses its default unless the user specifies one with --model.
version: 1.0.0
---

# Copilot Review

Use GitHub Copilot CLI to get a second opinion. All execution goes through `review.js` with `--plan` and `--deny-tool=write` safety flags.

## Locating review.js

Find the script with:
```bash
ls ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | tail -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `copilot` directly.

## Model selection (optional)

Copilot uses its default model if no model is specified. Ask the user whether they want to specify a model or use the default. If they choose to specify, prompt for the model name (they must know it; there is no listing command).

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
"$REVIEW_SCRIPT" --engine=copilot --cwd=<repo-path> "<structured prompt>"
```

**With a specific model:**
```bash
"$REVIEW_SCRIPT" --engine=copilot --model=<model> --cwd=<repo-path> "<structured prompt>"
```

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show Copilot's full response under a `## Copilot's Take` heading (include model name if one was specified: `## Copilot's Take (<model>)`). Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
