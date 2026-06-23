---
name: kilo-review
description: Get a second opinion or code review from kilo CLI using a user-selected AI model. Use this skill whenever the user says "ask Kilo", "review with Kilo", "Kilo's take", "get Kilo's opinion", or wants a second opinion from a specific model available through kilo. Always ask provider first, then model — show free models first.
---

# Kilo Review

Use `kilo run` non-interactively to get a second opinion from a model the user chooses. The flow is always: pick provider → pick model → run via `review.js`.

## Locating review.js

Resolve the runner and discovery helper (PATH first, then known install locations):
```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/.agents/plugins/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"

LIST_SCRIPT="${SECOND_OPINION_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/.agents/plugins/plugins/second-opinion-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```

Store the results as `REVIEW_SCRIPT` and `LIST_SCRIPT`. Use `LIST_SCRIPT` for all provider/model discovery — do not call `kilo` directly.

## Step 1: Provider selection

```bash
node "$LIST_SCRIPT" --engine=kilo providers
```

If the result has only one entry, skip asking and use that provider automatically. Otherwise ask the user to choose from the results.

## Step 2: Model selection

```bash
node "$LIST_SCRIPT" --engine=kilo models --provider=<provider>
```

The script returns free models first, then paid. Present the first 3–4 lines as quick-pick options, plus "Other (paid)" for the user to type any entry from the full list.

The chosen model must be a valid `kilo/<provider>/<model>` string from the output.

## Step 3: Determining what to review

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

## Step 4: Run

With `REVIEW_SCRIPT`, the chosen `MODEL`, the repo path, and the chosen flag — fire the single command:

```bash
"$REVIEW_SCRIPT" --engine=kilo:<kilo/provider/model> --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

## Composing the prompt

For the full guidance on how to compose the prompt — when to embed the user's ongoing task / context (Tier A), when to fall back to default templates (Tier B), and when to use `--no-embed` for very large diffs (Tier C) — read the `second-opinion` skill. The default templates live there too.

## Safety toggle

By default `review.js` applies this engine's read-only / sandbox / plan-mode flags. Pass `--unrestricted` only when the engine genuinely needs to edit files or run commands; `review.js` will drop the safety flags and log a stderr warning.

## Output envelope

`review.js` wraps every prompt with `<<<SECOND_OPINION_START>>>` / `<<<SECOND_OPINION_END>>>` markers and asks the engine to emit its real answer between them. After reading the log file, extract the text between the markers — that is the clean payload, free of reasoning traces and tool noise. Pass `--no-wrap` to disable.

## Capturing output

When `review.js` runs from an agent harness (non-TTY stdout), engine output is **not** streamed to stdout. It's written to a temp file, and stdout receives only a banner with the log path. After the command exits, use the Read tool on the path shown after `LOG FILE:` to get the full Kilo review. Don't pipe to `| tail -N` / `| head -N` — the engine output isn't on stdout in this mode. Pass `--log=<path>` for a known location; pass `--log=-` to restore tee-to-stdout behavior.

## Presenting results

Show the full response under a `## Kilo's Take (<model>)` heading — include the model name so the user knows which perspective they're getting. Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
