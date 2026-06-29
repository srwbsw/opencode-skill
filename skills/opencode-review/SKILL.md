---
name: opencode-review
description: Get a second opinion or code review from opencode CLI. Use this skill whenever the user says "use opencode", "ask opencode", "review with opencode", "get opencode's opinion", or wants a second opinion from a model available through opencode. Model is optional — opencode uses its configured default unless the user wants to pick a provider/model.
---

# Opencode Review

Use `opencode run` non-interactively to get a second opinion via `review.js`. Model is **optional**: bare `--engine=opencode` lets opencode use its configured default model; or the user can pick a specific provider → model.

## Step 0: Default or pick?

Ask the user: **use opencode's default model, or pick a provider/model?**

- **Default** → skip Steps 1–2; run with bare `--engine=opencode` (Step 4).
- **Pick** → do Steps 1–2 to choose `provider/model`.

If the user already named a model (e.g. "ask opencode with gpt-5"), skip the question and resolve it via Steps 1–2.

## Locating review.js

Resolve the runner and discovery helper (PATH first, then known install locations):
```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"

LIST_SCRIPT="${SECOND_OPINION_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-opinion-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```

Store the results as `REVIEW_SCRIPT` and `LIST_SCRIPT`. Use `LIST_SCRIPT` for all provider/model discovery — do not call `opencode` directly.

## Step 1: Provider selection

```bash
node "$LIST_SCRIPT" --engine=opencode providers
```

The script returns `opencode` first (default), then others alphabetically. If the result has only one entry, skip asking and use that provider automatically. Otherwise ask the user with up to 4 options.

## Step 2: Model selection

```bash
node "$LIST_SCRIPT" --engine=opencode models --provider=<provider>
```

The script returns a deduplicated, sorted list with dated preview variants already stripped. Print the list in your response so the user sees their options, then ask the user with 3–4 of the most capable/current models plus "Other" for any other entry from the list.

The chosen model must be a valid `provider/model` string from the output (e.g., `opencode/nemotron-3-super-free`, `google/gemini-2.5-pro`, `github-copilot/gpt-5.4`).

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

With `REVIEW_SCRIPT`, the repo path, and the chosen flag — fire the single command. Use the bare form for the default model, or bind `provider/model` if the user picked one:

```bash
# Default model (Step 0 → default):
"$REVIEW_SCRIPT" --engine=opencode --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"

# Specific model (Step 0 → pick):
"$REVIEW_SCRIPT" --engine=opencode:<provider/model> --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

## Composing the prompt

For the full guidance on how to compose the prompt — when to embed the user's ongoing task / context (Tier A), when to fall back to default templates (Tier B), and when to use `--no-embed` for very large diffs (Tier C) — read the `second-opinion` skill. The default templates live there too.

## Safety toggle

By default `review.js` applies this engine's read-only / sandbox / plan-mode flags. Pass `--unrestricted` only when the engine genuinely needs to edit files or run commands; `review.js` will drop the safety flags and log a stderr warning.

## Output envelope

`review.js` wraps every prompt with `<<<SECOND_OPINION_START>>>` / `<<<SECOND_OPINION_END>>>` markers and asks the engine to emit its real answer between them. After reading the log file, extract the text between the markers — that is the clean payload, free of reasoning traces and tool noise. Pass `--no-wrap` to disable.

## Capturing output

When `review.js` runs from an agent harness (non-TTY stdout), engine output is **not** streamed to stdout. It's written to a temp file, and stdout receives only a banner with the log path. After the command exits, use the Read tool on the path shown after `LOG FILE:` to get the full opencode review. Don't pipe to `| tail -N` / `| head -N` — the engine output isn't on stdout in this mode. Pass `--log=<path>` for a known location; pass `--log=-` to restore tee-to-stdout behavior.

## Presenting results

Show the full response under a `## Opencode's Take (<model>)` heading — include the model name so the user knows which perspective they're getting. Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
