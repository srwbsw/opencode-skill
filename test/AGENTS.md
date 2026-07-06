# test/ — suites & fixtures

Tests are plain Node scripts (no framework). Each prints `PASS/FAIL [name]` and exits non-zero on failure. Run one directly: `node test/spawn.test.js`. All seven run via `pnpm run lint`.

Suites: `safety` (flag contract), `shell-quote`, `env-guard` (secret matcher), `spawn` (review.js integration), `answer` (answer-file extraction / `SECOND_OPINION_RESULT` JSON), `locate` (canonical runner-discovery snippet drift), `host-parity` (host set == engine set). New test files must be added to the `lint` script in `package.json`.

## safety.test.js

Parses `bin/review.js`'s `SAFETY_FLAGS` map **by regex**, so those entries must stay simple string literals (no spreads/computed values). It checks each engine's required safety flags AND functional flags — when you add a new functional flag (e.g. `--trust`, `--skip-trust`), add it to `requiredFunctionalFlags` or the test won't guard it.

## Fixtures (test/fixtures/<engine>)

Fake engine binaries put on `PATH` during tests, controlled by env vars:

- `FAKE_BEHAVIOR` — `ok` / `silent N` / `hang` / `probe N` / `empty` / `noenvelope` / `echo-stdin` / `model-unavailable` (codex fixture: fail when `-m`/`--model` is present, succeed otherwise) / `malformed-marker` (codex fixture: open marker with only two `>`, e.g. `<<<SECOND_OPINION_START>>`, near-miss on the open side only) / `malformed` (codex fixture: BOTH open and close markers use only two `<`/`>` each — exercises tolerant-regex answer extraction on the close marker too) / `double` (codex fixture: emits two complete envelope pairs with different payloads, modeling an engine that echoes/duplicates output — answer extraction must keep the LAST pair) / `empty-final-pair` (codex fixture: real pair then a complete-but-EMPTY pair — extraction must fall back to the last NON-EMPTY pair) / `stray-start` (codex fixture: bare START marker echoed mid-reasoning, then the real pair — backward pairing must return the clean payload only) / `echo-instructions` (codex fixture: real own-line pair, then an instruction sentence with both markers INLINE — line-anchored extraction must keep the real payload) / `inline-only` (codex fixture: ONLY the inline instruction sentence, no own-line pair — no extractable answer, exit 3 when a log file is in use) / `zero-payload` (codex fixture: payload is the falsy string `0` — must still count as an answer) / `big N` (codex fixture: ~N MB payload ending in `BIG_PAYLOAD_END_MARKER` — exercises review.js's synchronous stdout flush of the `--print-answer` echo + result line)
- `FAKE_ARGV_FILE` — fixture dumps its argv here, so tests assert which flags review.js forwarded
- `FAKE_PROBE_FILE` — START/END timestamps for concurrency (parallel vs serial) tests

A compliant fixture **must wrap its output in `<<<SECOND_OPINION_START>>> … <<<SECOND_OPINION_END>>>`** — otherwise review.js treats it as no-usable-output and exits 3, failing unrelated tests. `chmod +x` new fixtures.

Caveat: the argv dump is newline-joined and the helper re-splits on `\n`, so a multi-line prompt argument spreads across array entries — rejoin with `argv.join('\n')` for content assertions (not just `argv[last]`).
