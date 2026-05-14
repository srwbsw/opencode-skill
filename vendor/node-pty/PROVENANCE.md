# Vendored node-pty

Source: https://www.npmjs.com/package/node-pty
Version: 1.1.0 (pinned)
License: MIT (Microsoft Corporation) — see https://github.com/microsoft/node-pty/blob/main/LICENSE

## What is here

- `lib/` — JS sources (test files and sourcemaps stripped to save space)
- `prebuilds/darwin-arm64/` — Apple Silicon native binding + spawn-helper
- `prebuilds/darwin-x64/` — Intel Mac native binding + spawn-helper
- `package.json` — original manifest (untouched, used by Node's module resolver)

Linux and Windows users fall through to the `script(1)` cmd path in
`bin/review.js` (Linux util-linux `script` streams without a PTY-stdin
requirement; Windows has no PTY wrapper and falls back to direct spawn).

## Why vendored?

This repo distributes as a Claude Code / Codex plugin via clone-based
marketplace install. No `npm install` runs on the user's machine, so
declaring node-pty as a normal dependency would not actually install it.
Vendoring the prebuilds keeps installation a single `git clone` while
still giving users real PTY streaming on macOS.

## How to refresh

When upgrading node-pty:

```bash
# 1. Install the target version locally
pnpm add -D node-pty@<version>

# 2. Replace the vendored copies
SRC=node_modules/.pnpm/node-pty@<version>/node_modules/node-pty
DEST=vendor/node-pty
rm -rf $DEST/lib $DEST/prebuilds $DEST/package.json
cp -r $SRC/lib $DEST/lib
cp $SRC/package.json $DEST/package.json
cp -r $SRC/prebuilds/darwin-arm64 $DEST/prebuilds/darwin-arm64
cp -r $SRC/prebuilds/darwin-x64 $DEST/prebuilds/darwin-x64
find $DEST/lib \( -name "*.map" -o -name "*.test.js" \) -exec rm {} +
chmod +x $DEST/prebuilds/*/spawn-helper

# 3. Remove the dev dep — vendored copy is the runtime source
pnpm remove -D node-pty

# 4. Smoke test
node -e "const p=require('./vendor/node-pty'); p.spawn('/bin/echo',['ok'],{name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env}).onData(d=>process.stdout.write(d))"
```
