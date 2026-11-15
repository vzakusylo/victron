#!/usr/bin/env node
// Same snapshot as tools/gx/live-snapshot.js, but read from a flows.json file instead of the Node-RED admin API.
// Usage: node tools/test-gx/snapshot-file.js path\to\flows.json > backup.b64
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { snapshot } = require('../gx/live-snapshot.js');

const file = process.argv[2];
if (!file) { console.error('Usage: node tools/test-gx/snapshot-file.js flows.json'); process.exit(2); }
const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(zlib.gzipSync(JSON.stringify(snapshot(flows, null))).toString('base64'));
