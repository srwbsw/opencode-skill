# second-opinion-skill

**A Claude Code plugin that routes code reviews to the AI engine of your choice — Gemini CLI, opencode, and more.**

No single model catches everything. This plugin makes cross-engine review a first-class part of your Claude Code workflow: pick an engine, optionally pick a model, get an independent perspective in seconds.

## Engines

| Engine | Model selection | How it runs |
|---|---|---|
| **Gemini CLI** | Automatic | `gemini -s --approval-mode plan` — sandbox + read-only |
| **opencode** | User picks from registry | `opencode run --agent plan` — 50+ models, read-only |
| **Codex CLI** | Optional (type-in) | `codex exec -s read-only` — OpenAI's Codex, sandbox read-only |

More engines (Kilo, etc.) will be added as engine-specific skills following the same pattern.

## Skills

| Skill | Trigger | Description |
|---|---|---|
| `second-opinion` | "second opinion", "independent review", no engine specified | Asks which engine to use, then dispatches |
| `gemini-review` | "ask Gemini", "review with Gemini", "Gemini's take" | Runs Gemini CLI directly, no model selection |
| `opencode-review` | "use opencode", "ask opencode", "review with opencode" | Runs opencode with user-selected model |
| `codex-review` | "ask Codex", "review with Codex", "Codex's take" | Runs Codex CLI, optional model, sandbox read-only |

## Use cases

- **Code review** — pipe a `git diff` or file for a senior-engineer-style critique
- **Second opinion** — get an independent take on an architectural or design decision
- **Security review** — scan for injection, auth flaws, data exposure, and input validation issues
- **General consultation** — ask any technical question and get a structured answer

## Requirements

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated — for `gemini-review`
- [opencode](https://opencode.ai) installed — for `opencode-review`
- [Codex CLI](https://github.com/openai/codex) installed — for `codex-review`
- [Claude Code](https://claude.ai/code) (CLI, desktop app, or IDE extension)

You only need the CLI tools for the engines you actually use.

## Permissions

All engine execution goes through a single `bin/review.js` script — grant permission once instead of per-engine. After installing the plugin, allow it in your Claude Code settings:

```json
{
  "permissions": {
    "allow": ["Bash(~/.claude/plugins/second-opinion-skill/bin/review.js*)"]
  }
}
```

## Installation

```bash
/plugin marketplace add srwbsw/second-opinion-skill
/plugin install second-opinion-skill@second-opinion-skill
```

## Usage

**Engine-agnostic (orchestrator picks):**
> "Get a second opinion on this"
> "Independent review of these changes"
> "Cross-model review"

**Gemini-specific:**
> "Ask Gemini to review this"
> "What does Gemini think about this approach?"
> "Gemini security review"

**opencode-specific:**
> "Use opencode to review this"
> "Review with GPT"
> "Ask opencode's opinion on this diff"

**Codex-specific:**
> "Ask Codex to review this"
> "Codex review with o3"
> "Get Codex's take on this approach"

When no engine is specified, the `second-opinion` skill asks you to pick one. The `opencode-review` skill always asks you to pick a model from the registry — defaulting to free `opencode/*` models. The `gemini-review` skill runs immediately with no model selection. The `codex-review` skill asks whether you want to specify a model or use the default.

Results are structured: **Summary**, **Issues** (HIGH/MED/LOW), **Concerns**, **Positives**.

## Why cross-engine review?

Different models are trained on different data with different architectures. Gemini flags different categories of issues than Claude. opencode gives you access to GPT, Llama, Mistral, and dozens of others. Running your changes through a differently-trained model before declaring done is the same instinct as a second engineer reading your PR — except it takes seconds.

## License

MIT
