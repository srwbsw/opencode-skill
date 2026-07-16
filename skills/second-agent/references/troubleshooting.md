# Troubleshooting and anti-patterns

## Anti-patterns

Do not do any of these:

- `codex exec ...`, `gemini ...`, `claude ...`, etc. directly instead of `review.js`
- custom shell pipelines that try to reconstruct the prompt assembly outside `review.js`
- `zsh -lc` or `bash -lc` with the expectation that it changes sandbox permissions
- assuming an installed-plugin `"$REVIEW_SCRIPT"` invocation is host-level when the harness still sandboxes the parent command
- `--no-embed` on engines that cannot reliably run `git diff` in the current harness
- scraping `stdout` with `| tail` / `| head` instead of reading the ANSWER FILE or LOG FILE

## Sandbox and login-shell notes

- Engines spawned by `review.js` inherit the parent process context. If the parent agent command runs in a sandbox, the child engine runs in that sandbox too.
- `--unrestricted` only removes the engine-specific read-only / plan flags inside `review.js`; it does not change the outer harness permissions.
- Running `"$REVIEW_SCRIPT"` from an installed plugin does not make the run "system-level" if the parent harness is still sandboxed.
- A login shell (`zsh -lc` / `bash -lc`) may change `PATH` or shell init behavior, but it does not make the spawned engine run outside the parent sandbox.
- If an installed-plugin runner command fails only inside a sandboxed harness, diagnose the parent execution mode before changing `review.js`.
- Some engines require host-level prerequisites beyond plain `PATH` resolution, such as writable home-directory state, existing login/auth sessions, or network access.

## `--no-embed` caveats

`--no-embed` skips inlining the diff and instead tells the engine to run `git -C <cwd> diff <range>` itself — only useful for very large diffs (Tier C, see `prompts.md`), and only works when the chosen engine can actually shell out in the current environment:

```bash
"$REVIEW_SCRIPT" --engine=codex --cwd=. --diff=branch --no-embed "Review this diff for correctness and regressions."
```

Use this only when the engine can actually run `git` in the current harness — otherwise it will fail silently or produce a review of nothing.

## Launcher verification

To confirm an installed-plugin runner actually launches an engine (useful right after install, or when debugging a harness that seems to hang), send a trivial no-op prompt:

```bash
"$REVIEW_SCRIPT" --engine=cmd --engine=claude --cwd=. --timeout=120 --heartbeat=10 "Report whether you were launched successfully and what engine you are. Reply briefly."
```

Use this as a launcher check only when you control the parent execution mode. Inside a sandboxed harness, failure may still be caused by inherited sandbox restrictions rather than by `review.js`.

## Reading output when stdout doesn't stream it

Reviews routinely span 50–300 lines. When `review.js` runs from an agent harness (non-TTY stdout) it does not stream the engine output to stdout at all — engine bytes go to a log file, and stdout receives only a banner pointing at it, plus the `ANSWER FILE:` / `SECOND_OPINION_RESULT` lines once the engine finishes:

```
===========================================================
REVIEW IN PROGRESS — codex (gpt-5.5)
LOG FILE: /var/folders/.../second-opinion-codex-1731603012.log
Engine output is being written to the log file only.
After this command exits, use the Read tool on the LOG FILE path
above to retrieve the full review. Do not pipe to tail/head — the
engine output is not on stdout in this mode.
===========================================================
... (no engine output here) ...
REVIEW COMPLETE — read with Read tool: /var/folders/.../second-opinion-codex-1731603012.log (47213B, exit=0, 42.1s)
```

Workflow: run the command (no `| tail`, no `| head`), read the `ANSWER FILE:` path with the Read tool, and fall back to the `LOG FILE:` path if there is no `ANSWER FILE:` line. If you need a known log location, pass `--log=<path>` explicitly. To force the old tee-to-stdout behavior (e.g. for interactive `| less`), pass `--log=-`.

## How the ANSWER FILE is produced (internals)

`review.js` wraps the prompt with a structured-output envelope (`<<<SECOND_OPINION_START>>> ... <<<SECOND_OPINION_END>>>`) before handing it to the engine, then pulls the engine's answer out of that envelope into the ANSWER FILE itself — agents should not need to parse the envelope by hand. Internally it takes the **last non-empty** complete marker pair (some engines echo the format instructions, and some emit the answer twice), only accepts markers sitting alone on their own line (inline mentions in echoed prose are ignored), and tolerates malformed markers (e.g. `<<SECOND_OPINION_START>>` with only two brackets). Pass `--no-wrap` to disable the envelope entirely (e.g. when feeding output to another tool that does its own parsing) — note this also means no ANSWER FILE will be produced, since `review.js` has nothing to pull out anymore.

## Exit codes

`0` success. `124` timeout. `3` = the engine exited cleanly but produced no usable output (zero bytes — often a transient upstream provider outage, or a missing envelope when wrapped) — treat as "no answer," not success. In fusion mode, each slot's exit code is reported in that slot's entry in the result JSON's `slots` array (see `fusion.md`).

## Secrets handling (details)

`review.js` excludes `.env`-style secret files by default: it refuses `--file=.env`, skips untracked `.env` files from `--diff=unstaged`, and redacts `.env` hunks from diffs — matching `.env`, `.env.*`, `*.env`, and exempting filenames containing `example`, `sample`, or `template`. It also appends a prompt reminder not to open env files, for engines running `--no-embed` or otherwise self-reading in a sandbox. This is enforced in the runner itself, not just documentation. Pass `--include-secrets` only when the user explicitly wants a real `.env` file reviewed. `agent.js` applies the exact same guard.

## `agent.js` exit semantics (task delegation, not review)

`agent.js` layers its own quality verdict on top of the engine's own exit code, because "did it report something" and "did it actually change anything" are independent signals for a task run (unlike a review, where the only deliverable is prose).

- **`--unrestricted` gate**: `agent.js` refuses to run at all without `--unrestricted` — exit `1`, before any spawn or preflight side effect. There is no plan/read-only mode; passing the flag is a deliberate acknowledgment that the engine may edit files and run commands in `--cwd`.
- **`NO REPORT` warning (not a failure)**: if the engine made real changes on disk (a dirty `git status --porcelain`, or `HEAD` itself moved — e.g. the engine committed its own work) but printed no extractable envelope, `agent.js` still exits `0` and prints a `NO REPORT: engine completed with changes but no envelope` warning to stderr — the changes ARE the deliverable; a missing prose report doesn't fail the run.
- **Exit `3`**: reserved for a clean engine exit with genuinely nothing to show — NEITHER a usable envelope/answer NOR any changes on disk (porcelain unchanged AND `HEAD` unchanged). Treat it exactly like `review.js`'s exit `3`: no-answer, not success.
- **`changes` in `SECOND_AGENT_RESULT`**: `{"headBefore","headAfter","files":[{"path","state"}...]}` (`state`: `added`/`modified`/`deleted`/`renamed`), captured via `git status --porcelain` + `rev-parse HEAD` before/after the engine runs, or `null` on a non-git `--cwd`. This is the ground truth for "what happened" — read it, and the `CHANGED FILES:` stdout block, alongside (or instead of) the prose report.
