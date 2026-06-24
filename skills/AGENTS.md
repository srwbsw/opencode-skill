# skills/ — engine skill docs

`skills/second-opinion/SKILL.md` is **canonical**: it owns the prompt tiers, default review templates, fusion guidance, and the "Adding new engines" checklist. Per-engine skills (`<engine>-review/SKILL.md`) **delegate** prompt/template guidance to it — do NOT copy templates into each engine skill (that's the duplication this layout exists to avoid).

## Adding an engine

Follow "Adding new engines" in `second-opinion/SKILL.md` (review.js `case` + `SAFETY_FLAGS`, `list.js` if it needs provider/model discovery, the engine tables, and `safety.test.js`). Then add a test fixture and a `requiredFunctionalFlags` entry — see `test/CLAUDE.md`.

## Keep the engine list in sync

The set of engines is repeated in three places — update all when adding/removing:
- `bin/review.js` → `SUPPORTED_ENGINES`
- `README.md` → Engines table
- `skills/second-opinion/SKILL.md` → engine table (Step 1)

## Locating the runner — canonical snippet (harness-agnostic)

Every SKILL embeds the **REVIEW** block verbatim; the three list-using engines
(`opencode`, `kilo`, `second-opinion`) additionally embed the **LIST** block.
`test/locate.test.js` extracts the blocks below and fails if any SKILL drifts —
**edit the snippet here, never per-skill.**

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
