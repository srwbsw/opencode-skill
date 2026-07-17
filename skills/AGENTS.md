# skills/ — engine skill docs

`skills/second-agent/SKILL.md` is **canonical** for both workflows the plugin supports: getting a second opinion/review, and delegating an arbitrary task to another engine via `agent.js`. The prompt tiers, full template set, fusion guidance, and the "Adding new engines" checklist live in `skills/second-agent/references/` (`prompts.md`, `fusion.md`, `adding-engines.md`) — SKILL.md stays lean and points to them. Per-engine skills (`<engine>-agent/SKILL.md`) carry **only** the canonical compact review prompt (review-template) plus the canonical task-delegation blocks (locate-agent, task-golden-path, task-template) below — edit them here, never per-file; for context-rich prompts and the rest of the template set they delegate to `second-agent/references/prompts.md`. Never hand-copy anything else per-skill.

## Adding an engine

Follow `references/adding-engines.md` under `second-agent/` (the `SAFETY_FLAGS` map + `buildEngineCmd()` case block in `bin/lib/engines.js`, `list.js` if it needs provider/model discovery, the engine tables, and `safety.test.js`). `agent.js` shares that same case block, so task-mode support for a new engine is automatic — its `<engine>-agent` skill just embeds the canonical task blocks below, same as every other engine. Then add a test fixture and a `requiredFunctionalFlags` entry — see `test/CLAUDE.md`.

## Keep the engine list in sync

The set of engines is repeated in four places — update all when adding/removing
(`test/host-parity.test.js` enforces the first pair staying in sync with each
other; the other two are prose, not test-enforced):
- `bin/review.js` **and** `bin/agent.js` → each keeps its own literal
  `SUPPORTED_ENGINES`/`ENGINE_ALIASES` const (NOT hoisted to `bin/lib/engines.js`
  — see that file's header comment for why)
- `README.md` → Engines table
- `skills/second-agent/SKILL.md` → engine table ("Choose an engine and model")

## Host parity — every engine is also a supported host

**Invariant:** the set of supported **host harnesses** (where a user installs the
plugin and triggers reviews) must equal the set of supported **engines** (what
`review.js`/`agent.js` spawn). Adding or removing an engine means adding or removing
the matching host integration in the same change — never let the two sets drift.

A host integration = (a) detection + install in `install.sh`, and (b) an adapter
in that harness's native format that loads the second-agent workflow and embeds
the canonical REVIEW snippet (so `test/locate.test.js` covers it).

| Engine / host | Host adapter (reused/new) | `install.sh` mechanism | Status |
|---|---|---|---|
| claude | `.claude-plugin` + `skills/*/SKILL.md` | `claude plugin marketplace add` + `install` | ✅ |
| codex | `.codex-plugin` + skills | `codex plugin marketplace add` + `add` (`source: url`) | ✅ |
| agent (cursor) | `.cursor/rules/second-agent.mdc` | copy → `~/.cursor/rules/` | ✅ |
| opencode | `.opencode/command/second-agent.md` | copy → `~/.config/opencode/command/` | ✅ |
| gemini | `gemini-extension.json` + `commands/second-agent.toml` | `gemini extensions link` | ✅ |
| qwen | reuses `commands/second-agent.toml` | copy → `~/.qwen/commands/` (gemini-cli fork) | 🔶 built, unverified (qwen not installed locally) |
| copilot | reuses `skills/*/SKILL.md` | `copilot plugin install` | ✅ |
| agy | reuses `skills/*/SKILL.md` | `agy plugin install <dir>` | ✅ |
| kilo | reuses `.opencode/command/second-agent.md` | copy → `~/.config/kilo/command/` (opencode fork) | ✅ |
| cmd | reuses `skills/*/SKILL.md` | `cmd skills add <repo> -g` | ✅ |
| kiro-cli | — (none) | — (none) | ⛔ engine-only exception |

`test/host-parity.test.js` enforces the invariant: the `HOSTS=` list in
`install.sh` must equal `SUPPORTED_ENGINES` (cursor≡agent), each host needs an
`if want <host>;` block, and there are no orphan hosts. If a harness genuinely
has no host/skill mechanism it stays engine-only — record it in that test's
`EXCEPTIONS` (with a reason) rather than silently dropping it. `kiro-cli` is
the one recorded exception as of this writing: it is an MCP-only host with no
skill/plugin-install mechanism (v2.12.3), so it has a `<engine>-agent` skill
(review + task delegation via `review.js`/`agent.js`) but no `install.sh`
block and no `HOSTS=` entry — reviewing WITH kiro-cli works, installing INTO
it does not (yet).

## Locating the runner — canonical snippet (harness-agnostic)

Every SKILL embeds the **REVIEW** block verbatim; the three list-using engines
(`opencode`, `kilo`, `second-agent`) additionally embed the **LIST** block.
The host adapters `.opencode/command/second-agent.md` (opencode), `.cursor/rules/second-agent.mdc`
(Cursor CLI), and `commands/second-agent.toml` (gemini + qwen) embed the
**REVIEW** block too, plus the three task-delegation blocks below (see
"Locating the task runner" and the task-golden-path/task-template sections).
`test/locate.test.js` extracts the blocks below and fails if any of them drift —
**edit the snippet here, never per-file.**

Resolution order is reliability-first, so a harness that puts plugin `bin/` on
`PATH` (Claude Code does) needs zero path logic. Adding a new harness = one extra
fallback line, not a new per-skill block:

1. `SECOND_OPINION_REVIEW` / `SECOND_OPINION_LIST` env override (any harness / power user)
2. `command -v` on `PATH` (Claude Code adds each plugin's `bin/` to `PATH`)
3. Codex local install (`~/plugins/second-opinion-skill/bin/`)
4. Claude Code marketplace cache glob
5. repo-local dev checkout (`$PWD/bin/`)

<!-- BEGIN locate-review -->
```bash
REVIEW_SCRIPT="${SECOND_OPINION_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-opinion-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```
<!-- END locate-review -->

<!-- BEGIN locate-list -->
```bash
LIST_SCRIPT="${SECOND_OPINION_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-opinion-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```
<!-- END locate-list -->

`command -v` returns empty (not an error) when the script is not on `PATH`, so the
guards fall through cleanly. `grep -v '\*'` drops a literal-glob non-match (bash
leaves the pattern unexpanded when nothing matches). REVIEW uses `[ -x ]` because
skills exec it directly (`"$REVIEW_SCRIPT" …`, relies on the +x shebang); LIST uses
`[ -f ]` because skills run it via `node "$LIST_SCRIPT" …`, so a stale cache copy
that lost its exec bit still resolves.

## Locating the task runner — canonical snippet (`agent.js`)

`agent.js` is `review.js`'s sibling entry point for task delegation (see root
`AGENTS.md`) and resolves the same PATH-first way, with its own env override so
a caller can point at either script independently:

<!-- BEGIN locate-agent -->
```bash
AGENT_SCRIPT="${SECOND_OPINION_AGENT:-$(command -v agent.js || true)}"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$HOME/plugins/second-opinion-skill/bin/agent.js"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-opinion-skill/second-opinion-skill/*/bin/agent.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$PWD/bin/agent.js"
```
<!-- END locate-agent -->

The hub and every `<engine>-agent` skill embed this verbatim in their `## Task
mode` section. `install.sh` symlinks `agent.js` into the bindir alongside
`review.js`/`list.js`, so step 2 (`command -v` on `PATH`) resolves it the same
way. Steps 3 (Codex local install) and 4 (Claude Code marketplace cache glob)
work automatically too, since both installs clone the full repo tree rather
than symlink individual files; step 5 (repo-local checkout) always works from
a dev checkout.

## Golden path — canonical snippet (small-model refactor)

The single copy-paste "locate → run → read the answer" recipe every engine skill leads with; it is canonical, embedded verbatim by every engine skill, and enforced by `test/locate.test.js` — edit it here, never per-file.

<!-- BEGIN golden-path -->
```bash
# 1. Run (REVIEW_SCRIPT resolved by the snippet above):
"$REVIEW_SCRIPT" --engine=<engine> --cwd=<repo> --diff=unstaged "<review prompt>"
# 2. Result: stdout prints `ANSWER FILE: <path>`; the last line is a SECOND_OPINION_RESULT JSON.
#    Read the ANSWER FILE with the Read tool — it is the engine's clean answer.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```
<!-- END golden-path -->

## Task golden path — canonical snippet

The task-delegation counterpart to the golden path above: locate `agent.js`, run it with the required `--unrestricted` acknowledgment, then read the result. It is canonical, embedded verbatim by the hub and every engine skill's `## Task mode` section, and enforced by `test/locate.test.js` — edit it here, never per-file.

<!-- BEGIN task-golden-path -->
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
<!-- END task-golden-path -->

## Review template — canonical snippet (small-model refactor)

The compact default code-review prompt every engine skill falls back to when the user has no extra context to add; it is canonical, embedded verbatim by every engine skill, and enforced by `test/locate.test.js` — edit it here, never per-file. `second-agent/SKILL.md` owns the full template set (Tier A/B/C guidance, approach/security/consultation templates) in `references/prompts.md` — this compact form is the one engine skills carry inline.

<!-- BEGIN review-template -->
```
Review this as a senior engineer. Cover:
- **Correctness**: logic errors, edge cases, error handling, concurrency/race conditions, boundary bugs
- **Security**: injection, auth/access-control gaps, unsafe input handling, secrets exposure
- **Regression**: what existing behavior this could break
- **Test coverage**: what's untested or would fail silently
- **Maintainability**: naming, readability, duplication, dead code

Output:
**Summary**: what this does, one sentence
**Issues**: [HIGH/MED/LOW] description → fix
**Concerns**: minor notes not worth a fix
**Positives**: what's done well (brief)

If nothing is wrong, say so plainly. Prioritize HIGH-severity correctness/security findings over style.
```
<!-- END review-template -->

## Task template — canonical snippet

The compact default task prompt every engine skill's `## Task mode` section falls back to when the caller has no more specific task description ready; it is canonical, embedded verbatim, and enforced by `test/locate.test.js` — edit it here, never per-file. Unlike the review template, this one is a skeleton, not literal prose to send as-is: the `<task statement>` line must be replaced with the actual task before running `agent.js`.

<!-- BEGIN task-template -->
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
<!-- END task-template -->
