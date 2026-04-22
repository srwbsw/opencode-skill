# opencode-skill

A Claude Code plugin that adds an `opencode-review` skill — use [opencode](https://opencode.ai) to get a second opinion from your choice of AI model (GPT, Gemini, Llama, and more).

## Why

Different models have different strengths and blind spots. opencode gives you access to dozens of models in one CLI. This plugin lets you tap any of them for an independent review without leaving your Claude Code workflow.

opencode always runs in **plan mode** (`--approval-mode plan`) — read-only, no file system writes.

## Skills

### `opencode-review`

Asks you to pick a model from the opencode registry, then runs a structured review. Defaults to the free `opencode/*` models; you can pick any model from the full list.

**Supported use cases:**
- Code review on git diffs or specific files
- Second opinion on architectural or design decisions
- Security review
- General technical consultation

## Requirements

- [opencode](https://opencode.ai) installed (`opencode -h` should work)

## Installation

```bash
/plugin install opencode-skill@opencode-skill
```

## Usage

> "Use opencode to review this"
> "Ask opencode what it thinks about this approach"
> "Get opencode's opinion on this diff"

## License

MIT
