---
name: kilo-review
description: Get a second opinion or code review from kilo CLI using a user-selected AI model. Use this skill whenever the user says "ask Kilo", "review with Kilo", "Kilo's take", "get Kilo's opinion", or wants a second opinion from a specific model available through kilo. Always ask provider first, then model — show free models first.
version: 1.0.0
---

# Kilo Review

Use `kilo run` non-interactively to get a second opinion from a model the user chooses. The flow is always: pick provider → pick model → run via `review.js`.

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
Store as `LIST_SCRIPT`. Use it for all provider/model discovery — do not call `kilo` directly.

## Step 1: Provider selection

```bash
node "$LIST_SCRIPT" --engine=kilo providers
```

If the result has only one entry, skip `AskUserQuestion` and use that provider automatically. Otherwise present results as `AskUserQuestion` options.

## Step 2: Model selection

```bash
node "$LIST_SCRIPT" --engine=kilo models --provider=<provider>
```

The script returns free models first, then paid. Present the first 3–4 lines as `AskUserQuestion` quick-pick options, plus "Other (paid)" for the user to type any entry from the full list.

The chosen model must be a valid `kilo/<provider>/<model>` string from the output.

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
"$REVIEW_SCRIPT" --engine=kilo --model=<kilo/provider/model> --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show the full response under a `## Kilo's Take (<model>)` heading — include the model name so the user knows which perspective they're getting. Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
