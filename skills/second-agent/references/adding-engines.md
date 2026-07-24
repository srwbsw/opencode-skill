# Adding new engines

1. Add a trigger phrase for the engine to `second-agent/SKILL.md`'s frontmatter description (there's no separate per-engine skill any more — `second-agent` is the only skill, so this is what makes it match requests naming the new engine).
2. Add an entry to the `SAFETY_FLAGS` map in `bin/lib/engines.js` with the engine's read-only/sandbox flags, and add a `case` block in `buildEngineCmd()` that calls `safetyFor('<engine>')` plus any required functional flags (e.g. `--print`, `-p`, `exec`, `run`). Both `review.js` and `agent.js` share this module, so this one edit wires up review AND task mode for the new engine — no separate agent.js-side change needed.
3. If the engine needs provider/model discovery, add a `case` block to `bin/list.js`.
4. Add a row to the engine table and per-engine model rules in `second-agent/SKILL.md` ("Choose an engine and model").
5. Add the engine's required safety flags to `requiredSafetyFlags` and any functional flags to `requiredFunctionalFlags` in `test/safety.test.js`, then run `pnpm run lint` to verify.
6. **Host parity** (see `skills/AGENTS.md`): add the matching host integration so the engine is also installable — a detection+install block in `install.sh` and its `HOSTS=` entry, plus a native adapter (reuse `skills/`, the opencode command, or the gemini TOML where possible). `test/host-parity.test.js` fails until host set == engine set, or the engine is recorded as an `EXCEPTIONS` entry there.
