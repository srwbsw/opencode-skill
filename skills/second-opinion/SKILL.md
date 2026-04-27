---
name: second-opinion
description: Get a second opinion or code review from an AI engine of your choice. Use when the user asks for "a second opinion", "another perspective", "independent review", "cross-model review", or wants a review without specifying a particular engine. Ask which engine to use first, then follow that engine's complete review workflow. For engine-specific requests ("ask gemini", "use opencode", "codex review"), invoke the corresponding engine skill directly instead.
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

## Step 1: Select engine — REQUIRED FIRST STEP

**Always ask before doing anything else.** Do not assume an engine, do not skip to opencode, do not infer from context. Use `AskUserQuestion` to ask the user which engine to use. Present the currently supported engines:

| Engine | Model selection | Notes |
|---|---|---|
| Gemini CLI | Automatic (Gemini 2.5 Pro) | Google's Gemini, sandbox + plan mode |
| opencode | User picks from registry | 50+ models — GPT, Llama, Gemini, Mistral, and more |
| Codex CLI | Optional (type-in, no listing) | OpenAI's Codex, `--sandbox read-only` |
| GitHub Copilot CLI | Optional (type-in) | `--plan --deny-tool=write`, needs `copilot` in PATH |
| Qwen Code CLI | Optional (type-in) | Alibaba's Qwen, `-s --approval-mode plan` |
| Kilo | Provider → model (free first) | `--agent plan` |

Include "Other" so the user can type an engine not listed.

## Step 2: Gather inputs for the selected engine

After the user picks, follow the selected engine's skill to gather all needed inputs. Each engine skill is self-contained — read it for the full selection workflow.

### If Gemini CLI → follow `gemini-review` skill

No model selection step.

### If opencode → follow `opencode-review` skill

Two-step: provider first (`node "$LIST_SCRIPT" --engine=opencode providers`), then model (`node "$LIST_SCRIPT" --engine=opencode models --provider=<provider>`). Script returns `opencode` provider first and strips dated preview variants.

### If Codex CLI → follow `codex-review` skill

Model is optional — ask "use default or specify a model?" (type-in only, no listing command).

### If GitHub Copilot CLI → follow `copilot-review` skill

Model is optional — ask "use default or specify a model?" (type-in only).

### If Qwen Code CLI → follow `qwen-review` skill

Model is optional — ask "use default or specify a model?" (type-in only).

### If Kilo → follow `kilo-review` skill

Two-step: provider first (`node "$LIST_SCRIPT" --engine=kilo providers`), then model (`node "$LIST_SCRIPT" --engine=kilo models --provider=<provider>`). Script returns free models first.

## Step 3: Fire

Final command format:
```bash
"$REVIEW_SCRIPT" --engine=<engine> [--model=<model>] --cwd=<repo-path> [--diff=<spec>|--file=<path>] "<review template>"
```

`review.js` handles fetching diff/file content and injecting a read instruction into the prompt. No need to run `git diff` yourself.

## Determining what to review

Ask or infer what to review, then pass the appropriate flag to `review.js`. The script handles fetching — Claude never reads or passes the diff content through context.

| What to review | Flag |
|---|---|
| Unstaged changes | `--diff=unstaged` |
| Staged changes | `--diff=staged` |
| Last commit | `--diff=last-commit` |
| Branch vs main | `--diff=branch` |
| Custom revision range | `--diff="HEAD~3..HEAD"` |
| Specific file | `--file=<absolute-path>` |
| General question | *(no flag — prompt is standalone)* |

The prompt argument is just the review template (no read instructions needed — `review.js` prepends those automatically).

## Prompt templates

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
2. Add a `case` block to `bin/review.js` with the engine's read-only/sandbox flags
3. If the engine needs provider/model discovery, add a `case` block to `bin/list.js`
4. Update the engine table in Step 1 above and add a dispatch block in Step 2
5. Add the engine's required safety flags to `requiredFlags` in `test/safety.test.js` and run `npm run lint` to verify
