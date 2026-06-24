#!/usr/bin/env bash
# second-opinion-skill — unified multi-harness installer.
#
# One line:
#   curl -fsSL https://raw.githubusercontent.com/srwbsw/second-opinion-skill/main/install.sh | bash
#
# Auto-detects which agent CLIs are present and installs into each:
#   - Claude Code (claude) — marketplace plugin
#   - Codex CLI   (codex)  — marketplace plugin
#   - Cursor CLI  (agent)  — rule file in ~/.cursor/rules/
#   - opencode    (opencode) — command file in ~/.config/opencode/command/
# It also symlinks the runner (review.js, list.js) onto PATH so every harness
# resolves it via `command -v` — including Cursor/opencode, which have no
# plugin cache of their own.
#
# Safe to re-run (idempotent). Flags:
#   --only=claude,codex,cursor,opencode   install only these (comma-separated)
#   --ref=<branch|tag>                    git ref for clone + marketplace (default: main)
#   --uninstall                           remove everything this script installs
#   --help

set -euo pipefail

REPO_SLUG="srwbsw/second-opinion-skill"
PLUGIN="second-opinion-skill"
GIT_URL="https://github.com/${REPO_SLUG}.git"
CLONE_HOME="${HOME}/.second-opinion-skill"
CURSOR_RULES="${HOME}/.cursor/rules"
OPENCODE_CMD="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/command"

ONLY=""
REF="main"
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY="${arg#*=}" ;;
    --ref=*) REF="${arg#*=}" ;;
    --uninstall) UNINSTALL=1 ;;
    --help | -h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

want() {
  # want <harness> — true if no --only filter, or harness is in the filter.
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── Locate a PATH dir we can symlink the runner into ───────────────────────
pick_bindir() {
  for d in "$HOME/.local/bin" "$HOME/bin"; do
    case ":$PATH:" in *":$d:"*) echo "$d"; return 0 ;; esac
  done
  # Not on PATH anywhere obvious — fall back to ~/.local/bin and warn later.
  echo "$HOME/.local/bin"
}
BINDIR="$(pick_bindir)"

# ── Source dir: the checkout we are run from, else a fresh clone ───────────
script_src() {
  local self
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$self/bin/review.js" ]; then echo "$self"; return 0; fi
  return 1
}

# ─────────────────────────────── UNINSTALL ────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  echo "Uninstalling second-opinion-skill…"
  rm -f "$BINDIR/review.js" "$BINDIR/list.js"
  rm -f "$CURSOR_RULES/second-opinion.mdc"
  rm -f "$OPENCODE_CMD/second-opinion.md"
  if want claude && have claude; then
    claude plugin uninstall "$PLUGIN" 2>/dev/null || true
  fi
  if want codex && have codex; then
    codex plugin remove "${PLUGIN}@${PLUGIN}" 2>/dev/null || true
  fi
  echo "Done. (Marketplace entries left in place; remove with each CLI's 'marketplace remove' if desired.)"
  exit 0
fi

# ─────────────────────────────── INSTALL ──────────────────────────────────
if SRC="$(script_src)"; then
  echo "Using local checkout: $SRC"
else
  echo "Cloning ${GIT_URL} (ref ${REF}) → ${CLONE_HOME}"
  if [ -d "$CLONE_HOME/.git" ]; then
    git -C "$CLONE_HOME" fetch --depth 1 origin "$REF" >/dev/null 2>&1
    git -C "$CLONE_HOME" checkout -q FETCH_HEAD
  else
    rm -rf "$CLONE_HOME"
    git clone --depth 1 --branch "$REF" "$GIT_URL" "$CLONE_HOME" >/dev/null 2>&1
  fi
  SRC="$CLONE_HOME"
fi

installed=()
skipped=()

# 1) Runner on PATH — the universal discovery path for every harness.
mkdir -p "$BINDIR"
ln -sf "$SRC/bin/review.js" "$BINDIR/review.js"
ln -sf "$SRC/bin/list.js" "$BINDIR/list.js"
chmod +x "$SRC/bin/review.js" "$SRC/bin/list.js" 2>/dev/null || true
installed+=("runner → $BINDIR/{review,list}.js")
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "Warning: $BINDIR is not on your PATH. Add it, or set SECOND_OPINION_REVIEW=$SRC/bin/review.js" >&2 ;;
esac

# 2) Claude Code
if want claude; then
  if have claude; then
    claude plugin marketplace add "$REPO_SLUG" 2>/dev/null || true
    if claude plugin install "${PLUGIN}@${PLUGIN}" 2>/dev/null; then
      installed+=("claude (plugin)")
    else
      installed+=("claude (plugin already present or refresh needed)")
    fi
  else
    skipped+=("claude (CLI not found)")
  fi
fi

# 3) Codex CLI
if want codex; then
  if have codex; then
    codex plugin marketplace add "$REPO_SLUG" 2>/dev/null || true
    if codex plugin add "${PLUGIN}@${PLUGIN}" 2>/dev/null; then
      installed+=("codex (plugin)")
    else
      installed+=("codex (plugin already present or refresh needed)")
    fi
  else
    skipped+=("codex (CLI not found)")
  fi
fi

# 4) Cursor CLI — rule file
if want cursor; then
  if have agent || have cursor-agent; then
    mkdir -p "$CURSOR_RULES"
    cp "$SRC/.cursor/rules/second-opinion.mdc" "$CURSOR_RULES/second-opinion.mdc"
    installed+=("cursor → $CURSOR_RULES/second-opinion.mdc")
  else
    skipped+=("cursor (agent CLI not found)")
  fi
fi

# 5) opencode — command file
if want opencode; then
  if have opencode; then
    mkdir -p "$OPENCODE_CMD"
    cp "$SRC/.opencode/command/second-opinion.md" "$OPENCODE_CMD/second-opinion.md"
    installed+=("opencode → $OPENCODE_CMD/second-opinion.md")
  else
    skipped+=("opencode (CLI not found)")
  fi
fi

echo
echo "── second-opinion-skill install summary ──"
for i in "${installed[@]}"; do echo "  ✓ $i"; done
for s in "${skipped[@]:-}"; do [ -n "$s" ] && echo "  – skipped: $s"; done
echo
echo "Runner resolves via 'command -v review.js'. In Claude Code / Codex the"
echo "review skills load as plugins; in Cursor ask for a 'second opinion', in"
echo "opencode run '/second-opinion'."
