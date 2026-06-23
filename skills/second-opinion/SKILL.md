---
name: second-opinion
description: Get a second opinion or code review from an AI engine of your choice. Use when the user asks for "a second opinion", "another perspective", "independent review", "cross-model review", or wants a review without specifying a particular engine. Ask which engine to use first, then follow that engine's complete review workflow. For engine-specific requests ("ask gemini", "use opencode", "codex review", "claude review"), invoke the corresponding engine skill directly instead.
---

# Second Opinion

Orchestrates a cross-engine code review. Ask which engine to use, then follow that engine's full review workflow. All execution goes through `review.js` — locate it once, use it for every engine.

## Execution contract

Follow these rules exactly. Most misuse comes from agents improvising around them.

1. Invoke `review.js` directly.
   - Use `"$REVIEW_SCRIPT" ...` as the top-level command.
   - Do not call `codex`, `gemini`, `claude`, `copilot`, `qwen`, `kilo`, `agy`, `cmd`, or `agent` directly for review work.

2. Treat `review.js` as the only runner.
   - It chooses engine flags, embeds diff/file content, manages logs, and normalizes output.
   - Do not rebuild that logic in ad hoc shell wrappers.

3. Do not assume subprocesses escape the parent sandbox.
   - Engines spawned by `review.js` inherit the parent process context.
   - If the parent agent command runs in a sandbox, the child engine runs in that sandbox too.
   - `--unrestricted` only removes the engine-specific read-only / plan flags inside `review.js`; it does not change the outer harness permissions.
   - Running `"$REVIEW_SCRIPT"` from an installed plugin does not make the run "system-level" if the parent harness is still sandboxed.

4. Do not treat `zsh -lc` or `bash -lc` as a permission change.
   - A login shell may change `PATH` or shell init behavior.
   - It does not make the spawned engine run outside the parent sandbox.

5. Prefer the default embedded-content path.
   - Use normal `--diff=...` / `--file=...` review calls first.
   - Use `--no-embed` only for very large diffs and only when the chosen engine can successfully shell out in the current environment.

6. Read the log file, not stdout.
   - In non-TTY runs, engine output goes to the log file path shown by `review.js`.
   - Extract the last complete `<<<SECOND_OPINION_START>>> ... <<<SECOND_OPINION_END>>>` pair from that log.

### Anti-patterns

Do not do any of these:

- `codex exec ...`, `gemini ...`, `claude ...`, etc. directly instead of `review.js`
- custom shell pipelines that try to reconstruct the prompt assembly outside `review.js`
- `zsh -lc` or `bash -lc` with the expectation that it changes sandbox permissions
- assuming an installed-plugin `"$REVIEW_SCRIPT"` invocation is host-level when the harness still sandboxes the parent command
- `--no-embed` on engines that cannot reliably run `git diff` in the current harness
- scraping `stdout` with `| tail` / `| head` instead of reading the log file

### Troubleshooting

- If an installed-plugin runner command fails only inside a sandboxed harness, diagnose the parent execution mode before changing `review.js`.
- Some engines require host-level prerequisites beyond plain PATH resolution, such as writable home-directory state, existing login/auth sessions, or network access.

## Locating review.js

Resolve both scripts once, then reuse `$REVIEW_SCRIPT` / `$LIST_SCRIPT` for every engine. Resolution is **PATH-first**, then known install locations, so any harness that puts a plugin's `bin/` on `PATH` (Claude Code does) needs no path logic. The order is: `SECOND_OPINION_REVIEW`/`SECOND_OPINION_LIST` env override → `command -v` on `PATH` → Codex local install (`~/.agents/plugins/plugins/…`) → Claude Code marketplace cache → repo checkout. This snippet is canonical — `skills/AGENTS.md` owns it and `test/locate.test.js` enforces that every skill embeds it verbatim.

```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/.agents/plugins/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

`$LIST_SCRIPT` is only needed for opencode/kilo provider+model discovery:

```bash
LIST_SCRIPT="${SECOND_OPINION_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/.agents/plugins/plugins/second-opinion-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```

## Step 1: Build the slot list — REQUIRED FIRST STEP

The `second-opinion` skill always builds a list of `(engine, model)` slots before firing `review.js`. Most invocations end up with one slot; users who want a multi-engine fusion build several. The loop below handles both shapes with the same prompts — do not branch on "fusion vs single" up front, let the user decide implicitly by how many slots they add.

**Loop**:

1. Ask the user which engine to use for the next slot. If the harness offers a structured user-input tool, use it; otherwise ask directly in plain text. Present the table below and allow a free-form engine not listed.
2. Use the per-engine model rules (next sub-section) to gather a model — type-in, list-and-pick, or skip — depending on the engine.
3. Ask one yes/no question: "Add another engine for a multi-engine review?"
   - **Yes** → loop back to step 1 and add another slot.
   - **No** → stop. Move to Step 2 with the slots collected so far.
4. After the loop ends, if exactly one slot was collected, that is a single-engine run; if more than one, run them via Model A (harness fan-out) or Model B (fusion) — see "Running multiple engines" in Step 2.

**Do not skip the loop just because the user named one engine in their initial request.** They may want to add a second comparison engine. Ask. Only skip the loop when the user has explicitly said "just X" or already enumerated the full set in their prompt.

**Engine table**:

| Engine | Model selection | Notes |
|---|---|---|
| Gemini CLI | Automatic (no model selector) | Google's Gemini, sandbox + plan mode |
| opencode | User picks from registry (required) | 50+ models — GPT, Llama, Gemini, Mistral, and more |
| Codex CLI | Optional (type-in, no listing) | OpenAI's Codex, `-s read-only` |
| Claude Code | Optional (type-in, no listing) | Anthropic's Claude, `--print --permission-mode plan` |
| GitHub Copilot CLI | Optional (type-in) | `--plan --deny-tool=write`, needs `copilot` in PATH |
| Qwen Code CLI | Optional (type-in) | Alibaba's Qwen, `-s --approval-mode plan` |
| Kilo | Provider → model (free first) | `--agent plan` |
| Antigravity (agy) | Optional (list via `agy models`, or default) | Google's Antigravity CLI, `--sandbox --print` |
| Command Code (cmd) | Optional (list via `cmd --list-models`, or default) | `--print --permission-mode plan --skip-onboarding` |
| Cursor (agent) | Optional (list via `agent --list-models`, or default) | `--print --plan --trust` |

**Per-engine model rules** (apply during step 2 of each loop iteration):

- **Gemini CLI**: no model selection; the engine's CLI picks. Use bare `--engine=gemini`.
- **Antigravity (agy)**: model is optional. Ask "use default or pick a model?" If default, use bare `--engine=agy`. If pick, run `agy models` (flat list, no provider tier — e.g. `Gemini 3.5 Flash (High)`, `Claude Opus 4.6 (Thinking)`) and pass the chosen name verbatim: `--engine=agy:<model>`. Names contain spaces/parens — quote the whole spec in your shell; `review.js` splits only on the first `:`, so the model string is preserved intact.
- **opencode**: model is **required**. Two-step: ask for provider via `node "$LIST_SCRIPT" --engine=opencode providers`, then model via `node "$LIST_SCRIPT" --engine=opencode models --provider=<provider>`. Use `--engine=opencode:<provider/model>`.
- **Kilo**: same two-step (`--engine=kilo providers` then `models --provider=<provider>` — script returns free models first). Use `--engine=kilo:<provider/model>`.
- **Codex**: model is optional. Prefer bare `--engine=codex` unless the user explicitly provided a model name. Do not invent model names or pin `gpt-5.4-mini` unless the user asked for that exact string. If a pinned model fails as unavailable, preserve the failure and ask before rerunning with bare `--engine=codex`.
- **Claude Code / Copilot / Qwen**: model is optional. Ask "use default or specify a model?" If user picks default, use bare `--engine=<eng>`. If user picks specify, prompt for the name (type-in only — no listing command for these). Use `--engine=<eng>:<model>`.
- **Command Code (cmd)**: model is optional. Ask "use default or pick a model?" If default, use bare `--engine=cmd`. If pick, run `cmd --list-models` (grouped list, e.g. `claude-sonnet-4-6`, `gpt-5.5`, `deepseek/deepseek-v4-flash`) and pass the id verbatim: `--engine=cmd:<model>`.
- **Cursor (agent)**: model is optional. Ask "use default or pick a model?" If default, use bare `--engine=cursor`. If pick, run `agent --list-models` (flat list, e.g. `auto`, `gpt-5.2`, `sonnet-4`, `sonnet-4-thinking`) and pass the id verbatim: `--engine=cursor:<model>`. The engine names `cursor`, `cursor-agent`, and `agent` are interchangeable — all resolve to the `agent` binary.

**Dedup**: if the user adds an `(engine, model)` tuple that already exists in the slot list, silently skip it — `review.js` dedups by tuple too. Same engine with different models is fine.

**Same-engine, multi-model fusion**: the loop naturally supports this — if the user picks opencode twice with different models, both slots survive.

## Step 2: Compose the prompt and fire

This is the most important step — a "second opinion" is only useful if the engine knows what it's looking at and what you actually want from it. Pick the tier that fits.

### Tier A — Specific task / open question (preferred when context exists)

Use this when the user is mid-feature, has a plan, is debating an approach, or asked something more nuanced than "review this." Embed the relevant context inline in the prompt argument, then ask whatever you actually want a second opinion on. The templates in the "Default templates" section below are fallbacks, not constraints — write the prompt that matches the question.

Things worth pasting into the prompt when relevant:
- The user's stated goal or the task they're working on
- The current plan, design notes, or constraints
- Excerpts of conversation that establish what was tried, ruled out, or already agreed
- Specific questions ("does this preserve invariant X?", "any race condition I missed?")
- Non-code context: requirements, deadlines, stakeholders, prior incidents

Do not include private chat verbatim if it contains user secrets the user did not intend to share with a third-party engine. Summarize.

### Tier B — Plain diff/file review with no extra context

Use this when the user just says "review this" with no further detail. Pick a template from "Default templates" below and fire. This is the historical behavior — kept so the skill still does something useful when no context is available.

### Tier C — Large change with shell-capable engine

Use this when the diff is very large (close to the 120KB prompt cap) AND the engine has shell access (codex, claude, copilot in --unrestricted, or sandbox engines that allow `git`). Pass `--no-embed` to `review.js`: instead of inlining the diff, it tells the engine to run `git -C <cwd> diff <range>` itself. Lower argv, but only works for engines that can actually shell out.

### Final command format

```bash
"$REVIEW_SCRIPT" --engine=<name>[:<model>] [--engine=...] --cwd=<repo-path> \
  [--diff=<spec>|--file=<path>] [--no-embed] [--unrestricted] [--concurrency=<n>] \
  "<prompt>" [--engine-arg=<arg> ... | -- <engine-args...>]
```

### Example invocations

Default embedded review:

```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=. --diff=branch "Review this diff for correctness, regressions, and missing tests."
```

Specific engine with typed-in model:

```bash
"$REVIEW_SCRIPT" --engine=claude:sonnet-4 --cwd=. --file="$PWD/src/app.ts" "Review this file for bugs and maintainability issues."
```

Fusion review:

```bash
"$REVIEW_SCRIPT" --engine=gemini --engine=codex:gpt-5 --engine=claude --cwd=. --diff=branch "Review this diff for architecture, security, and test gaps."
```

Large diff with self-fetch:

```bash
"$REVIEW_SCRIPT" --engine=codex --cwd=. --diff=branch --no-embed "Review this diff for correctness and regressions."
```

Use the last example only when the engine can actually run `git` in the current harness.

Installed-plugin launcher verification:

```bash
"$REVIEW_SCRIPT" --engine=cmd --engine=claude --cwd=. --timeout=120 --heartbeat=10 "Report whether you were launched successfully and what engine you are. Reply briefly."
```

Use this as a launcher check only when you control the parent execution mode. Inside a sandboxed harness, failure may still be caused by inherited sandbox restrictions rather than by `review.js`.

Model selection is always inline: `--engine=name:model`. There is no separate `--model=` flag. Gemini's CLI always picks its own model, so use the bare `--engine=gemini` form. Engines with an optional model (agy, cmd, cursor, codex, claude, copilot, qwen) take either the bare form (CLI default) or `name:model`. Engines that mandate a model (opencode) must use the `name:model` form or `review.js` fails fast.

By default `review.js`:
- Inlines diff/file content as a `<diff>` / `<file>` block before the prompt
- Applies the engine's read-only / sandbox / plan-mode flags (see "Safety toggle" below)
- Appends a structured-output envelope (see "Reading the output" below)

### Running multiple engines

When more than one slot was collected, there are **two equally valid ways** to run them. There is no enforced default — pick the one that fits your harness and the task. Both end up running single-engine `review.js` invocations; they differ only in *who* parallelizes.

#### Model A — Harness fan-out (you issue the parallel calls)

If your harness can issue concurrent tool calls (Claude Code can — emit multiple Bash calls in one message), fire **one single-engine `review.js` per slot**, all in the same batch:

```bash
# Each of these is a separate Bash tool call, sent together so they run at once
"$REVIEW_SCRIPT" --engine=gemini --cwd=. --diff=branch "<prompt>"
"$REVIEW_SCRIPT" --engine=codex:gpt-5 --cwd=. --diff=branch "<prompt>"
"$REVIEW_SCRIPT" --engine=claude --cwd=. --diff=branch "<prompt>"
```

Best when: your harness supports parallel tool calls, you want per-engine visibility/control (each is its own task you can read, retry, or abort independently), or each engine should review something *different* (different scope/question/diff). Each call writes its own auto-log; collect the `LOG FILE:` path from each.

#### Model B — Fusion (`review.js` parallelizes internally)

Repeat `--engine=` in one command. Each occurrence is a "slot" — one `(engine, model)` pair that runs as its own child of `review.js`. The parent orchestrates: parallel children, collision-free logs, signal teardown, parent heartbeat, and a single aggregated exit code.

```bash
# Three engines, default models
"$REVIEW_SCRIPT" --engine=gemini --engine=codex --engine=claude --cwd=. --diff=branch "<prompt>"

# Per-slot models inline
"$REVIEW_SCRIPT" --engine=opencode:openai/gpt-5 --engine=codex:gpt-5 --engine=gemini --cwd=. "<prompt>"

# Same engine, multiple models (compare two opencode picks against each other)
"$REVIEW_SCRIPT" --engine=opencode:openai/gpt-5 --engine=opencode:anthropic/claude-sonnet-4-6 --cwd=. "<prompt>"

# CSV shorthand for the no-model case
"$REVIEW_SCRIPT" --engine=gemini,codex,claude --cwd=. "<prompt>"
```

Best when: your harness **can't** run tool calls in parallel (fusion gives you parallelism anyway), you want one command with central teardown + aggregated exit code, or you're running unattended. Same prompt goes to every slot.

#### Sequential / rate-limited runs

If a provider rate-limits, or the user asks to go one-by-one, do **not** run all slots at once:

- **Model A**: issue the `review.js` calls one at a time (wait for each to finish before the next) instead of batching them.
- **Model B**: pass `--concurrency=<n>` — `--concurrency=1` runs slots strictly serially; `--concurrency=2` caps at two at a time; omit it for the default (all in parallel).

```bash
# Fusion, but never more than one engine hitting providers at once
"$REVIEW_SCRIPT" --engine=gemini --engine=codex --engine=claude --cwd=. --concurrency=1 "<prompt>"
```

#### Shared rules (both models)

- **Model binding**: `--engine=name:model` binds a model to that slot; bare `--engine=name` uses the CLI default; engines that require a model (opencode) must use `name:model`.
- **Dedup** (fusion): slots are deduplicated by `(engine, model)` tuple, so accidental repeats collapse but legitimate "same engine, different model" pairs survive.
- **Fusion log files** live under `$TMPDIR/second-opinion-fusion-<ts>/`. Filenames are `<engine>.log` or `<engine>__<sanitized-model>.log` — collision-free even with multiple slots of the same engine.
- **Reading output**: read each log file with the Read tool, extract the text between `<<<SECOND_OPINION_START>>>` and `<<<SECOND_OPINION_END>>>` markers, and present side-by-side under sectioned headings (e.g. `## Gemini's Take`, `## Codex's Take (gpt-5)`). The agent does the synthesis — there is no built-in synthesizer (would just bias toward one model family).
- **Exit code aggregation** (fusion): 124 (timeout) dominates; otherwise the first non-zero child code; otherwise 0.

### Safety toggle (`--unrestricted`)

Each engine ships with read-only / sandbox / plan-mode flags applied by default (codex `-s read-only`, claude `--permission-mode plan`, gemini `-s --approval-mode plan`, etc.). For a pure second opinion this is the right default — the engine reads, thinks, answers, nothing else.

Pass `--unrestricted` when the engine genuinely needs to edit files, run tests, or execute commands as part of the task. `review.js` will drop the safety flags for the chosen engine and log a stderr warning. Decide deliberately — only use it when read-only mode would actually block the work.

### Secret files (`--include-secrets`)

`review.js` keeps `.env`-style secret files out of the engine by default — it refuses `--file=.env`, skips untracked `.env` files from `--diff=unstaged`, and redacts `.env` hunks from diffs (matching `.env`, `.env.*`, `*.env`; exempting `*example*` / `*sample*` / `*template*`). It also appends a prompt reminder not to open env files (for `--no-embed` / sandbox self-reads). This is enforced in the runner. Only pass `--include-secrets` when the user explicitly wants a real `.env` reviewed.

### Reading the output

Every prompt is wrapped with a structured-output envelope before being passed to the engine:

```
<<<SECOND_OPINION_START>>>
... the engine's real answer ...
<<<SECOND_OPINION_END>>>
```

After the engine exits, locate the log file (see "Capturing output" below), `Read` it, and extract the text of the **last complete** `<<<SECOND_OPINION_START>>>` … `<<<SECOND_OPINION_END>>>` pair. Discard everything outside the markers — that is reasoning, tool noise, model scaffolding, or banner text.

Two real-world quirks to extract around:
- **Take the LAST pair, not the first.** Some engines echo the format instructions, and some (codex) emit the answer twice — a first-match grab returns the instruction example or a stale copy. The last complete pair is the real answer.
- **Tolerate a malformed open marker.** Smaller models sometimes emit `<<<SECOND_OPINION_START>>` (two `>`) or add stray whitespace. Match loosely (e.g. `<{2,}\s*SECOND_OPINION_START\s*>{2,}`); review.js's own exit-code check already does. If the envelope is truly absent, fall back to reading the full log.

To disable the envelope (e.g. when feeding output to another tool that does its own parsing), pass `--no-wrap`.

### Capturing output (important for agent use)

Reviews routinely span 50–300 lines. When `review.js` runs from an agent harness (non-TTY stdout) it **does not stream the engine output to stdout at all** — engine bytes go to a temp file, and stdout receives only a banner pointing at the log file:

```
===========================================================
REVIEW IN PROGRESS — codex (gpt-5.5)
LOG FILE: /var/folders/.../second-opinion-codex-1731603012.log
Engine output is being written to the log file only.
After this command exits, use the Read tool on the LOG FILE path
above to retrieve the full review. Do not pipe to tail/head — the
engine output is not on stdout in this mode.
===========================================================
... (no engine output here) ...
REVIEW COMPLETE — read with Read tool: /var/folders/.../second-opinion-codex-1731603012.log (47213B, exit=0, 42.1s)
```

**Workflow:**

1. Run the `review.js` command (no `| tail`, no `| head` — they would be useless here, the engine output isn't on stdout).
2. Extract the log path from the `LOG FILE:` line in the command output (or from `REVIEW COMPLETE — read with Read tool: <path>`).
3. Use the agent's Read tool on that path to get the full review, paginated if large.

If you need a known location, pass `--log=<path>` explicitly. To force the old tee-to-stdout behavior (e.g. for interactive `| less`), pass `--log=-`.

## Determining what to review

Ask or infer what to review, then pass the appropriate flag to `review.js`. The script handles fetching, so the chosen engine never needs the diff content spelled out manually in your own prompt.

| What to review | Flag |
|---|---|
| Unstaged changes (incl. untracked) | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom revision range | `--diff="HEAD~3..HEAD"` |
| Specific file(s) | `--file=<absolute-path>` (repeatable) |
| General question | *(no flag — prompt is standalone)* |

The prompt argument is just the review template — `review.js` embeds diff/file content inline as a `<diff>` or `<file>` block before the prompt, so no read instructions are needed and no temp files are written.

`--diff=unstaged` also includes **untracked** files (new files plain `git diff` omits), so a WIP review of work that adds files doesn't miss them. To review several specific files in one shot, pass `--file=` more than once — each file becomes its own `<file>` block. To review uncommitted work that spans new + modified files, prefer `--diff=unstaged` over a single `--file=`.

**Exit codes**: `0` success, `124` timeout, `3` = the engine exited cleanly but produced no usable output (zero bytes — often a transient upstream model outage — or, when wrapped, output missing the `<<<SECOND_OPINION_START>>>` envelope). Treat `3` as "no answer, retry or pick another engine", not success. In fusion mode each slot's code is annotated in the `FUSION COMPLETE` summary.

## Default templates

These are fallbacks for Tier B (plain "review this" with no extra context). For Tier A, write a bespoke prompt — these templates can be a starting skeleton, but don't force-fit a nuanced question into them. The engine sees your prompt as-is plus the structured-output envelope; everything else is up to you.

### Code review (diff or file)
```
Review this as a senior engineer. Spawn all sub-agents simultaneously in a single batch — one per domain below — then synthesize their findings once all have returned. Do NOT spawn them sequentially or wait for one to finish before starting the next. If sub-agents are not supported, cover all domains yourself in a single pass.

Domains:
- **Architecture & design decisions**: Is this the right approach for the problem? Module boundaries, layering, separation of concerns, coupling/cohesion, abstractions that leak or over-engineer, data-model fit. Call out where a simpler or more conventional design would do, and any decision that will be expensive to reverse.
- **Security**: injection (SQL / NoSQL / OS-command / template / path-traversal), authentication & authorization boundaries (missing or incorrect access checks, IDOR), input validation and handling of untrusted input, data exposure (PII, secrets in logs/errors, over-fetching), SSRF, unsafe deserialization.
- **Least privilege**: over-broad permissions, roles, OAuth scopes, IAM policies, API tokens, DB grants, or file modes. Does each component get only the access it needs? Flag hardcoded credentials and secrets that should be externalized.
- **Correctness & robustness**: edge cases, error handling, resource leaks, concurrency/race conditions, off-by-one and boundary bugs.
- **Regression**: what existing behaviour could this change break.
- **Test coverage**: what's untested, what edge cases are missing, what would break silently.
- **Maintainability**: naming, readability, duplication, dead code, comment/intent clarity.

Synthesized output:
**Summary**: What this does in one sentence
**Issues**: [HIGH/MED/LOW] description → suggested fix (tag each with its domain)
**Concerns**: Minor notes not worth a fix
**Positives**: What's done well (brief)

If nothing is wrong, say so plainly. Prioritize HIGH-severity correctness/security findings over style.
```

### Second opinion on approach
```
Give your honest assessment of this approach.

Consider: is this the right architecture/design decision for the problem, what are the failure modes, does it respect least-privilege and security boundaries, and will it be expensive to change later.

Structure as:
**Assessment**: Your take in 2-3 sentences
**Concerns**: What could go wrong or why this might be the wrong call
**Alternatives**: Other approaches worth considering (skip if none)

Be direct, not diplomatic.
```

### Security review
```
Review this code for security vulnerabilities.

Cover:
- **Injection**: SQL / NoSQL / OS-command / template / path-traversal / LDAP
- **AuthN/AuthZ**: missing or incorrect access checks, IDOR, privilege escalation, session/token handling
- **Least privilege**: over-broad permissions, roles, OAuth scopes, IAM policies, DB grants, file modes; credentials that should be scoped down or externalized
- **Data exposure**: PII handling, secrets in logs/errors/responses, over-fetching
- **Input validation**: untrusted input reaching sinks, deserialization, SSRF
- **Secrets**: hardcoded credentials, keys, tokens

Structure:
**Risk Level**: Critical / High / Medium / Low / None
**Vulnerabilities**: [SEVERITY] description → how to fix
**OK**: What's handled correctly

If no vulnerabilities found, confirm explicitly.
```

### General consultation
```
Answer directly. If giving a recommendation, structure as: **Recommendation**, **Reasoning**, **Trade-offs**.
```

## Adding new engines

1. Add a new `<engine>-review` skill in `skills/`
2. Add an entry to the `SAFETY_FLAGS` map in `bin/review.js` with the engine's read-only/sandbox flags, and add a `case` block that calls `safetyFor('<engine>')` plus any required functional flags (e.g. `--print`, `-p`, `exec`, `run`)
3. If the engine needs provider/model discovery, add a `case` block to `bin/list.js`
4. Update the engine table in Step 1 above and add a dispatch block in Step 2
5. Add the engine's required safety flags to `requiredSafetyFlags` and any functional flags to `requiredFunctionalFlags` in `test/safety.test.js`, then run `pnpm run lint` to verify
