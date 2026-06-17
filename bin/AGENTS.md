# bin/ — review runner & helpers

`review.js` is the single entry for all engines. `list.js` does provider/model discovery (opencode, kilo). `shell-quote.js` and `env-guard.js` are pure modules, each with its own unit test in `test/`.

## review.js engine model

Engine wiring lives in: `SUPPORTED_ENGINES`, `ENGINE_ALIASES` (cursor/cursor-agent → agent), `MODEL_REQUIRED` (opencode), the `SAFETY_FLAGS` map, and the `buildEngineCmd()` switch (one `case` per engine). Fusion = repeating `--engine=`; the parent re-spawns `review.js` once per slot (children re-parse argv independently).

## Safety vs functional flags

`SAFETY_FLAGS[engine]` = read-only / sandbox / plan flags, **stripped by `--unrestricted`** (e.g. codex `-s read-only`, claude `--permission-mode plan`). Everything else in a `case` block is **functional** and must survive `--unrestricted`: `--print` / `exec` / `run`, plus the non-interactive / trust flags — codex `--skip-git-repo-check`, gemini `--skip-trust`, opencode `--dir <cwd>`, cmd `--skip-onboarding`, agent `--trust`.

`SAFETY_FLAGS` entries must stay simple string-literal lines (no spreads, no computed values) — `test/safety.test.js` parses them by regex (see `test/CLAUDE.md`).

## Exit codes

`0` success · `3` clean exit but no usable output (0 bytes, or — when wrapped — missing the `<<<SECOND_OPINION_START>>>` envelope) · `124` timeout · otherwise the engine CLI's own code.

## Secret guard

`env-guard.js` keeps `.env`-style files out of prompts: refuse `--file=.env`, skip untracked `.env`, redact `.env` diff hunks (incl. git's c-quoted headers for non-ASCII paths), and pathspec-exclude in `--no-embed`. `--include-secrets` opts out. Matcher: `.env` / `.env.*` / `*.env`, exempting `*example*` / `*sample*` / `*template*`.

Adding an engine: see `skills/CLAUDE.md` (canonical checklist in `skills/second-opinion/SKILL.md`).
