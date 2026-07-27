#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_name="second-agent-skill"
old_plugin_name="second-opinion-skill" # pre-migration slug — only used to retire the old local registration
marketplace_file="${HOME}/.agents/plugins/marketplace.json"
# Codex resolves a marketplace entry's `source.path` ("./plugins/<name>")
# relative to the marketplace ROOT — the directory that *contains* `.agents/`,
# NOT the dir holding marketplace.json. For the personal marketplace
# (~/.agents/plugins/marketplace.json) that root is $HOME, so the staged copy
# must live at $HOME/plugins/<name>. (Verified via `codex plugin list`.)
plugin_home="${HOME}/plugins/${plugin_name}"

if ! command -v codex >/dev/null 2>&1; then
  echo "Error: codex CLI is not installed or not on PATH." >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "Error: rsync is required to stage the local Codex plugin copy." >&2
  exit 1
fi

mkdir -p "$(dirname "$plugin_home")" "$(dirname "$marketplace_file")"

if [[ -L "$plugin_home" ]]; then
  echo "Error: ${plugin_home} is a symlink. Refusing to replace it." >&2
  echo "Remove the symlink manually, then rerun this script." >&2
  exit 1
fi

if [[ -e "$plugin_home" && ! -L "$plugin_home" ]]; then
  if [[ ! -f "$plugin_home/.codex-plugin/plugin.json" ]]; then
    echo "Error: ${plugin_home} exists but does not look like a Codex plugin." >&2
    echo "Move it aside or set plugin_home manually before rerunning." >&2
    exit 1
  fi
fi

plugin_tmp="${plugin_home}.tmp.$$"
rm -rf "$plugin_tmp"
mkdir -p "$plugin_tmp"
cleanup_tmp() {
  rm -rf "$plugin_tmp"
}
trap cleanup_tmp EXIT

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.agents/plugins/marketplace.json' \
  "$repo_root"/ "$plugin_tmp"/

node -e '
const fs = require("fs");
const path = require("path");

try {
  const manifestPath = path.join(process.argv[1], ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const base = String(manifest.version || "0.0.0").split("+")[0];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  manifest.version = `${base}+codex.local-${stamp}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
} catch (err) {
  console.error(`Error: could not update staged Codex plugin manifest: ${err.message}`);
  process.exit(1);
}
' "$plugin_tmp"

# Replace the install non-destructively: move any existing copy aside first so a
# failed mv can be rolled back instead of wiping the previous working install.
plugin_backup=""
if [[ -e "$plugin_home" ]]; then
  plugin_backup="${plugin_home}.bak.$$"
  rm -rf "$plugin_backup"
  mv "$plugin_home" "$plugin_backup"
fi
if ! mv "$plugin_tmp" "$plugin_home"; then
  echo "Error: failed to install staged copy to ${plugin_home}." >&2
  if [[ -n "$plugin_backup" ]]; then
    mv "$plugin_backup" "$plugin_home"
  fi
  exit 1
fi
if [[ -n "$plugin_backup" ]]; then
  rm -rf "$plugin_backup"
fi
trap - EXIT

marketplace_name="$(
  node -e '
const fs = require("fs");
const path = require("path");

const marketplaceFile = process.argv[1];
const pluginName = process.argv[2];
const pluginEntry = {
  name: pluginName,
  source: { source: "local", path: `./plugins/${pluginName}` },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
};

let data;
try {
  if (fs.existsSync(marketplaceFile)) {
    data = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("root must be a JSON object");
    }
    if (typeof data.name !== "string" || data.name.trim() === "") {
      throw new Error("root name must be a non-empty string");
    }
    if (!Array.isArray(data.plugins)) {
      throw new Error("root plugins must be an array; refusing to rewrite an unknown marketplace shape");
    }
  } else {
    data = {
      name: "personal",
      interface: { displayName: "Personal" },
      plugins: [],
    };
  }

  if (!data.interface || typeof data.interface !== "object" || Array.isArray(data.interface)) {
    data.interface = {};
  }
  if (!data.interface.displayName) data.interface.displayName = "Personal";

  const existingIndex = data.plugins.findIndex((plugin) => plugin.name === pluginName);
  if (existingIndex >= 0) {
    data.plugins[existingIndex] = pluginEntry;
  } else {
    data.plugins.push(pluginEntry);
  }

  fs.writeFileSync(marketplaceFile, JSON.stringify(data, null, 2) + "\n");
  process.stdout.write(data.name);
} catch (err) {
  console.error(`Error: could not update ${marketplaceFile}: ${err.message}`);
  process.exit(1);
}
' "$marketplace_file" "$plugin_name"
)"

if [[ -z "$marketplace_name" ]]; then
  echo "Error: marketplace name is empty; refusing to run codex plugin add." >&2
  exit 1
fi

echo "Staged cache-busted plugin copy at: $plugin_home"
echo "Using marketplace file: $marketplace_file"
echo "Installing ${plugin_name} from marketplace: $marketplace_name"
codex plugin add "${plugin_name}@${marketplace_name}"

# New install succeeded (set -e would have exited above otherwise) — safe to
# retire any pre-migration local registration under the old plugin name, so
# rerunning this script after the rename migrates in place instead of leaving
# both namespaced copies installed side by side.
if [[ "$plugin_name" != "$old_plugin_name" ]]; then
  old_plugin_home="${HOME}/plugins/${old_plugin_name}"
  if [[ -d "$old_plugin_home" && ! -L "$old_plugin_home" && -f "$old_plugin_home/.codex-plugin/plugin.json" ]]; then
    rm -rf "$old_plugin_home"
    echo "Removed pre-migration staged copy at: $old_plugin_home"
  fi
  codex plugin remove "${old_plugin_name}@${marketplace_name}" 2>/dev/null || true
  node -e '
const fs = require("fs");
const marketplaceFile = process.argv[1];
const oldPluginName = process.argv[2];
try {
  const data = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
  if (Array.isArray(data.plugins)) {
    const before = data.plugins.length;
    data.plugins = data.plugins.filter((plugin) => plugin.name !== oldPluginName);
    if (data.plugins.length !== before) {
      fs.writeFileSync(marketplaceFile, JSON.stringify(data, null, 2) + "\n");
    }
  }
} catch (err) {
  console.error(`Warning: could not prune old marketplace entry: ${err.message}`);
}
' "$marketplace_file" "$old_plugin_name"
fi
