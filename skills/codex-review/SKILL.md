---
name: codex-review
description: Get a second opinion or code review from Codex CLI. Use this skill whenever the user says "ask Codex", "review with Codex", "Codex review", "get Codex's opinion", or wants a Codex-specific review. No model is required — Codex uses its configured default. If the user wants a specific model, they can provide the name.
---

# Codex Review

Use Codex CLI to get a second opinion, routed through `review.js` with `-s read-only`. Codex uses its configured default model unless the user names one explicitly.

Codex may itself run inside a sandboxed harness; the spawned engine still inherits that outer sandbox — see the `second-opinion` skill's execution contract before blaming the plugin for an engine failure.

## Golden path

Resolve the runner:

```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

Run it:

```bash
# 1. Run (REVIEW_SCRIPT resolved by the snippet above):
"$REVIEW_SCRIPT" --engine=<engine> --cwd=<repo> --diff=unstaged "<review prompt>"
# 2. Result: stdout prints `ANSWER FILE: <path>`; the last line is a SECOND_OPINION_RESULT JSON.
#    Read the ANSWER FILE with the Read tool — it is the engine's clean answer.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```

## Model selection

Prefer the default. Never invent or guess a model name — only pass one the user explicitly gave, as `--engine=codex:<model>`. If a pinned model fails with an availability/auth error, report the failure and ask before retrying bare `--engine=codex`; never swap models silently.

## What to review

Pass one flag — `review.js` embeds the content inline:

| What to review | Flag |
|---|---|
| Unstaged changes | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom range | `--diff="HEAD~3..HEAD"` |
| Specific file | `--file=<absolute-path>` |
| General question | *(no flag)* |

## Default review prompt

Use as-is with no extra context to add; for more, see the `second-opinion` skill's `references/prompts.md`.

```
Review this as a senior engineer. Cover:
- **Correctness**: logic errors, edge cases, error handling, concurrency/race conditions, boundary bugs
- **Security**: injection, auth/access-control gaps, unsafe input handling, secrets exposure
- **Regression**: what existing behavior this could break
- **Test coverage**: what's untested or would fail silently
- **Maintainability**: naming, readability, duplication, dead code

Output:
**Summary**: what this does, one sentence
**Issues**: [HIGH/MED/LOW] description → fix
**Concerns**: minor notes not worth a fix
**Positives**: what's done well (brief)

If nothing is wrong, say so plainly. Prioritize HIGH-severity correctness/security findings over style.
```

## Run it

```bash
# Default model:
"$REVIEW_SCRIPT" --engine=codex --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review prompt>"

# Specific model:
"$REVIEW_SCRIPT" --engine=codex:<model> --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review prompt>"
```

## Reading the result

Stdout prints `ANSWER FILE: <path>`; the last line is a `SECOND_OPINION_RESULT: {...}` JSON. Read the ANSWER FILE with the Read tool for Codex's clean answer.
No ANSWER FILE line? Read the LOG FILE path instead. Exit `3` means no usable answer — retry, or switch engines.

## Safety toggle

By default `review.js` adds `-s read-only`. Pass `--unrestricted` only when Codex needs to edit files or run commands — `review.js` drops the flag, logged to stderr.

## Presenting results

Show the full response under `## Codex's Take` (`(<model>)` if pinned). Don't filter or summarize — fix issues raised and note what changed.
