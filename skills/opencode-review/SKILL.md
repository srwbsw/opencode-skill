---
name: opencode-review
description: Get a second opinion or code review from opencode CLI using a user-selected AI model. Use this skill whenever the user says "use opencode", "ask opencode", "review with opencode", "get opencode's opinion", or wants a second opinion from a specific model available through opencode. Also invoke proactively when the user wants a non-Gemini, non-Claude perspective on code or architecture. Always ask the user to pick a model before running — default to showing the opencode/* list first.
version: 1.0.1
---

# Opencode Review

Use `opencode run` non-interactively to get a second opinion from a model the user chooses. Opencode gives access to a wide range of providers — the value is picking a model trained differently for a genuinely independent perspective.

## Model selection (always required)

Before running, ask the user to pick a model using `AskUserQuestion`. Show the recommended defaults first:

```bash
opencode models --refresh 2>&1 | grep "^opencode/"
```

Present the `opencode/*` models as **recommended defaults** (free/low-cost, purpose-built). The "Other" option in the question lets the user type any model from the full list:

```bash
opencode models --refresh 2>&1
```

The chosen model must appear in the `opencode models --refresh` output. Format is always `provider/model` (e.g., `opencode/nemotron-3-super-free`, `google/gemini-2.5-pro`, `github-copilot/gpt-5.4`).

Pass the selected model as `--model <provider/model>`.

## Running opencode

Always use `--agent plan` — the plan agent enforces `"edit": "deny"` at the permission level, making file writes structurally impossible, not just instructed away.

**Basic pattern — pipe content with a prompt:**
```bash
<content> | opencode run --model <provider/model> --agent plan "<structured prompt>"
```

**With a file attachment:**
```bash
opencode run --model <provider/model> --agent plan -f <absolute-path> "<structured prompt>"
```

**Multiple files:**
```bash
opencode run --model <provider/model> --agent plan -f <file1> -f <file2> "<structured prompt>"
```

**With a variant (reasoning effort) for supported models:**
```bash
opencode run --model <provider/model> --agent plan --variant high "<prompt>"
```

## Getting content to pipe

**Git changes:**
```bash
git -C <repo-path> diff | opencode run --model <model> --agent plan "<prompt>"
git -C <repo-path> diff --staged | opencode run --model <model> --agent plan "<prompt>"
git -C <repo-path> diff HEAD~1 | opencode run --model <model> --agent plan "<prompt>"
```

**Specific file:**
```bash
cat <absolute-path> | opencode run --model <model> --agent plan "<prompt>"
```

## Prompt templates

Structure is baked into the prompt since output format can't be configured separately.

### Code review (diff or file)
```
Review this as a senior engineer. Be direct and critical.

Structure your response:
**Summary**: What this does in one sentence
**Issues**: Bugs, security flaws, design problems — format each as [HIGH/MED/LOW] description → suggested fix
**Concerns**: Minor style or maintainability notes
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

## Presenting results

Show the full response under a `## Opencode's Take (<model>)` heading — include the model name so the user knows which perspective they're getting. Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
