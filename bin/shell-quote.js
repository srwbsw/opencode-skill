'use strict';

// POSIX single-quote shell quoting: any byte except `'` is literal inside
// single quotes. Embed `'` by closing the quote, inserting `\'`, reopening.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { shellQuote };
