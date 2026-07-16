'use strict';

// The <<<SECOND_OPINION_START>>>…<<<SECOND_OPINION_END>>> structured-output
// envelope: the instruction text that asks an engine to use it, a streaming
// presence watcher (cheap "did we see it at all" check), and the post-hoc
// line-anchored extractor that pulls the real answer back out of a finished
// log. Markers stay literally SECOND_OPINION_* for backward compatibility
// even as the product around them is renamed — see root AGENTS.md.

const fs = require('fs');

// Tokens are joined from fragments so this module's own instruction text
// doesn't contain a clean copyable marker pair (a literal example block gets
// echoed into the log by some engines, and a first-match extractor would
// then grab the example body instead of the real answer).
const SECOND_OPINION_START = '<<<' + 'SECOND_OPINION_START' + '>>>';
const SECOND_OPINION_END = '<<<' + 'SECOND_OPINION_END' + '>>>';

// Structured-output envelope instruction. Forces the engine to emit its real
// answer between stable sentinels, so callers can extract the payload from
// the log without scraping reasoning traces, tool-use noise, or
// model-specific scaffolding. Topic-neutral — works for review, Q&A,
// brainstorming, anything.
function buildEnvelopeInstruction() {
  return (
    '\n\n---\n' +
    `OUTPUT FORMAT (required): put your full final answer between two marker lines — a line reading exactly ${SECOND_OPINION_START} immediately before it, and a line reading exactly ${SECOND_OPINION_END} immediately after it. ` +
    'Emit each marker once, alone on its own line. Reasoning or scratch work before the START marker is fine and is ignored; do not nest or paraphrase the markers.'
  );
}

// Tolerant START-marker matcher: accept near-misses real engines emit, e.g.
// `<<<SECOND_OPINION_START>>` (two '>') from cmd, stray inner whitespace, or
// 2+ angle brackets either side. An over-strict exact match here discards a
// perfectly good review as "no output" (false exit 3).
const START_RE = /<{2,}\s*SECOND_OPINION_START\s*>{2,}/;
// Longest carry needed to catch a marker split across two chunks.
const ENV_CARRY = 48;

// Streaming presence watcher: cheap "did the START marker ever appear in the
// engine's stdout" check, fed one chunk at a time (a marker may straddle two
// chunks, hence the small rolling carry buffer). Used as the no-log-file
// fallback for the "was there a usable envelope" verdict — the authoritative
// check is extractLastAnswer() against the finished log.
function createEnvelopeWatcher() {
  let sawEnvelope = false;
  let carry = '';
  return {
    feed(chunk) {
      if (sawEnvelope) return;
      const s = carry + chunk.toString('utf8');
      if (START_RE.test(s)) sawEnvelope = true;
      carry = s.slice(-ENV_CARRY);
    },
    seen() {
      return sawEnvelope;
    },
  };
}

// Tolerant envelope-pair matchers for post-hoc answer extraction from the log.
// Like the streaming watcher's START_RE (envelope PRESENCE check) they accept
// 2+ angle brackets and stray inner whitespace so real engines' near-miss
// markers (cmd's `>>`, a both-sides `<<…>>`) still parse — but unlike it they
// are LINE-ANCHORED: a marker only counts alone on its own line (optional
// surrounding blanks; trailing \r for CRLF logs). The wrap instruction itself
// names both markers INLINE in a sentence, so an engine that echoes those
// instructions after its real answer would otherwise hand the backward walk a
// bogus trailing "pair" whose payload is the prose between the inline markers.
// The envelope contract requires each marker "alone on its own line", so
// anchoring rejects exactly (and only) marker mentions that can't be real.
const ANSWER_START_RE =
  /^[ \t]*<{2,}\s*SECOND_OPINION_START\s*>{2,}[ \t\r]*$/gm;
const ANSWER_END_RE = /^[ \t]*<{2,}\s*SECOND_OPINION_END\s*>{2,}[ \t\r]*$/gm;

// Extract the trimmed payload of the LAST complete START…END pair with a
// NON-EMPTY payload from `text`. Pairing walks END markers BACKWARDS, binding
// each END to the LAST START before it (bounded below by the previous END, so
// pairs never overlap), and returns the first non-empty trimmed payload found.
// Backward pairing is what makes each hostile shape resolve to the real
// answer: a stray START echoed mid-reasoning is skipped (the real pair's own
// START is the LAST one before its END), a double-emitted answer yields the
// final copy, and a blank trailing pair falls back to the previous real one.
// Returns null when no non-empty pair exists (empty output, missing envelope,
// END-only fragment, or only empty pairs). A falsy-but-real payload like '0'
// counts as an answer — callers must null-check, never truthiness-check.
function extractLastAnswer(text) {
  if (!text) return null;
  const starts = [];
  const ends = [];
  let m;
  ANSWER_START_RE.lastIndex = 0;
  while ((m = ANSWER_START_RE.exec(text)) !== null)
    starts.push({ start: m.index, end: m.index + m[0].length });
  ANSWER_END_RE.lastIndex = 0;
  while ((m = ANSWER_END_RE.exec(text)) !== null)
    ends.push({ start: m.index, end: m.index + m[0].length });
  for (let i = ends.length - 1; i >= 0; i -= 1) {
    // Non-overlap bound: this END's START must sit after the previous END
    // marker, so a stray END can never steal an earlier pair's payload.
    const lowerBound = i > 0 ? ends[i - 1].end : 0;
    let opener = null;
    for (let j = starts.length - 1; j >= 0; j -= 1) {
      const s = starts[j];
      if (s.start < lowerBound) break; // earlier STARTs are further back still
      if (s.end <= ends[i].start) {
        opener = s;
        break;
      }
    }
    if (opener === null) continue; // unpaired END — try the previous one
    const payload = text.slice(opener.end, ends[i].start).trim();
    if (payload !== '') return payload;
  }
  return null;
}

// Read back a just-closed log file, extract the LAST usable answer payload,
// and write it to `<logPath>.answer.md` (removing any stale file from a
// previous run on a reused --log path when there is no payload this run).
// Skipped (no read, no extraction) when `noWrap` is true — mirrors the CLI
// contract that --no-wrap disables answer extraction entirely.
//
// Returns { answerPath, answerPayload, writeError }: answerPath is the
// written file's path (or null if there was nothing to write, or the write
// itself failed), answerPayload is the extracted text (or null), and
// writeError carries the write failure (if any) so the caller can report it
// in its own voice rather than this module hardcoding one CLI's prefix.
function writeAnswerFile(logPath, { noWrap }) {
  if (!logPath) return { answerPath: null, answerPayload: null };
  const candidate = `${logPath}.answer.md`;
  let answerPayload = null;
  if (!noWrap) {
    let logText = '';
    try {
      logText = fs.readFileSync(logPath, 'utf8');
    } catch {
      /* unreadable (e.g. log open failed earlier) — treat as no answer */
    }
    answerPayload = extractLastAnswer(logText);
  }
  if (answerPayload !== null) {
    try {
      // Exactly the trimmed payload — no added framing.
      fs.writeFileSync(candidate, answerPayload);
      return { answerPath: candidate, answerPayload };
    } catch (err) {
      return { answerPath: null, answerPayload, writeError: err };
    }
  }
  try {
    fs.rmSync(candidate, { force: true });
  } catch {
    /* best-effort stale-file cleanup */
  }
  return { answerPath: null, answerPayload: null };
}

module.exports = {
  SECOND_OPINION_START,
  SECOND_OPINION_END,
  buildEnvelopeInstruction,
  START_RE,
  createEnvelopeWatcher,
  ANSWER_START_RE,
  ANSWER_END_RE,
  extractLastAnswer,
  writeAnswerFile,
};
