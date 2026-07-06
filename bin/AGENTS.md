# bin/ — review runner & helpers

`review.js` is the single entry for all engines. `list.js` does provider/model discovery (opencode, kilo). `shell-quote.js` and `env-guard.js` are pure modules, each with its own unit test in `test/`.

## review.js engine model

Engine wiring lives in: `SUPPORTED_ENGINES`, `ENGINE_ALIASES` (cursor/cursor-agent → agent), `MODEL_REQUIRED` (fail-fast set, currently empty — every engine defers a missing model to its CLI default), the `SAFETY_FLAGS` map, and the `buildEngineCmd()` switch (one `case` per engine). Fusion = repeating `--engine=`; the parent re-spawns `review.js` once per slot (children re-parse argv independently).

## Safety vs functional flags

`SAFETY_FLAGS[engine]` = read-only / sandbox / plan flags, **stripped by `--unrestricted`** (e.g. codex `-s read-only`, claude `--permission-mode plan`). Everything else in a `case` block is **functional** and must survive `--unrestricted`: `--print` / `exec` / `run`, plus the non-interactive / trust flags — codex `--skip-git-repo-check`, gemini `--skip-trust`, opencode `--dir <cwd>`, cmd `--skip-onboarding`, agent `--trust`.

`SAFETY_FLAGS` entries must stay simple string-literal lines (no spreads, no computed values) — `test/safety.test.js` parses them by regex (see `test/CLAUDE.md`).

## Exit codes

`0` success · `3` clean exit but no usable output (0 bytes, or — when wrapped — missing the `<<<SECOND_OPINION_START>>>` envelope) · `124` timeout · otherwise the engine CLI's own code.

## Output contract (stdout tail)

After the engine exits, review.js prints (in order, when applicable):

1. `REVIEW COMPLETE — read with Read tool: <log> …` — when a log file is in use.
2. `ANSWER FILE: <log>.answer.md` — when answer extraction succeeded (see below).
3. The extracted payload itself — only with `--print-answer`.
4. `SECOND_OPINION_RESULT: {…}` — **always the last stdout line**, one-line JSON.

**Answer extraction** — when a log FILE is in use (auto-log in non-TTY, or `--log=<path>`) AND `--no-wrap` was not passed, review.js reads the just-closed log back from disk and extracts the LAST complete envelope pair **with a non-empty trimmed payload** (END markers walked backwards, each bound to the LAST START before it and after the previous END — a stray START echoed mid-reasoning is skipped, a blank trailing pair falls back to the previous real one, and a falsy-but-real payload like `"0"` counts) via tolerant matchers (`/<{2,}\s*SECOND_OPINION_START\s*>{2,}/`, END equivalent — same 2+-bracket tolerance as the envelope-presence check, on both ends). The trimmed payload is written verbatim to `<log>.answer.md`. No payload this run → any stale `<log>.answer.md` from a previous run on a reused `--log` path is **removed** (file existence always reflects the current run; exit-3 behavior unchanged). `--log=-` disables it (no log file → nothing to extract).

**`--print-answer`** (bare flag, in the own-flags registry / leaked-flag guard) — on successful extraction also echoes the payload to stdout, before the final result line. The echo uses the in-memory payload, so it works even if the `.answer.md` write failed.

**`SECOND_OPINION_RESULT` JSON** — single engine: `{engine, model (null if none), exit, log (null with --log=-), answer (path or null), timeout (bool)}`. Fusion parent: `{"fusion":true,"slots":[{…same keys per slot}]}`. Children run stdio-silenced, so the parent derives each slot's `answer` from the known slot log path (`<slotLog>.answer.md` when present on disk) and `exit`/`timeout` from the captured child exit code — it does not parse child stdout.

The tail lines (2–4 above, and the fusion result line) are written **synchronously** (`writeStdoutSync`: looped `fs.writeSync(1)` with EAGAIN retry, behind a one-shot flush barrier for earlier async stdout) — async `process.stdout` writes queued behind a multi-MB payload echo are discarded by `process.exit()`, truncating the payload and dropping the result line. The result line is also emitted on **launch failures**: preflight missing binary (exit 127, `log:null`), spawn error / E2BIG (exit 1), and fusion-dir-creation failure (fusion shape, dead slots). Only usage errors (bad flags/arguments, unknown engine) exit before it.

## Secret guard

`env-guard.js` keeps `.env`-style files out of prompts: refuse `--file=.env`, skip untracked `.env`, redact `.env` diff hunks (incl. git's c-quoted headers for non-ASCII paths), and pathspec-exclude in `--no-embed`. `--include-secrets` opts out. Matcher: `.env` / `.env.*` / `*.env`, exempting `*example*` / `*sample*` / `*template*`.

Adding an engine: see `skills/CLAUDE.md` (canonical checklist in `skills/second-opinion/SKILL.md`).
