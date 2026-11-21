'use strict';
// Build-time includes for the numbered flow sources (R5).
//
// A numbered source (`NN Name.js` / `.init.js` / `.html`) may contain lines of the form
//     // #include lib/heat-pump/heating-controller.js
// `expand()` replaces each such line with the exact text of that file (LF line endings, no trailing blank lines),
// so the code embedded in flows.json is the same as if it had been written inline. Node-RED never sees `lib/`:
// the GX runs flows.json only, and the deploy is unchanged. Includes do not nest.
const fs = require('fs');
const path = require('path');

const INCLUDE_RE = /^[ \t]*\/\/ #include (lib\/[A-Za-z0-9_./-]+\.js)[ \t]*$/;

function readLib(root, rel) {
    if (rel.includes('..')) throw new Error('#include path must stay inside lib/: ' + rel);
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) throw new Error('#include file not found: ' + rel);
    // leading `//!` lines are the lib file's own header (what it is, where it is included); they are not embedded
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n')
        .replace(/^(?:\/\/![^\n]*\n)+/, '').replace(/\s+$/, '');
    if (text.split('\n').some((line) => INCLUDE_RE.test(line))) throw new Error('#include does not nest: ' + rel);
    return text;
}

// text: a source with LF or CRLF line endings; returns it with every include line expanded (line endings kept LF).
function expand(text, root) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    if (!lines.some((line) => INCLUDE_RE.test(line))) return String(text);
    return lines.map((line) => {
        const m = line.match(INCLUDE_RE);
        return m ? readLib(root, m[1]) : line;
    }).join('\n');
}

// the lib files a source includes (relative paths)
function includesOf(text) {
    return String(text).replace(/\r\n/g, '\n').split('\n').map((l) => l.match(INCLUDE_RE)).filter(Boolean).map((m) => m[1]);
}

module.exports = { expand, includesOf, INCLUDE_RE };
