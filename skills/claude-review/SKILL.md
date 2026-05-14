---
name: claude-review
description: Get a second opinion or code review from Claude Code. Use this skill whenever the user says "ask Claude", "review with Claude", "Claude review", "Claude Code review", or wants a Claude-specific review. The model is optional — Claude uses its configured default unless the user specifies one with `--model`.
---

# Claude Review

Use Claude Code to get a second opinion. All execution goes through `review.js` with `--print` and `--permission-mode plan`.

## Locating review.js

Find the script with:
```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | sort -V | tail -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `claude` directly.

## Model selection (optional)

Claude uses its default model if no model is specified. Ask the user whether they want to specify a model or use the default. If they choose to specify, prompt for the model name (they must know it; there is no listing command).

Pass `--model=<model>` to `review.js` if provided. Omit the flag entirely for the default.

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

**Without model (use default):**
```bash
"$REVIEW_SCRIPT" --engine=claude --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

**With a specific model:**
```bash
"$REVIEW_SCRIPT" --engine=claude --model=<model> --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show Claude's full response under a `## Claude's Take` heading (include model name if one was specified: `## Claude's Take (<model>)`). Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
