---
name: kilo-review
description: Get a second opinion or code review from kilo CLI using a user-selected AI model. Use this skill whenever the user says "ask Kilo", "review with Kilo", "Kilo's take", "get Kilo's opinion", or wants a second opinion from a specific model available through kilo. Always ask provider first, then model — show free models first.
---

# Kilo Review

Use `kilo run` to get a second opinion from a model you choose, via `review.js`. Flow: pick provider, pick model, run — always ask, no default bypass.

## Golden path

Resolve the runner and the discovery helper:

```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

Use `$LIST_SCRIPT` for all provider/model discovery — do not call `kilo` directly.

```bash
LIST_SCRIPT="${SECOND_OPINION_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-opinion-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
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

```bash
node "$LIST_SCRIPT" --engine=kilo providers
```

If the result has only one entry, skip asking and use it automatically; otherwise ask the user to choose.

```bash
node "$LIST_SCRIPT" --engine=kilo models --provider=<provider>
```

Free models list first, then paid. Offer the top 3–4 as quick picks plus "other (paid)". Chosen model must be a `kilo/<provider>/<model>` string from the output.

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
"$REVIEW_SCRIPT" --engine=kilo:<kilo/provider/model> --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review prompt>"
```

## Reading the result

Stdout prints `ANSWER FILE: <path>`; the last line is a `SECOND_OPINION_RESULT: {...}` JSON. Read the ANSWER FILE with the Read tool for Kilo's clean answer.
No ANSWER FILE line? Read the LOG FILE path instead. Exit `3` means no usable answer — retry, or switch engines.

## Safety toggle

By default `review.js` adds `--agent plan`. Pass `--unrestricted` only when Kilo needs to edit files or run commands — `review.js` drops the flag, logged to stderr.

## Presenting results

Show the full response under `## Kilo's Take (<model>)` — the model name tells the user which perspective they're getting. Don't filter or summarize — fix issues raised and note what changed.
