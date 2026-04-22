---
name: opencode-review
description: Get a second opinion or code review from opencode CLI using a user-selected AI model. Use this skill whenever the user says "use opencode", "ask opencode", "review with opencode", "get opencode's opinion", or wants a second opinion from a specific model available through opencode. Always ask the user to pick a provider then a model before running — default to the opencode/* provider first.
version: 2.1.0
---

# Opencode Review

Use `opencode run` non-interactively to get a second opinion from a model the user chooses. The flow is always: pick provider → pick model → run via `review.js`.

## Locating review.js

Find the script with:
```bash
ls ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | tail -1
```

Store the result as `REVIEW_SCRIPT`. All execution goes through this script — do not call the engine CLIs directly.

## Step 1: Provider selection

Run the following to get the list of available providers:

```bash
opencode models --refresh 2>&1 | grep -v '^\[' | sed 's|/.*||' | sort -u
```

Present the results as an `AskUserQuestion` with up to 4 options. Always put `opencode` first as the recommended default (free/low-cost, no API key needed). Include the others based on what the command returns (typically `github-copilot`, `google`, `openrouter`).

## Step 2: Model selection

Once the user picks a provider, check whether it uses sub-providers, then fetch and deduplicate the model list.

**Check for sub-providers (works for any provider):**
```bash
opencode models --refresh 2>&1 | grep -v '^\[' | grep "^<provider>/" | awk -F/ 'NF>=3 {print $2}' | sort -u
```

If this returns output, the provider has sub-providers. Ask the user to pick one (AskUserQuestion), then scope all further commands to `<provider>/<sub-provider>/`.

If it returns nothing, skip straight to the model list.

**Fetch and deduplicate the model list:**

Replace `<prefix>` with either `<provider>/` (no sub-providers) or `<provider>/<sub-provider>/` (with sub-providers):
```bash
opencode models --refresh 2>&1 | grep -v '^\[' | grep "^<prefix>" | grep -Ev -- '-preview-[0-9]{2}-[0-9]{2,4}|-[0-9]{4}-[0-9]{2}-[0-9]{2}' | sort -u
```

The `grep -Ev` strips dated preview variants (e.g., `gemini-2.5-flash-preview-04-17`, `gemini-2.5-pro-preview-06-05`) — keep canonical names, ignore the dated clutter.

**Presenting the model list:**

Print the deduplicated list in your response so the user can see their options. Then use `AskUserQuestion` with 3–4 of the most relevant models from the list as quick-pick options — the "Other" option lets the user type any model from the printed list.

For small lists (≤5 models), show all of them as options. For larger lists, pick the most capable/current ones based on what appears in the output.

The chosen model must be a valid `provider/model` string from the `opencode models --refresh` output (e.g., `opencode/nemotron-3-super-free`, `google/gemini-2.5-pro`, `github-copilot/gpt-5.4`).

## Step 3: Run

With `REVIEW_SCRIPT`, the chosen `MODEL`, the content to review, and the prompt template — fire the single command:

```bash
<content> | "$REVIEW_SCRIPT" --engine=opencode --model=<provider/model> "<structured prompt>"
```

**Getting content to pipe:**

```bash
# Unstaged/staged changes
git -C <repo-path> diff
git -C <repo-path> diff --staged

# Recent commit
git -C <repo-path> diff HEAD~1

# Specific file
cat <absolute-path>
```

## Prompt templates

Use the templates from the `second-opinion` skill.

## Presenting results

Show the full response under a `## Opencode's Take (<model>)` heading — include the model name so the user knows which perspective they're getting. Don't filter or summarize. If issues are raised that need fixing, address them and note what changed.
