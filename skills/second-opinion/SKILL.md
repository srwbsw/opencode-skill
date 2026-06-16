---
name: second-opinion
description: Get a second opinion or code review from an AI engine of your choice. Use when the user asks for "a second opinion", "another perspective", "independent review", "cross-model review", or wants a review without specifying a particular engine. Ask which engine to use first, then follow that engine's complete review workflow. For engine-specific requests ("ask gemini", "use opencode", "codex review", "claude review"), invoke the corresponding engine skill directly instead.
---

# Second Opinion

Orchestrates a cross-engine code review. Ask which engine to use, then follow that engine's full review workflow. All execution goes through `review.js` — locate it once, use it for every engine.

## Locating review.js

```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | sort -V | tail -1
```

Store the result as `REVIEW_SCRIPT`. Also locate `list.js` the same way and store as `LIST_SCRIPT` — used for provider/model discovery in opencode and kilo.

```bash
printf '%s\n' ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | sort -V | tail -1
```

## Step 1: Build the slot list — REQUIRED FIRST STEP

The `second-opinion` skill always builds a list of `(engine, model)` slots before firing `review.js`. Most invocations end up with one slot; users who want a multi-engine fusion build several. The loop below handles both shapes with the same prompts — do not branch on "fusion vs single" up front, let the user decide implicitly by how many slots they add.

**Loop**:

1. Use `AskUserQuestion` to ask which engine to use for the next slot. Present the table below. Include "Other" so the user can type an engine not listed.
2. Use the per-engine model rules (next sub-section) to gather a model — type-in, list-and-pick, or skip — depending on the engine.
3. Use `AskUserQuestion` again with one yes/no question: "Add another engine for a multi-engine review?"
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
- **Antigravity (agy)**: model is optional. Ask "use default or pick a model?" via `AskUserQuestion`. If default, use bare `--engine=agy`. If pick, run `agy models` (flat list, no provider tier — e.g. `Gemini 3.5 Flash (High)`, `Claude Opus 4.6 (Thinking)`) and pass the chosen name verbatim: `--engine=agy:<model>`. Names contain spaces/parens — quote the whole spec in your shell; `review.js` splits only on the first `:`, so the model string is preserved intact.
- **opencode**: model is **required**. Two-step: ask for provider via `node "$LIST_SCRIPT" --engine=opencode providers`, then model via `node "$LIST_SCRIPT" --engine=opencode models --provider=<provider>`. Use `--engine=opencode:<provider/model>`.
- **Kilo**: same two-step (`--engine=kilo providers` then `models --provider=<provider>` — script returns free models first). Use `--engine=kilo:<provider/model>`.
- **Codex / Claude Code / Copilot / Qwen**: model is optional. Ask "use default or specify a model?" via `AskUserQuestion`. If user picks default, use bare `--engine=<eng>`. If user picks specify, prompt for the name (type-in only — no listing command for these). Use `--engine=<eng>:<model>`.
- **Command Code (cmd)**: model is optional. Ask "use default or pick a model?" via `AskUserQuestion`. If default, use bare `--engine=cmd`. If pick, run `cmd --list-models` (grouped list, e.g. `claude-sonnet-4-6`, `gpt-5.5`, `deepseek/deepseek-v4-flash`) and pass the id verbatim: `--engine=cmd:<model>`.
- **Cursor (agent)**: model is optional. Ask "use default or pick a model?" via `AskUserQuestion`. If default, use bare `--engine=cursor`. If pick, run `agent --list-models` (flat list, e.g. `auto`, `gpt-5.2`, `sonnet-4`, `sonnet-4-thinking`) and pass the id verbatim: `--engine=cursor:<model>`. The engine names `cursor`, `cursor-agent`, and `agent` are interchangeable — all resolve to the `agent` binary.

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

### Reading the output

Every prompt is wrapped with a structured-output envelope before being passed to the engine:

```
<<<SECOND_OPINION_START>>>
... the engine's real answer ...
<<<SECOND_OPINION_END>>>
```

After the engine exits, locate the log file (see "Capturing output" below), `Read` it, and extract the text between `<<<SECOND_OPINION_START>>>` and `<<<SECOND_OPINION_END>>>`. Discard everything outside the markers — that is reasoning, tool noise, model scaffolding, or banner text. If the engine ignored the envelope (rare, but happens with smaller models), fall back to reading the full log.

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
| Unstaged changes | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom revision range | `--diff="HEAD~3..HEAD"` |
| Specific file | `--file=<absolute-path>` |
| General question | *(no flag — prompt is standalone)* |

The prompt argument is just the review template — `review.js` embeds diff/file content inline as a `<diff>` or `<file>` block before the prompt, so no read instructions are needed and no temp files are written.

## Default templates

These are fallbacks for Tier B (plain "review this" with no extra context). For Tier A, write a bespoke prompt — these templates can be a starting skeleton, but don't force-fit a nuanced question into them. The engine sees your prompt as-is plus the structured-output envelope; everything else is up to you.

### Code review (diff or file)
```
Review this as a senior engineer. Spawn all sub-agents simultaneously in a single batch — one per domain below — then synthesize their findings once all have returned. Do NOT spawn them sequentially or wait for one to finish before starting the next. If sub-agents are not supported, cover all domains yourself in a single pass.

Domains:
- **Security**: injection, auth flaws, data exposure, input validation, logic on untrusted input
- **Test coverage**: what's untested, what edge cases are missing, what would break silently
- **Regression**: what existing behaviour could this change break
- **Design**: abstractions, coupling, naming, maintainability red flags

Synthesized output:
**Summary**: What this does in one sentence
**Issues**: [HIGH/MED/LOW] description → suggested fix (tag each with its domain)
**Concerns**: Minor notes not worth a fix
**Positives**: What's done well (brief)

If nothing is wrong, say so plainly.
```

### Second opinion on approach
```
Give your honest assessment of this approach.

Structure as:
**Assessment**: Your take in 2-3 sentences
**Concerns**: What could go wrong or why this might be the wrong call
**Alternatives**: Other approaches worth considering (skip if none)

Be direct, not diplomatic.
```

### Security review
```
Review this code for security vulnerabilities. Focus on injection, auth, data exposure, input validation, and logic handling untrusted input.

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
