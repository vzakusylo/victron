// Prepare surgical fixes for the installed Dashboard 3.6.6 bootstrap assets.
// The caller must back up the originals and write these jobs atomically.
'use strict';
const fs = require('fs');
const path = require('path');
function prepare(root) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version !== '3.6.6') throw new Error('Dashboard bootstrap fix only supports version 3.6.6; inspect this version first');
    const file = path.join(root, 'dist', 'js', 'app.min.js');
    if (!fs.lstatSync(file).isFile()) throw new Error('Dashboard bundle is not a regular file');
    const source = fs.readFileSync(file, 'utf8');
    const old = 'g.menu.length>0&&e("left")&&e("left").close()';
    const replacement = 'g.menu.length>0&&e().waitFor("left").then(function(s){s.close()})';
    const jobs = [];
    if (!source.includes(replacement)) {
        if (source.split(old).length !== 2) throw new Error('Unexpected Dashboard navigation code; refusing to patch');
        jobs.push({ dest: file, data: source.replace(old, replacement) });
    }
    const loading = path.join(root, 'dist', 'loading.html');
    if (!fs.existsSync(loading)) jobs.push({ dest: loading, data: '<div role="status" aria-live="polite" style="padding:24px;text-align:center">Loading dashboard...</div>\n' });
    return jobs;
}
module.exports = { prepare };
