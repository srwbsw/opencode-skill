# second-opinion-skill

**A Claude Code plugin that routes code reviews to the AI engine of your choice — Gemini, opencode, Codex, Copilot, Qwen, Kilo.**

No single model catches everything. This plugin makes cross-engine review a first-class part of your Claude Code workflow: pick an engine, optionally pick a model, get an independent perspective in seconds.

This repo also ships a Codex-compatible plugin manifest at [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), so the same bundle can be recognized outside Claude Code as well.

## Engines

| Engine | Model selection | Read-only flags |
|---|---|---|
| **Gemini CLI** | Automatic | `-s --approval-mode plan` |
| **opencode** | Provider → model (from registry) | `--agent plan` |
| **Codex CLI** | Optional (type-in) | `-s read-only` |
| **GitHub Copilot CLI** | Optional (type-in) | `--plan --deny-tool=write --allow-all-tools` |
| **Qwen Code CLI** | Optional (type-in) | `-s --approval-mode plan` |
| **Kilo** | Provider → model (free shown first) | `--agent plan` |

All engines launch from the repo directory (`--cwd`) and read content via native filesystem tools — no stdin piping.

## Skills

| Skill | Trigger phrases |
|---|---|
| `second-opinion` | "second opinion", "independent review", "cross-model review" |
| `gemini-review` | "ask Gemini", "review with Gemini", "Gemini's take" |
| `opencode-review` | "use opencode", "ask opencode", "review with opencode" |
| `codex-review` | "ask Codex", "review with Codex", "Codex's take" |
| `copilot-review` | "ask Copilot", "review with Copilot", "Copilot review" |
| `qwen-review` | "ask Qwen", "review with Qwen", "Qwen's take" |
| `kilo-review` | "ask Kilo", "review with Kilo", "Kilo's take" |

## Use cases

- **Code review** — senior-engineer-style critique with parallel sub-agent coverage (security, test coverage, regression, design)
- **Second opinion** — independent take on an architectural or design decision
- **Security review** — scan for injection, auth flaws, data exposure, input validation
- **General consultation** — any technical question with a structured answer

## Requirements

- [Claude Code](https://claude.ai/code) (CLI, desktop app, or IDE extension)
- Node.js (for running `bin/review.js` and `bin/list.js` — any modern version)
- The CLI for each engine you want to use:
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `gemini-review`
  - [opencode](https://opencode.ai) — `opencode-review`
  - [Codex CLI](https://github.com/openai/codex) — `codex-review`
  - [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) — `copilot-review`
  - [Qwen Code CLI](https://github.com/QwenLM/qwen-code) — `qwen-review`
  - [Kilo](https://kilocode.ai) — `kilo-review`

You only need the CLIs for the engines you actually use.

## Versioning

Release versions are managed by GitHub Actions. The workflow updates `package.json`, the Claude marketplace metadata, and the Codex plugin manifest together, so you do not need to edit version numbers by hand.

## Permissions

All engine execution goes through `bin/review.js`, and all provider/model discovery goes through `bin/list.js` — grant permissions once instead of per-engine or per-CLI:

```json
{
  "permissions": {
    "allow": [
      "Bash(~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js*)",
      "Bash(node ~/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js*)"
    ]
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

**Engine-specific:**
> "Ask Gemini to review this"
> "Use opencode to review this diff"
> "Codex review with o3"
> "Ask Copilot's take on this approach"
> "Qwen security review"
> "Kilo review with a free model"

When no engine is specified, the `second-opinion` skill asks you to pick one. Each engine-specific skill handles its own model flow: Gemini runs immediately; opencode and Kilo walk through provider → model selection; Codex, Copilot, and Qwen optionally let you type in a model.

Results are structured: **Summary**, **Issues** (HIGH/MED/LOW tagged by domain), **Concerns**, **Positives**. The code review prompt instructs engines to spawn parallel sub-agents per domain where supported.

## Why cross-engine review?

Different models are trained on different data with different architectures. Gemini flags different categories of issues than Claude. opencode and Kilo give you access to GPT, Llama, Mistral, Qwen, and dozens of others. Running your changes through a differently-trained model before declaring done is the same instinct as a second engineer reading your PR — except it takes seconds.

## License

MIT
