---
name: second-opinion
description: Get a second opinion or code review from an AI engine of your choice. Use when the user asks for "a second opinion", "another perspective", "independent review", "cross-model review", or wants a review without specifying a particular engine. Ask which engine to use first, then follow that engine's complete review workflow. For engine-specific requests ("ask gemini", "use opencode", "codex review"), invoke the corresponding engine skill directly instead.
version: 2.0.0
---

# Second Opinion

Orchestrates a cross-engine code review. Ask which engine to use, then follow that engine's full review workflow. All execution goes through `review.js` — locate it once, use it for every engine.

## Locating review.js

```bash
ls ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | tail -1
```

Store the result as `REVIEW_SCRIPT`. All engine commands use this script.

## Step 1: Select engine — REQUIRED FIRST STEP

**Always ask before doing anything else.** Do not assume an engine, do not skip to opencode, do not infer from context. Use `AskUserQuestion` to ask the user which engine to use. Present the currently supported engines:

| Engine | Model selection | Notes |
|---|---|---|
| Gemini CLI | Automatic (Gemini 2.5 Pro) | Google's Gemini, sandbox + plan mode |
| opencode | User picks from registry | 50+ models — GPT, Llama, Gemini, Mistral, and more |
| Codex CLI | Optional (type-in, no listing) | OpenAI's Codex, `--sandbox read-only` |
| GitHub Copilot CLI | Optional (type-in) | `--plan --deny-tool=write`, needs `copilot` in PATH |

Include "Other" so the user can type an engine not listed (e.g., a future engine like Kilo).

## Step 2: Gather inputs for the selected engine

After the user picks, follow the selected engine's skill to gather all needed inputs. Each engine skill is self-contained — read it for the full selection workflow.

### If Gemini CLI → follow `gemini-review` skill

No model selection step. Determine what to review, build the prompt with the appropriate read instruction, then:

Final command:
```bash
"$REVIEW_SCRIPT" --engine=gemini --cwd=<repo-path> "<structured prompt>"
```

### If opencode → follow `opencode-review` skill

Follow the full provider → sub-provider → model selection workflow in the `opencode-review` skill.

Final command:
```bash
"$REVIEW_SCRIPT" --engine=opencode --model=<provider/model> --cwd=<repo-path> "<structured prompt>"
```

### If Codex CLI → follow `codex-review` skill

Model is optional — ask "use default or specify a model?" (type-in only, no listing command).

Final command:
```bash
# Without model
"$REVIEW_SCRIPT" --engine=codex --cwd=<repo-path> "<structured prompt>"

# With model
"$REVIEW_SCRIPT" --engine=codex --model=<model> --cwd=<repo-path> "<structured prompt>"
```

### If GitHub Copilot CLI → follow `copilot-review` skill

Model is optional — ask "use default or specify a model?" (type-in only).

Final command:
```bash
# Without model
"$REVIEW_SCRIPT" --engine=copilot --cwd=<repo-path> "<structured prompt>"

# With model
"$REVIEW_SCRIPT" --engine=copilot --model=<model> --cwd=<repo-path> "<structured prompt>"
```

## Step 3: Fire

Once all inputs are gathered, execute the single `review.js` command. The engine launches from the repo directory and reads content via native filesystem tools — no stdin piping needed.

## Determining what to review

Ask or infer what to review, then build the prompt accordingly.

| What to review | Read instruction prefix |
|---|---|
| Unstaged changes | `"Run \`git diff\` to see unstaged changes in this repository, then:"` |
| Staged changes | `"Run \`git diff --staged\` to see staged changes, then:"` |
| Last commit | `"Run \`git diff HEAD~1\` to see the last commit, then:"` |
| Specific file | `"Read the file at <absolute-path>, then:"` |
| General question | *(no prefix — pass the question directly)* |

Construct the full prompt as:

```
<read instruction>

<review template>
```

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
2. Add a `case` block to `bin/review.js`
3. Update the engine table in Step 1 above and add a dispatch block in Step 2
4. Add the engine's required safety flags to `requiredFlags` in `test/safety.test.js` and run `npm run lint` to verify
