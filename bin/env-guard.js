'use strict';

// Detect files that likely hold REAL environment secrets, so review.js never
// embeds their contents into an engine prompt (and skips/redacts them when it
// assembles a diff). This is a system-level guard: it acts on what review.js
// feeds the engine, independent of any prompt instruction.
//
// Matched (case-insensitive, on the basename only):
//   .env            — the canonical secret file
//   .env.*          — .env.local, .env.production, ...
//   *.env           — prod.env, local.env, ...
//
// Exempt (conventionally safe to share, never real secrets):
//   any name containing "example", "sample", or "template"
//   (e.g. .env.example, example.env, .env.template, env.sample)
//
// Out of scope on purpose: .envrc (direnv) and other non-".env" names — the
// patterns above mirror the documented contract; broaden deliberately if
// needed. The exemption keywords (example/sample/template) are an explicit,
// conventional opt-out: a live secret deliberately named to contain one of
// them would slip through, which is acceptable for a "just in case" guard.
function isLikelyEnvSecret(filePath) {
  if (!filePath) return false;
  // Basename only — directory components must not influence the decision.
  const base = String(filePath).split(/[\\/]/).pop().toLowerCase();
  const looksEnv =
    base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
  if (!looksEnv) return false;
  if (/example|sample|template/.test(base)) return false;
  return true;
}

module.exports = { isLikelyEnvSecret };
