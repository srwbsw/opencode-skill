# skills/ — engine skill docs

`skills/second-opinion/SKILL.md` is **canonical**: it owns the prompt tiers, default review templates, fusion guidance, and the "Adding new engines" checklist. Per-engine skills (`<engine>-review/SKILL.md`) **delegate** prompt/template guidance to it — do NOT copy templates into each engine skill (that's the duplication this layout exists to avoid).

## Adding an engine

Follow "Adding new engines" in `second-opinion/SKILL.md` (review.js `case` + `SAFETY_FLAGS`, `list.js` if it needs provider/model discovery, the engine tables, and `safety.test.js`). Then add a test fixture and a `requiredFunctionalFlags` entry — see `test/CLAUDE.md`.

## Keep the engine list in sync

The set of engines is repeated in three places — update all when adding/removing:
- `bin/review.js` → `SUPPORTED_ENGINES`
- `README.md` → Engines table
- `skills/second-opinion/SKILL.md` → engine table (Step 1)

## Host parity — every engine is also a supported host

**Invariant:** the set of supported **host harnesses** (where a user installs the
plugin and triggers reviews) must equal the set of supported **engines** (what
`review.js` spawns). Adding or removing an engine means adding or removing the
matching host integration in the same change — never let the two sets drift.

A host integration = (a) detection + install in `install.sh`, and (b) an adapter
in that harness's native format that loads the second-opinion workflow and embeds
the canonical REVIEW snippet (so `test/locate.test.js` covers it).

| Engine / host | Host adapter (reused/new) | `install.sh` mechanism | Status |
|---|---|---|---|
| claude | `.claude-plugin` + `skills/*/SKILL.md` | `claude plugin marketplace add` + `install` | ✅ |
| codex | `.codex-plugin` + skills | `codex plugin marketplace add` + `add` (`source: url`) | ✅ |
| agent (cursor) | `.cursor/rules/second-opinion.mdc` | copy → `~/.cursor/rules/` | ✅ |
| opencode | `.opencode/command/second-opinion.md` | copy → `~/.config/opencode/command/` | ✅ |
| gemini | `gemini-extension.json` + `commands/second-opinion.toml` | `gemini extensions link` | ✅ |
| qwen | reuses `commands/second-opinion.toml` | copy → `~/.qwen/commands/` (gemini-cli fork) | 🔶 built, unverified (qwen not installed locally) |
| copilot | reuses `skills/*/SKILL.md` | `copilot plugin install` | ✅ |
| agy | reuses `skills/*/SKILL.md` | `agy plugin install <dir>` | ✅ |
| kilo | reuses `.opencode/command/second-opinion.md` | copy → `~/.config/kilo/command/` (opencode fork) | ✅ |
| cmd | reuses `skills/*/SKILL.md` | `cmd skills add <repo> -g` | ✅ |

`test/host-parity.test.js` enforces the invariant: the `HOSTS=` list in
`install.sh` must equal `SUPPORTED_ENGINES` (cursor≡agent), each host needs an
`if want <host>;` block, and there are no orphan hosts. If a harness genuinely
has no host/skill mechanism it stays engine-only — record it in that test's
`EXCEPTIONS` (with a reason) rather than silently dropping it.

## Locating the runner — canonical snippet (harness-agnostic)

Every SKILL embeds the **REVIEW** block verbatim; the three list-using engines
(`opencode`, `kilo`, `second-opinion`) additionally embed the **LIST** block.
The host adapters `.opencode/command/second-opinion.md` (opencode) and
`.cursor/rules/second-opinion.mdc` (Cursor CLI) embed the **REVIEW** block too.
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
