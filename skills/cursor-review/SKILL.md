---
name: cursor-review
description: Get a second opinion or code review from Cursor's CLI agent (`agent`). Use this skill whenever the user says "ask Cursor", "cursor review", "review with cursor", "get Cursor's opinion", or wants a Cursor-specific review. Also invoke proactively after completing any non-trivial code change — before declaring the task done — to get an independent perspective from a model trained differently. Model is optional — Cursor uses its default unless the user specifies one with `--engine=cursor:<model>` (list choices with `agent --list-models`).
---

# Cursor CLI (agent) Review

Use Cursor's CLI agent to get a second opinion. The CLI binary is `agent` (also installed as `cursor-agent`); `review.js` accepts the engine names `cursor`, `cursor-agent`, and `agent` — all resolve to the same binary. Model is optional — Cursor uses its default unless one is given. All execution goes through `review.js`.

## Locating review.js

Find the script with:
```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | sort -V | tail -1
```

Store the result as `REVIEW_SCRIPT`. Do not call `agent` directly.

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
"$REVIEW_SCRIPT" --engine=cursor --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

Model is optional. Bare `--engine=cursor` lets Cursor pick its default. To pin a model, list the choices and pass the id verbatim:

```bash
agent --list-models   # e.g. "auto", "gpt-5.2", "sonnet-4", "sonnet-4-thinking"
"$REVIEW_SCRIPT" --engine=cursor:sonnet-4 --cwd=<repo-path> [...] "<review template>"
```

`review.js` splits the engine spec on the first `:` only, so any model id survives intact. The runner launches it as `agent --print --plan --trust [--model <model>] "<prompt>"`, so all calls run non-interactively in read-only plan mode. `--trust` is required for headless `--print` runs — without it Cursor prompts to trust the workspace and hangs an automated run.

## Composing the prompt

For the full guidance on how to compose the prompt — when to embed the user's ongoing task / context (Tier A), when to fall back to default templates (Tier B), and when to use `--no-embed` for very large diffs (Tier C) — read the `second-opinion` skill. The default templates live there too.

## Safety toggle

By default `review.js` applies this engine's read-only / plan-mode flag (`--plan`). Pass `--unrestricted` only when the engine genuinely needs to edit files or run commands; `review.js` will drop the safety flag and log a stderr warning. (`--trust` is functional, not a safety flag, so it stays on even with `--unrestricted`.)

## Output envelope

`review.js` wraps every prompt with `<<<SECOND_OPINION_START>>>` / `<<<SECOND_OPINION_END>>>` markers and asks the engine to emit its real answer between them. After reading the log file, extract the text between the markers — that is the clean payload, free of reasoning traces and tool noise. Pass `--no-wrap` to disable.

## Capturing output

When `review.js` runs from an agent harness (non-TTY stdout), engine output is **not** streamed to stdout. It's written to a temp file, and stdout receives only a banner with the log path. After the command exits, use the Read tool on the path shown after `LOG FILE:` to get the full Cursor review. Don't pipe to `| tail -N` / `| head -N` — the engine output isn't on stdout in this mode. Pass `--log=<path>` for a known location; pass `--log=-` to restore tee-to-stdout behavior.

## Presenting results

Show Cursor's full response under a `## Cursor's Take` heading. Don't filter or summarize — let the raw review speak. If Cursor raises issues that need fixing, address them and note what changed.
