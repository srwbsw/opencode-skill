---
name: opencode-review
description: Get a second opinion or code review from opencode CLI using a user-selected AI model. Use this skill whenever the user says "use opencode", "ask opencode", "review with opencode", "get opencode's opinion", or wants a second opinion from a specific model available through opencode. Always ask the user to pick a provider then a model before running — default to the opencode/* provider first.
version: 2.1.0
---

# Opencode Review

Use `opencode run` non-interactively to get a second opinion from a model the user chooses. The flow is always: pick provider → pick model → run via `review.js`.

## Locating review.js

Find the script with:
```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | sort -V | tail -1
```

Store the result as `REVIEW_SCRIPT`.

Also locate `list.js` the same way:
```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | sort -V | tail -1
```
Store as `LIST_SCRIPT`. Use it for all provider/model discovery — do not call `opencode` directly.

## Step 1: Provider selection

```bash
node "$LIST_SCRIPT" --engine=opencode providers
```

The script returns `opencode` first (default), then others alphabetically. If the result has only one entry, skip `AskUserQuestion` and use that provider automatically. Otherwise present as `AskUserQuestion` with up to 4 options.

## Step 2: Model selection

```bash
node "$LIST_SCRIPT" --engine=opencode models --provider=<provider>
```

The script returns a deduplicated, sorted list with dated preview variants already stripped. Print the list in your response so the user sees their options, then use `AskUserQuestion` with 3–4 of the most capable/current models plus "Other" for any other entry from the list.

The chosen model must be a valid `provider/model` string from the output (e.g., `opencode/nemotron-3-super-free`, `google/gemini-2.5-pro`, `github-copilot/gpt-5.4`).

## Step 3: Determining what to review

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

## Step 4: Run

With `REVIEW_SCRIPT`, the chosen `MODEL`, the repo path, and the chosen flag — fire the single command:

```bash
"$REVIEW_SCRIPT" --engine=opencode --model=<provider/model> --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show the full response under a `## Opencode's Take (<model>)` heading — include the model name so the user knows which perspective they're getting. Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
