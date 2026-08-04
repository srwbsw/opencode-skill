---
name: second-agent
description: Get a second opinion, code review, or delegate a task (write code, fix a bug, refactor) to Gemini, opencode, Codex, Claude Code, Copilot, Qwen, Kilo, Antigravity (agy), Command Code (cmd), Cursor, or Kiro CLI. Covers generic requests ("a second opinion", "another perspective", "independent review", "cross-model review") and engine-named ones ("ask Gemini", "codex review", "use opencode", "have Cursor fix this", "Qwen's take", "ask Copilot", "agy review", "cmd review", "kilo's take", "ask kiro-cli", "Claude review"). Named engine → use it directly. Unnamed → ask once, with a recommended default.
---

# Second Agent

Cross-engine review (`review.js`) and task delegation (`agent.js`; see Task mode) — pick one, reuse per engine.

## Golden path

<!-- BEGIN native-shortcut -->
```
Before resolving $REVIEW_SCRIPT: if SECOND_AGENT_NO_NATIVE is set
(`[ -n "${SECOND_AGENT_NO_NATIVE:-}" ]`), skip this block entirely — go
straight to "$REVIEW_SCRIPT". Otherwise check, using a concrete signal
(the native tool's actual name present in your own tool list — not
inferred from conversation context), whether <engine> is the SAME
runtime you are currently executing as, AND you have a native,
model-invokable subagent-delegation mode that ACTUALLY BLOCKS
write-capable tools (not just a curated tool list that still includes
shell/Bash access) — matching review.js's own enforced read-only
posture (--permission-mode plan / -s read-only / equivalent). No such
hard-enforced mode on your host → fall through to "$REVIEW_SCRIPT"
normally; a merely "read-only-flavored" subagent that still has Bash
is NOT sufficient.

If it holds: resolve $REVIEW_SCRIPT and run it once with --print-prompt to
get the exact composed prompt (diff/file embedded, self-contained notice,
secret reminder, and answer-format envelope all included verbatim — do
not hand-assemble this yourself). --print-prompt exiting non-zero → surface
the error, do not substitute self-read content. Pass the printed text to
your native subagent tool instead of spawning the engine CLI. Its raw
response still carries the envelope and any preamble — extract the LAST
complete <<<SECOND_OPINION_START>>>...<<<SECOND_OPINION_END>>> pair
yourself (same non-empty-last-pair rule as review.js's own extraction)
before presenting; never show the raw response verbatim.

Also fall through to "$REVIEW_SCRIPT" when:
- the request includes an explicit model/flag override for this engine
  (e.g. --engine=claude:opus, --engine-arg=) — a native subagent inherits
  your current session's config and cannot honor a different model/flag,
- this engine is one slot inside a Fusion Model B call (single command,
  repeated --engine=) — review.js's internal parallel-spawn loop can't
  reach your native tool; Fusion Model A (separate parallel tool calls
  per engine) is unaffected — swap only that one call, present its
  result inline under its own heading same as any other slot, it simply
  has no log/answer file to point at.
```
<!-- END native-shortcut -->

Resolve the runner, run it, read the answer:

```bash
REVIEW_SCRIPT="${SECOND_AGENT_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-agent-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

`$LIST_SCRIPT` is only needed for opencode/kilo model discovery:

```bash
LIST_SCRIPT="${SECOND_AGENT_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-agent-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```

Then:

```bash
# 1. Run (REVIEW_SCRIPT resolved by the snippet above):
"$REVIEW_SCRIPT" --engine=<engine> --cwd=<repo> --diff=unstaged "<review prompt>"
# 2. Result: stdout prints `ANSWER FILE: <path>`; the last line is a SECOND_OPINION_RESULT JSON.
#    Read the ANSWER FILE with the Read tool — it is the engine's clean answer.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```

## Execution contract

- Always invoke reviews through `"$REVIEW_SCRIPT"`, never the engine CLIs directly; exit `3` = no-answer, retry or switch engines.
- Prefer embedded-content (`--diff=`/`--file=`); `--no-embed` only for large diffs, with a shell-capable engine.
- Spawned engines inherit the parent sandbox; `--unrestricted` only lifts `review.js`'s read-only flags, not outer permissions (`references/troubleshooting.md`).

## Choose an engine and model

Named engine → use it, then ask model (default/specific, plus optional second engine to compare). Unnamed → ask once with a recommended default (Gemini for speed, fusion for higher stakes). Syntax: `--engine=name:model`; omit `:model` for the default. Aliases: `cursor`/`cursor-agent`→`agent`, `kiro`→`kiro-cli`.

| Engine | Model / listing | Notes |
|---|---|---|
| Gemini CLI | no selection | sandbox + plan mode |
| opencode | `$LIST_SCRIPT`: `providers`→`models` | `--engine=opencode:<provider/model>`, 50+ models |
| Codex CLI | never invent a model | `-s read-only`; pinned model unavailable → surface failure, ask before bare retry |
| Claude Code | type-in | `--print --permission-mode plan` |
| GitHub Copilot CLI | type-in | `-s --plan --allow-all-tools --deny-tool=write`; needs `copilot` in PATH |
| Qwen Code CLI | type-in | `-s --approval-mode plan` |
| Kilo | two-step like opencode, free first | `--engine=kilo:<provider/model>`, `--agent plan` |
| Antigravity (agy) | `agy models`; quote whole spec | `--sandbox --print` |
| Command Code (cmd) | `cmd --list-models` | `--print --permission-mode plan --skip-onboarding` |
| Cursor (agent) | `agent --list-models` | `--print --plan --trust` |
| Kiro CLI (kiro-cli) | `kiro-cli chat --list-models` | `chat --no-interactive --trust-tools=`; `--unrestricted` ADDS `--trust-all-tools` |

Same tuple dedupes; different models for one engine compare head-to-head.

## What to review

`review.js` embeds diff/file content (`<diff>`/`<file>` block) — engines don't self-read. `--diff=unstaged` includes untracked files; repeat `--file=` for multiple.

| What to review | Flag |
|---|---|
| Unstaged changes (incl. untracked) | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom revision range | `--diff="HEAD~3..HEAD"` |
| Specific file(s) | `--file=<absolute-path>` (repeatable) |
| General question | *(no flag)* |

## Run it

```bash
"$REVIEW_SCRIPT" --engine=<name>[:<model>] [--engine=...] --cwd=<repo-path> \
  [--diff=<spec>|--file=<path>] [--no-embed] [--unrestricted] [--concurrency=<n>] \
  "<prompt>" [--engine-arg=<arg> ... | -- <engine-args...>]
```

Model is inline (`--engine=name:model`); no separate `--model=`. Example:

```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=. --diff=branch "Review this diff for correctness, regressions, and missing tests."
```

Fusion (repeat `--engine=`): mechanics in `references/fusion.md`.

## Safety (`--unrestricted`)

Each engine defaults to read-only/sandboxed/plan mode (e.g. codex `-s read-only`, claude `--permission-mode plan`). Pass `--unrestricted` only when the engine must edit/run; `review.js` drops the safety flags and logs a warning.

## Secrets (`--include-secrets`)

`review.js` excludes `.env`-style files by default: refuses `--file=.env`, skips untracked `.env` files, redacts `.env` diff hunks. Pass `--include-secrets` only when the user wants a real secrets file reviewed (`references/troubleshooting.md`).

## Task mode — delegate, don't just review

`agent.js` is `review.js`'s sibling: it asks one engine to DO a task (write tests, fix a bug, refactor) inside `--cwd` — use only when read-only review isn't enough.

Resolve the task runner:

```bash
AGENT_SCRIPT="${SECOND_AGENT_TASK:-$(command -v agent.js || true)}"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$HOME/plugins/second-agent-skill/bin/agent.js"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/agent.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$PWD/bin/agent.js"
```

Run, then read the result:

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

One engine per call, no fusion. `--unrestricted` is REQUIRED (exit 1 without it) — no read-only mode here. `--diff=`/`--file=` are context, not the task — state the task in the prompt. `CHANGED FILES:`/`changes` in `SECOND_AGENT_RESULT` are ground truth: `NO REPORT` isn't a failure; `exit: 3` means neither landed.

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
