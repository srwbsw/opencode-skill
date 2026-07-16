---
name: second-agent
description: Get a second opinion, code review, or delegate a task to an AI engine of your choice. Use when the user asks for "a second opinion", "another perspective", "independent review", "cross-model review", or wants to delegate a task (write code, fix a bug, refactor) to another engine, without naming a specific one. Ask which engine to use first, then follow that engine's complete workflow. For engine-specific requests ("ask gemini", "use opencode", "codex review", "have codex fix this"), invoke the corresponding engine skill directly instead.
---

# Second Opinion

Orchestrates a cross-engine code review, and delegates arbitrary tasks. Review goes through `review.js`; task delegation goes through its sibling `agent.js` (`## Task mode` below) — resolve the one you need, then reuse it per engine.

## Golden path

Resolve the runner, run it, read the answer. This is the whole workflow for a plain review.

```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

`$LIST_SCRIPT` is only needed for opencode/kilo provider+model discovery:

```bash
LIST_SCRIPT="${SECOND_OPINION_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-opinion-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```

Then run it and read the result:

```bash
# 1. Run (REVIEW_SCRIPT resolved by the snippet above):
"$REVIEW_SCRIPT" --engine=<engine> --cwd=<repo> --diff=unstaged "<review prompt>"
# 2. Result: stdout prints `ANSWER FILE: <path>`; the last line is a SECOND_OPINION_RESULT JSON.
#    Read the ANSWER FILE with the Read tool — it is the engine's clean answer.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```

## Execution contract

- Always invoke reviews through `"$REVIEW_SCRIPT"` — never call the engine CLIs directly. Treat exit `3` as no-answer: retry the same engine or switch to another one.
- Prefer the default embedded-content path (`--diff=`/`--file=`); reach for `--no-embed` only on very large diffs, and only with a shell-capable engine.
- Spawned engines inherit the parent harness's sandbox; `--unrestricted` only lifts `review.js`'s own read-only flags, not outer harness permissions. Details: `references/troubleshooting.md`.

## Choose an engine and model

If the user named an engine, ask at most one bundled question: default model or a specific one, and a second engine to compare against? For a bare request, ask one question with a recommended default (e.g. Gemini for a fast review, fusion for higher-stakes changes).

**Engines**:

| Engine | Model selection | Notes |
|---|---|---|
| Gemini CLI | Automatic (no model selector) | sandbox + plan mode |
| opencode | Optional — pick from registry, or default | 50+ models across providers |
| Codex CLI | Optional — type-in, no listing | `-s read-only` |
| Claude Code | Optional — type-in, no listing | `--print --permission-mode plan` |
| GitHub Copilot CLI | Optional — type-in | `-s --plan --allow-all-tools --deny-tool=write`; needs `copilot` in PATH |
| Qwen Code CLI | Optional — type-in | `-s --approval-mode plan` |
| Kilo | Provider → model (free first) | `--agent plan` |
| Antigravity (agy) | Optional — list via `agy models`, or default | `--sandbox --print` |
| Command Code (cmd) | Optional — list via `cmd --list-models`, or default | `--print --permission-mode plan --skip-onboarding` |
| Cursor (agent) | Optional — list via `agent --list-models`, or default | `--print --plan --trust` |

**Model rules**, one line each:

- Gemini: no selection — bare `--engine=gemini`.
- Antigravity (agy): default `--engine=agy`, or list `agy models` and pass `--engine=agy:<model>` (quote the whole spec — names contain spaces/parens).
- opencode: default `--engine=opencode`, or two-step via `$LIST_SCRIPT` (`providers` then `models --provider=<p>`) → `--engine=opencode:<provider/model>`.
- Kilo: same two-step as opencode, free models listed first → `--engine=kilo:<provider/model>`.
- Codex: prefer bare `--engine=codex` — never invent a model. If a pinned model is unavailable, surface the failure and ask before retrying bare.
- Claude Code / Copilot / Qwen: type-in only (no listing command) → `--engine=<eng>:<model>`, or bare for default.
- Command Code (cmd): default `--engine=cmd`, or list `cmd --list-models` → `--engine=cmd:<model>`.
- Cursor (agent): default `--engine=cursor`, or list `agent --list-models` → `--engine=cursor:<model>` (`cursor`/`cursor-agent`/`agent` are interchangeable).

The same `(engine, model)` tuple twice dedupes silently; the same engine with different models is fine — that's how you compare two models head-to-head.

## What to review

`review.js` embeds diff/file content directly into the prompt as a `<diff>`/`<file>` block — engines don't self-read by default, so no manual fetch instructions are needed. `--diff=unstaged` also includes untracked files; repeat `--file=` for multiple files, or prefer `--diff=unstaged` when the change spans new + modified files.

| What to review | Flag |
|---|---|
| Unstaged changes (incl. untracked) | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom revision range | `--diff="HEAD~3..HEAD"` |
| Specific file(s) | `--file=<absolute-path>` (repeatable) |
| General question | *(no flag — prompt is standalone)* |

## Run it

```bash
"$REVIEW_SCRIPT" --engine=<name>[:<model>] [--engine=...] --cwd=<repo-path> \
  [--diff=<spec>|--file=<path>] [--no-embed] [--unrestricted] [--concurrency=<n>] \
  "<prompt>" [--engine-arg=<arg> ... | -- <engine-args...>]
```

Model selection is always inline (`--engine=name:model`); there is no separate `--model=` flag. Example:

```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=. --diff=branch "Review this diff for correctness, regressions, and missing tests."
```

Fusion (repeat `--engine=` for multiple slots, one aggregated result) — mechanics, parallel vs sequential, rate limiting, log layout, exit-code aggregation: `references/fusion.md`.

## Safety (`--unrestricted`)

Each engine defaults to a read-only / sandboxed / plan mode (e.g. codex `-s read-only`, claude `--permission-mode plan`). That is right for a pure second opinion. Pass `--unrestricted` only when the task genuinely needs the engine to edit files or run commands — `review.js` drops the safety flags and logs a stderr warning.

## Secrets (`--include-secrets`)

`review.js` keeps `.env`-style files out by default: refuses `--file=.env`, skips untracked `.env` files, and redacts `.env` diff hunks. Pass `--include-secrets` only when the user explicitly wants a real secrets file reviewed — matching rules: `references/troubleshooting.md`.

## Task mode — delegating a task instead of reviewing it

`agent.js` is `review.js`'s sibling: it asks one engine to DO a task (write tests, fix a bug, refactor) inside `--cwd`, instead of just commenting. Use it only when read-only consultation isn't enough.

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

One engine per call, no fusion. `--unrestricted` is REQUIRED (hard gate, exit 1 without it) — no read-only mode exists here. Same engine/model selection as above. `--diff=`/`--file=` are context, not the task — state the task itself in the prompt. `CHANGED FILES:`/`changes` in `SECOND_AGENT_RESULT` are ground truth: `NO REPORT` (changes, no envelope) isn't a failure, but `exit: 3` means neither landed.

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

## More detail

- Prompt tiers and the full template set: `references/prompts.md`
- Fusion mechanics, concurrency, rate limits, exit-code aggregation: `references/fusion.md`
- Anti-patterns, sandbox notes, `--no-embed` caveats, exit codes: `references/troubleshooting.md`
- Adding a new engine to `review.js`/`agent.js`/`list.js`: `references/adding-engines.md`
