#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: codex CLI is not installed or not on PATH." >&2
  exit 1
fi

remote_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
if [[ -z "$remote_url" ]]; then
  echo "Error: no git origin remote found in $repo_root." >&2
  echo "Clone this repo from GitHub first, then rerun this script." >&2
  exit 1
fi

echo "Adding Codex marketplace from: $remote_url"
codex plugin marketplace add "$remote_url"

echo "Installing second-opinion-skill from the marketplace"
codex plugin add second-opinion-skill@second-opinion-skill

