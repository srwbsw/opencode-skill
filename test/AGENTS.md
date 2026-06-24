# test/ — suites & fixtures

Tests are plain Node scripts (no framework). Each prints `PASS/FAIL [name]` and exits non-zero on failure. Run one directly: `node test/spawn.test.js`. All six run via `pnpm run lint`.

Suites: `safety` (flag contract), `shell-quote`, `env-guard` (secret matcher), `spawn` (review.js integration), `locate` (canonical runner-discovery snippet drift), `host-parity` (host set == engine set). New test files must be added to the `lint` script in `package.json`.

## safety.test.js

Parses `bin/review.js`'s `SAFETY_FLAGS` map **by regex**, so those entries must stay simple string literals (no spreads/computed values). It checks each engine's required safety flags AND functional flags — when you add a new functional flag (e.g. `--trust`, `--skip-trust`), add it to `requiredFunctionalFlags` or the test won't guard it.

## Fixtures (test/fixtures/<engine>)

Fake engine binaries put on `PATH` during tests, controlled by env vars:

- `FAKE_BEHAVIOR` — `ok` / `silent N` / `hang` / `probe N` / `empty` / `noenvelope` / `echo-stdin` / `model-unavailable` (codex fixture: fail when `-m`/`--model` is present, succeed otherwise)
- `FAKE_ARGV_FILE` — fixture dumps its argv here, so tests assert which flags review.js forwarded
- `FAKE_PROBE_FILE` — START/END timestamps for concurrency (parallel vs serial) tests

A compliant fixture **must wrap its output in `<<<SECOND_OPINION_START>>> … <<<SECOND_OPINION_END>>>`** — otherwise review.js treats it as no-usable-output and exits 3, failing unrelated tests. `chmod +x` new fixtures.

Caveat: the argv dump is newline-joined and the helper re-splits on `\n`, so a multi-line prompt argument spreads across array entries — rejoin with `argv.join('\n')` for content assertions (not just `argv[last]`).
