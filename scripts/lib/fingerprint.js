'use strict';

const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// The staleness fingerprint. This must stay byte-for-byte equivalent to the
// definition every skill compares against — line count by splitting on
// \r\n | \r | \n, and sha256 over the raw file content. Computing it any other
// way (say, counting newline characters, or hashing normalized text) makes
// every comparison meaningless rather than merely different.
// ---------------------------------------------------------------------------

function countLines(content) {
  return content.split(/\r\n|\r|\n/).length;
}

function ofContent(content) {
  return {
    line_count: countLines(content),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function ofFile(filePath) {
  return ofContent(fs.readFileSync(filePath, 'utf8'));
}

function equal(a, b) {
  if (!a || !b) return false;
  return a.line_count === b.line_count && a.sha256 === b.sha256;
}

module.exports = { countLines, ofContent, ofFile, equal };
