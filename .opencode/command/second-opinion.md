---
description: Cross-engine second opinion / code review — runs second-opinion-skill's review.js against another AI engine
---

Get an independent second-opinion code review by running the `second-opinion-skill` runner (`review.js`). The runner spawns another engine's CLI (read-only) and embeds the diff/file content into the prompt — you do not call the engine CLIs directly.

User request: $ARGUMENTS

## 1. Resolve the runner

PATH first, then known install locations (Codex local install, Claude Code marketplace cache, repo checkout):

```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

If `$REVIEW_SCRIPT` is empty or not executable, tell the user to install second-opinion-skill in Claude Code or Codex (or set `SECOND_OPINION_REVIEW=/abs/path/to/review.js`), then stop.

## 2. Run the review

Pick the engine(s) from the request — default to `gemini` if none is named. Models are inline (`--engine=name:model`); `opencode` requires a model. Choose the diff scope from the request (default `--diff=unstaged`):

```bash
"$REVIEW_SCRIPT" --engine=<engine>[:<model>] --cwd=. --diff=unstaged "<review prompt reflecting the user's request>"
```

- Scope flags: `--diff=branch`, `--diff=staged`, `--diff=last-commit`, `--diff="HEAD~3..HEAD"`, or `--file=<absolute-path>` (repeatable). No flag → standalone question.
- Multiple engines: repeat `--engine=` (fusion). Reviews run read-only by default; add `--unrestricted` only if the engine must edit/run.

## 3. Present the result

In a non-TTY run the runner writes engine output to a log file and prints a `LOG FILE:` path (do not pipe to `tail`/`head`). Read that file, extract the text between the LAST `<<<SECOND_OPINION_START>>>` and `<<<SECOND_OPINION_END>>>` markers, and present it under a clear heading (e.g. `## Gemini's take`). Exit code `3` means the engine produced no usable output — retry or pick another engine.
