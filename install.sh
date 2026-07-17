#!/usr/bin/env bash
# second-agent (second-opinion-skill) — unified multi-harness installer.
#
# One line:
#   curl -fsSL https://raw.githubusercontent.com/srwbsw/second-agent-skill/main/install.sh | bash
#
# Auto-detects which agent CLIs are present and installs into each. The set of
# supported HOST harnesses equals the set of supported ENGINES (see the
# "Host parity" invariant in skills/AGENTS.md) — every engine you can get a
# second opinion FROM or delegate a task TO is also a harness you can install
# INTO:
#
#   claude   codex   cursor(agent)   opencode   gemini
#   qwen     copilot agy             kilo       cmd
#
# It also symlinks the runners (review.js, agent.js, list.js) onto PATH so
# every harness resolves them via `command -v` — including the ones with no
# plugin cache.
#
# Safe to re-run (idempotent). Flags:
#   --only=claude,codex,cursor,opencode,gemini,qwen,copilot,agy,kilo,cmd
#   --ref=<branch|tag>   git ref for the clone (default: main). Plugin-manager
#                        installs (claude/codex/copilot/cmd) track their own
#                        marketplace default and ignore --ref.
#   --uninstall          remove everything this script installs
#   --help

set -euo pipefail

REPO_SLUG="srwbsw/second-agent-skill"
PLUGIN="second-opinion-skill"
GIT_URL="https://github.com/${REPO_SLUG}.git"
CLONE_HOME="${HOME}/.second-opinion-skill"
XDG="${XDG_CONFIG_HOME:-$HOME/.config}"

# Canonical host list — MUST equal SUPPORTED_ENGINES in bin/review.js
# (cursor == the `agent` engine). test/host-parity.test.js enforces this.
HOSTS="claude codex cursor opencode gemini qwen copilot agy kilo cmd"

ONLY=""
REF="main"
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY="${arg#*=}" ;;
    --ref=*) REF="${arg#*=}" ;;
    --uninstall) UNINSTALL=1 ;;
    --help | -h)
      # Prints every header comment line (from line 2 to the last contiguous
      # `#` line, i.e. right before `set -euo pipefail`) — no line range to
      # keep in sync when the header grows.
      awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

want() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}
have() { command -v "$1" >/dev/null 2>&1; }
have_cursor() { have agent || have cursor-agent; }

pick_bindir() {
  for d in "$HOME/.local/bin" "$HOME/bin"; do
    case ":$PATH:" in *":$d:"*) echo "$d"; return 0 ;; esac
  done
  echo "$HOME/.local/bin"
}
BINDIR="$(pick_bindir)"

script_src() {
  local self src
  # ${BASH_SOURCE[0]:-} guards `curl | bash`: bash reading a script off stdin
  # has an empty BASH_SOURCE array, and under `set -u` an unguarded index
  # into it is an unbound-variable error, not just an empty string. Empty ->
  # fall straight through to the clone path (no local checkout to use).
  src="${BASH_SOURCE[0]:-}"
  [ -n "$src" ] || return 1
  self="$(cd "$(dirname "$src")" && pwd)" || return 1
  if [ -f "$self/bin/review.js" ]; then echo "$self"; return 0; fi
  return 1
}

# ─────────────────────────────── UNINSTALL ────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  echo "Uninstalling second-agent (second-opinion-skill)…"
  rm -f "$BINDIR/review.js" "$BINDIR/list.js" "$BINDIR/agent.js"
  # BINDIR above is recomputed from the CURRENT PATH and can miss symlinks a
  # prior install created under a different PATH — also sweep both
  # well-known default bindirs directly, regardless of current PATH.
  rm -f "$HOME/.local/bin/review.js" "$HOME/.local/bin/list.js" "$HOME/.local/bin/agent.js"
  rm -f "$HOME/bin/review.js" "$HOME/bin/list.js" "$HOME/bin/agent.js"
  # Remove the managed clone, but only the exact directory this script itself
  # creates/manages — sanity-check it looks like our clone (contains
  # bin/review.js) before rm -rf, and never glob.
  if [ -d "$CLONE_HOME" ] && [ -f "$CLONE_HOME/bin/review.js" ]; then
    rm -rf "$CLONE_HOME"
  fi
  # Also drop the pre-rename second-opinion.* adapters older installs left behind.
  rm -f "$HOME/.cursor/rules/second-agent.mdc" "$HOME/.cursor/rules/second-opinion.mdc"
  rm -f "$XDG/opencode/command/second-agent.md" "$XDG/opencode/command/second-opinion.md"
  rm -f "$XDG/kilo/command/second-agent.md" "$XDG/kilo/command/second-opinion.md"
  rm -f "$HOME/.qwen/commands/second-agent.toml" "$HOME/.qwen/commands/second-opinion.toml"
  have claude && want claude && claude plugin uninstall "$PLUGIN" 2>/dev/null || true
  have codex && want codex && codex plugin remove "${PLUGIN}@${PLUGIN}" 2>/dev/null || true
  have copilot && want copilot && copilot plugin uninstall "$PLUGIN" 2>/dev/null || true
  have gemini && want gemini && gemini extensions uninstall "$PLUGIN" 2>/dev/null || true
  have agy && want agy && agy plugin uninstall "$PLUGIN" 2>/dev/null || true
  echo "Done. (cmd skills + any marketplace entries: remove manually if desired —"
  echo " e.g. 'cmd skills remove <name>', '<cli> plugin marketplace remove'.)"
  exit 0
fi

# ─────────────────────────────── INSTALL ──────────────────────────────────
if SRC="$(script_src)"; then
  echo "Using local checkout: $SRC"
else
  have git || { echo "Error: git is required to install via curl|bash." >&2; exit 1; }
  echo "Cloning ${GIT_URL} (ref ${REF}) → ${CLONE_HOME}"
  if [ -d "$CLONE_HOME/.git" ]; then
    git -C "$CLONE_HOME" fetch --depth 1 origin "$REF" >/dev/null 2>&1 &&
      git -C "$CLONE_HOME" checkout -q FETCH_HEAD ||
      { echo "Error: failed to update $CLONE_HOME to ref '$REF'." >&2; exit 1; }
  else
    rm -rf "$CLONE_HOME"
    git clone --depth 1 --branch "$REF" "$GIT_URL" "$CLONE_HOME" >/dev/null 2>&1 ||
      { echo "Error: git clone failed ($GIT_URL, ref '$REF'). Check network, git, and the ref." >&2; exit 1; }
  fi
  [ -f "$CLONE_HOME/bin/review.js" ] ||
    { echo "Error: clone at $CLONE_HOME is missing bin/review.js." >&2; exit 1; }
  SRC="$CLONE_HOME"
fi

installed=()
skipped=()
note() { installed+=("$1"); }
skip() { skipped+=("$1"); }

# 1) Runners on PATH — the universal discovery path for every harness.
mkdir -p "$BINDIR"
chmod +x "$SRC/bin/review.js" "$SRC/bin/list.js" "$SRC/bin/agent.js" 2>/dev/null || true
ln -sf "$SRC/bin/review.js" "$BINDIR/review.js"
ln -sf "$SRC/bin/list.js" "$BINDIR/list.js"
ln -sf "$SRC/bin/agent.js" "$BINDIR/agent.js"
note "runners → $BINDIR/{review,agent,list}.js"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "Warning: $BINDIR is not on PATH. Add it, or set SECOND_OPINION_REVIEW=$SRC/bin/review.js (and SECOND_OPINION_AGENT=$SRC/bin/agent.js for task delegation)" >&2 ;;
esac

# 2) Claude Code — marketplace plugin
if want claude; then
  if have claude; then
    claude plugin marketplace add "$REPO_SLUG" </dev/null 2>/dev/null || true
    if claude plugin install "${PLUGIN}@${PLUGIN}" </dev/null 2>/dev/null; then
      note "claude (plugin)"
    else
      skip "claude (install command failed)"
    fi
  else skip "claude (CLI not found)"; fi
fi

# 3) Codex CLI — marketplace plugin (source: url)
if want codex; then
  if have codex; then
    codex plugin marketplace add "$REPO_SLUG" </dev/null 2>/dev/null || true
    if codex plugin add "${PLUGIN}@${PLUGIN}" </dev/null 2>/dev/null; then
      note "codex (plugin)"
    else
      skip "codex (install command failed)"
    fi
  else skip "codex (CLI not found)"; fi
fi

# 4) Cursor CLI — rule file
if want cursor; then
  if have_cursor; then
    mkdir -p "$HOME/.cursor/rules"
    rm -f "$HOME/.cursor/rules/second-opinion.mdc" # pre-rename leftover
    cp "$SRC/.cursor/rules/second-agent.mdc" "$HOME/.cursor/rules/second-agent.mdc"
    note "cursor → ~/.cursor/rules/second-agent.mdc"
  else skip "cursor (agent CLI not found)"; fi
fi

# 5) opencode — command file
if want opencode; then
  if have opencode; then
    mkdir -p "$XDG/opencode/command"
    rm -f "$XDG/opencode/command/second-opinion.md" # pre-rename leftover
    cp "$SRC/.opencode/command/second-agent.md" "$XDG/opencode/command/second-agent.md"
    note "opencode → $XDG/opencode/command/second-agent.md"
  else skip "opencode (CLI not found)"; fi
fi

# 6) Gemini CLI — extension (gemini-extension.json + commands/*.toml).
# `link` (not `install`) points at the local source so updates reflect live;
# </dev/null because the consent prompt otherwise blocks on stdin.
if want gemini; then
  if have gemini; then
    if gemini extensions link "$SRC" --consent </dev/null 2>/dev/null \
      || gemini extensions update "$PLUGIN" </dev/null 2>/dev/null; then
      note "gemini (extension)"
    else
      skip "gemini (install command failed)"
    fi
  else skip "gemini (CLI not found)"; fi
fi

# 7) Qwen Code — gemini-cli fork; same TOML command at ~/.qwen/commands/
if want qwen; then
  if have qwen; then
    mkdir -p "$HOME/.qwen/commands"
    rm -f "$HOME/.qwen/commands/second-opinion.toml" # pre-rename leftover
    cp "$SRC/commands/second-agent.toml" "$HOME/.qwen/commands/second-agent.toml"
    note "qwen → ~/.qwen/commands/second-agent.toml"
  else skip "qwen (CLI not found)"; fi
fi

# 8) GitHub Copilot CLI — plugin (reuses skills/)
if want copilot; then
  if have copilot; then
    if copilot plugin install "$REPO_SLUG" </dev/null 2>/dev/null; then
      note "copilot (plugin)"
    else
      skip "copilot (install command failed)"
    fi
  else skip "copilot (CLI not found)"; fi
fi

# 9) Antigravity (agy) — plugin install from the local source (reuses skills/)
if want agy; then
  if have agy; then
    if agy plugin install "$SRC" </dev/null 2>/dev/null; then
      note "agy (plugin)"
    else
      skip "agy (install command failed)"
    fi
  else skip "agy (CLI not found)"; fi
fi

# 10) kilo — opencode-fork; reuses the opencode command at ~/.config/kilo/command/
if want kilo; then
  if have kilo; then
    mkdir -p "$XDG/kilo/command"
    rm -f "$XDG/kilo/command/second-opinion.md" # pre-rename leftover
    cp "$SRC/.opencode/command/second-agent.md" "$XDG/kilo/command/second-agent.md"
    note "kilo → $XDG/kilo/command/second-agent.md"
  else skip "kilo (CLI not found)"; fi
fi

# 11) Command Code (cmd) — installs skills/ from the GitHub repo
if want cmd; then
  if have cmd; then
    if cmd skills add "$REPO_SLUG" -g -f </dev/null 2>/dev/null; then
      note "cmd (skills)"
    else
      skip "cmd (install command failed)"
    fi
  else skip "cmd (CLI not found)"; fi
fi

echo
echo "── second-agent (second-opinion-skill) install summary ──"
for i in "${installed[@]}"; do echo "  ✓ $i"; done
for s in "${skipped[@]:-}"; do [ -n "$s" ] && echo "  – skipped: $s"; done
echo
echo "Runners resolve via 'command -v review.js' / 'command -v agent.js'."
echo "Trigger a review or task per harness:"
echo "  Claude/Codex: review/task skills load as plugins"
echo "  Cursor: ask for 'a second opinion …' or 'have Cursor fix/refactor …'"
echo "  opencode/kilo/gemini/qwen: run '/second-agent …'"
echo "  copilot/agy/cmd: invoke the second-agent skill"
