# skills/ — engine skill docs

`skills/second-opinion/SKILL.md` is **canonical**: it owns the prompt tiers, default review templates, fusion guidance, and the "Adding new engines" checklist. Per-engine skills (`<engine>-review/SKILL.md`) **delegate** prompt/template guidance to it — do NOT copy templates into each engine skill (that's the duplication this layout exists to avoid).

## Adding an engine

Follow "Adding new engines" in `second-opinion/SKILL.md` (review.js `case` + `SAFETY_FLAGS`, `list.js` if it needs provider/model discovery, the engine tables, and `safety.test.js`). Then add a test fixture and a `requiredFunctionalFlags` entry — see `test/CLAUDE.md`.

## Keep the engine list in sync

The set of engines is repeated in three places — update all when adding/removing:
- `bin/review.js` → `SUPPORTED_ENGINES`
- `README.md` → Engines table
- `skills/second-opinion/SKILL.md` → engine table (Step 1)
