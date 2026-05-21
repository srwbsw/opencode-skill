---
name: gemini-review
description: Get a second opinion or code review from Gemini CLI. Use this skill whenever the user says "ask Gemini", "review with Gemini", "get Gemini's opinion", "what does Gemini think", or wants a Gemini-specific review. Also invoke proactively after completing any non-trivial code change — before declaring the task done — to get an independent perspective from a model trained differently. No model selection needed — Gemini CLI picks automatically.
---

# Gemini Review

Use Gemini CLI to get a second opinion. No model selection step — Gemini CLI handles that automatically. All execution goes through `review.js`.

## Locating review.js

Find the script with:
```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | sort -V | tail -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `gemini` directly.

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

```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

No model selector needed — Gemini CLI picks automatically. Always use bare `--engine=gemini` (no `:model` suffix).

## Composing the prompt

For the full guidance on how to compose the prompt — when to embed the user's ongoing task / context (Tier A), when to fall back to default templates (Tier B), and when to use `--no-embed` for very large diffs (Tier C) — read the `second-opinion` skill. The default templates live there too.

## Safety toggle

By default `review.js` applies this engine's read-only / sandbox / plan-mode flags. Pass `--unrestricted` only when the engine genuinely needs to edit files or run commands; `review.js` will drop the safety flags and log a stderr warning.

## Output envelope

`review.js` wraps every prompt with `<<<SECOND_OPINION_START>>>` / `<<<SECOND_OPINION_END>>>` markers and asks the engine to emit its real answer between them. After reading the log file, extract the text between the markers — that is the clean payload, free of reasoning traces and tool noise. Pass `--no-wrap` to disable.

## Capturing output

When `review.js` runs from an agent harness (non-TTY stdout), engine output is **not** streamed to stdout. It's written to a temp file, and stdout receives only a banner with the log path. After the command exits, use the Read tool on the path shown after `LOG FILE:` to get the full Gemini review. Don't pipe to `| tail -N` / `| head -N` — the engine output isn't on stdout in this mode. Pass `--log=<path>` for a known location; pass `--log=-` to restore tee-to-stdout behavior.

## Presenting results

Show Gemini's full response under a `## Gemini's Take` heading. Don't filter or summarize — let the raw review speak. If Gemini raises issues that need fixing, address them and note what changed.
