// Surgical Dashboard 3.6.6 fixes. CLI: node dashboard-assets.js PACKAGE_ROOT [--apply].
// Default: inspect only. Apply backs up and atomically replaces the static assets, not flows.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
function replaceKnown(source, original, replacement, label) {
    const oldCount = source.split(original).length - 1;
    const newCount = source.split(replacement).length - 1;
    if (oldCount === 1 && newCount === 0) return source.replace(original, replacement);
    if (oldCount === 0 && newCount === 1) return source;
    throw new Error('Unexpected Dashboard ' + label + ' code; refusing to patch');
}
function readFile(file, optional = false) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: !optional });
    if (!stat) return null;
    if (!stat.isFile()) throw new Error('Dashboard asset is not a regular file: ' + file);
    return fs.readFileSync(file, 'utf8');
}
function prepare(root) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version !== '3.6.6') throw new Error('Dashboard bootstrap fix only supports version 3.6.6; inspect this version first');
    const file = path.join(root, 'dist', 'js', 'app.min.js');
    const source = readFile(file);
    const old = 'g.menu.length>0&&e("left")&&e("left").close()';
    const replacement = 'g.menu.length>0&&e().waitFor("left").then(function(s){s.close()})';
    let patched = replaceKnown(source, old, replacement, 'navigation');
    patched = replaceKnown(patched,
        'angular.module("ui",["ngMaterial","ngMdIcons","ngSanitize","ngTouch","sprintf","chart.js","color.picker"])',
        'angular.module("ui",["ngMaterial","ngMdIcons","ngSanitize","sprintf","chart.js","color.picker"])', 'module dependencies');
    const jobs = [];
    if (patched !== source) jobs.push({ dest: file, data: patched, beforeHash: hash(source) });
    const index = path.join(root, 'dist', 'index.html');
    const html = readFile(index);
    const allow = "(main.allowSwipe === 'mouse' || ($event.pointer.type !== 'm' && $event.srcEvent.pointerType !== 'mouse' && $event.srcEvent.pointerType !== 4))";
    const gestures = replaceKnown(html,
        'ng-swipe-right="onSwipeRight();" ng-swipe-left="onSwipeLeft();" ng-attr-ng-swipe-disable-mouse="{{main.allowSwipe !== \'mouse\' ? \'\' : undefined}}"',
        'md-swipe-right="' + allow + ' && onSwipeRight();" md-swipe-left="' + allow + ' && onSwipeLeft();"', 'swipe directives');
    if (gestures !== html) jobs.push({ dest: index, data: gestures, beforeHash: hash(html) });
    const loading = path.join(root, 'dist', 'loading.html');
    if (readFile(loading, true) === null) jobs.push({ dest: loading, data: '<div role="status" aria-live="polite" style="padding:24px;text-align:center">Loading dashboard...</div>\n', beforeHash: null });
    return jobs;
}

function repair(root, apply = false) {
    root = path.resolve(root);
    const jobs = prepare(root);
    if (!apply || !jobs.length) return { jobs, backup: null };
    const backup = fs.mkdtempSync(path.join(path.dirname(path.dirname(root)), 'backup-dashboard-assets-'));
    fs.chmodSync(backup, 0o700);
    const originals = jobs.map((job, index) => {
        const source = readFile(job.dest, true);
        const data = source === null ? null : Buffer.from(source);
        if ((data ? hash(data) : null) !== job.beforeHash) throw new Error('Asset changed during preparation: ' + job.dest);
        const stat = fs.statSync(data === null ? path.join(root, 'dist', 'js', 'app.min.js') : job.dest);
        const saved = data ? path.join(backup, String(index)) : null;
        if (saved) fs.writeFileSync(saved, data, { mode: 0o600 });
        return { job, saved, stat };
    });
    fs.writeFileSync(path.join(backup, 'files.json'), JSON.stringify(originals.map(({ job, saved, stat }) =>
        ({ dest: job.dest, saved, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid })), null, 2) + '\n', { mode: 0o600 });
    const written = [];
    function write(dest, data, stat) {
        const temporary = dest + '.gx-new-' + crypto.randomBytes(6).toString('hex');
        try {
            fs.writeFileSync(temporary, data, { flag: 'wx', mode: stat.mode & 0o777 });
            fs.chmodSync(temporary, stat.mode & 0o777);
            if (process.platform !== 'win32') fs.chownSync(temporary, stat.uid, stat.gid);
            fs.renameSync(temporary, dest);
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
    }
    try {
        for (const item of originals) {
            const source = readFile(item.job.dest, true);
            const current = source === null ? null : hash(source);
            if (current !== item.job.beforeHash) throw new Error('Asset changed before replacement: ' + item.job.dest);
            write(item.job.dest, item.job.data, item.stat);
            written.push(item);
        }
        if (prepare(root).length) throw new Error('Asset verification failed');
    } catch (error) {
        try {
            for (const item of written.reverse()) {
                const source = readFile(item.job.dest, true);
                if (source === null || hash(source) !== hash(item.job.data)) {
                    throw new Error('Concurrent asset change; rollback refused');
                }
                if (item.saved) write(item.job.dest, fs.readFileSync(item.saved), item.stat);
                else fs.unlinkSync(item.job.dest);
            }
        } catch (rollbackError) {
            throw new Error('Dashboard repair failed; rollback incomplete. Backup: ' + backup + '. ' +
                error.message + '. ' + rollbackError.message);
        }
        throw new Error('Dashboard repair failed; prior written assets restored. Backup: ' + backup + '. ' + error.message);
    }
    return { jobs, backup };
}
module.exports = { prepare, repair };

if (require.main === module) {
    try {
        const [root, flag, extra] = process.argv.slice(2);
        if (!root || (flag && flag !== '--apply') || extra) throw new Error('Usage: node dashboard-assets.js PACKAGE_ROOT [--apply]');
        const result = repair(root, flag === '--apply');
        console.log((flag === '--apply' ? 'APPLY' : 'DRY RUN') + ': ' + result.jobs.length + ' asset(s)' +
            (result.backup ? '; backup: ' + result.backup : '; nothing changed'));
        result.jobs.forEach(job => console.log('  ' + job.dest));
    } catch (error) {
        console.error('ABORT: ' + error.message);
        process.exitCode = 1;
    }
}
