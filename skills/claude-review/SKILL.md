---
name: claude-review
description: Get a second opinion or code review from Claude Code. Use this skill whenever the user says "ask Claude", "review with Claude", "Claude review", "Claude Code review", or wants a Claude-specific review. The model is optional — Claude uses its configured default unless the user specifies one with `--engine=claude:<model>`.
---

# Claude Review

Use Claude Code to get a second opinion. All execution goes through `review.js` with `--print` and `--permission-mode plan`.

## Locating review.js

Resolve the runner (PATH first, then known install locations):
```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

Store the result as `REVIEW_SCRIPT`. Do not call `claude` directly.

## Model selection (optional)

Claude uses its default model if no model is specified. Ask the user whether they want to specify a model or use the default. If they choose to specify, prompt for the model name (they must know it; there is no listing command).

Pass the model inline as `--engine=claude:<model>` if provided. Use bare `--engine=claude` for the default.

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
"$REVIEW_SCRIPT" --engine=claude:<model> --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

## Composing the prompt

For the full guidance on how to compose the prompt — when to embed the user's ongoing task / context (Tier A), when to fall back to default templates (Tier B), and when to use `--no-embed` for very large diffs (Tier C) — read the `second-opinion` skill. The default templates live there too.

## Safety toggle

By default `review.js` applies this engine's read-only / sandbox / plan-mode flags. Pass `--unrestricted` only when the engine genuinely needs to edit files or run commands; `review.js` will drop the safety flags and log a stderr warning.

## Output envelope

`review.js` wraps every prompt with `<<<SECOND_OPINION_START>>>` / `<<<SECOND_OPINION_END>>>` markers and asks the engine to emit its real answer between them. After reading the log file, extract the text between the markers — that is the clean payload, free of reasoning traces and tool noise. Pass `--no-wrap` to disable.

## Capturing output

When `review.js` runs from an agent harness (non-TTY stdout), engine output is **not** streamed to stdout. It's written to a temp file, and stdout receives only a banner with the log path. After the command exits, use the Read tool on the path shown after `LOG FILE:` to get the full Claude review. Don't pipe to `| tail -N` / `| head -N` — the engine output isn't on stdout in this mode. Pass `--log=<path>` for a known location; pass `--log=-` to restore tee-to-stdout behavior.

## Presenting results

Show Claude's full response under a `## Claude's Take` heading (include model name if one was specified: `## Claude's Take (<model>)`). Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
