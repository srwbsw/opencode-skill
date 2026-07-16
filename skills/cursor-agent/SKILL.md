---
name: cursor-agent
description: Get a second opinion, code review, or delegate a task to Cursor's CLI agent (`agent`). Use this skill whenever the user says "ask Cursor", "cursor review", "review with cursor", "get Cursor's opinion", "have Cursor fix/write/refactor this", or wants a Cursor-specific review or task delegation. Also invoke proactively after completing any non-trivial code change — before declaring the task done — to get an independent perspective from a model trained differently. Model is optional — Cursor uses its default unless the user specifies one with `--engine=cursor:<model>` (list choices with `agent --list-models`).
---

# Cursor CLI (agent) Review

Use Cursor's CLI agent (binary `agent`, also installed as `cursor-agent`) to get a second opinion via `review.js`. Engine names `cursor`, `cursor-agent`, and `agent` are interchangeable — all resolve to the same binary. Model is optional. To have Cursor DO something instead of just commenting, see `## Task mode` below.

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

Model is optional. Bare `--engine=cursor` lets Cursor pick its default. To pin one, list choices with `agent --list-models` (e.g. "auto", "gpt-5.2", "sonnet-4", "sonnet-4-thinking") and pass `--engine=cursor:<model>`.

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

Use as-is with no extra context to add; for more, see the `second-agent` skill's `references/prompts.md`.

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
"$REVIEW_SCRIPT" --engine=cursor --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review prompt>"

# Pinned model:
"$REVIEW_SCRIPT" --engine=cursor:sonnet-4 --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review prompt>"
```

Launches as `agent --print --plan --trust [--model <model>] "<prompt>"` — `--trust` is functional, not safety: without it, headless mode prompts to trust the workspace and hangs.

## Reading the result

Stdout prints `ANSWER FILE: <path>`; the last line is a `SECOND_OPINION_RESULT: {...}` JSON. Read the ANSWER FILE with the Read tool for Cursor's clean answer.
No ANSWER FILE line? Read the LOG FILE path instead. Exit `3` means no usable answer — retry, or switch engines.

## Safety toggle

By default `review.js` adds `--plan`. Pass `--unrestricted` only when Cursor needs to edit files or run commands — `review.js` drops that flag (not `--trust`), logged to stderr.

## Presenting results

Show the full response under `## Cursor's Take` (`(<model>)` if pinned). Don't filter or summarize — fix issues raised and note what changed.

## Task mode

Use `agent.js` instead of `review.js` when the goal is to have Cursor **do** something — write tests, fix a bug, add a feature, refactor — rather than just comment on it. Same engine/model selection as above; different entry point, different safety model.

Resolve the task runner:

```bash
AGENT_SCRIPT="${SECOND_OPINION_AGENT:-$(command -v agent.js || true)}"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$HOME/plugins/second-opinion-skill/bin/agent.js"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/agent.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$PWD/bin/agent.js"
```

Run it, then read the result:

```bash
# 1. Run (AGENT_SCRIPT resolved by the snippet above). --unrestricted is a
#    deliberate acknowledgment that the engine may edit files and run
#    commands inside --cwd — there is no read-only mode for agent.js:
"$AGENT_SCRIPT" --engine=<engine> --cwd=<repo> --unrestricted "<task prompt>"
# 2. Result: stdout prints a CHANGED FILES: block, then `ANSWER FILE: <path>`;
#    the last line is a SECOND_AGENT_RESULT JSON (includes `changes`).
#    Read the ANSWER FILE with the Read tool for the engine's report.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```

`--unrestricted` is REQUIRED (hard gate, exit 1 without it) — there is no plan/read-only mode for `agent.js`. Exactly one engine per call, no fusion; run `agent.js` again, sequentially, for a second engine. Example:

```bash
"$AGENT_SCRIPT" --engine=cursor --cwd=. --unrestricted "Add a CHANGELOG entry for this change, then run the test suite."
```

### Default task prompt

```
<task statement — what to build/fix/change, and why>

Constraints:
- Make the minimal change needed; do not refactor unrelated code.
- Follow this repo's existing conventions, style, and file layout.
- Do not touch test files unless the task explicitly asks for it.

Verify by running the project's test suite (and linter/typecheck, if any)
before reporting done. If no test suite exists, say so explicitly.

Report:
**Changed**: files touched, and why
**Verified**: tests/commands run, and their results
**Left undone**: anything incomplete, deferred, or out of scope
```
