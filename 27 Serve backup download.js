// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `27 Serve backup download.js` and the embedded `func` for "Serve backup download"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - HTTP GET /grid-backup/download?name=<backup>.tar.gz -> streams the backup file to the browser.
// - Also answers HTTP errors caught from the backup file nodes (msg.error from the catch node).
// Input:
// - msg.req.query.name (from "GET /grid-backup/download")
// - msg.error + msg.res (from "Catch backup HTTP errors")
// Outputs (2):
// - output 1 -> file in "Read backup file" (msg.filename set, download headers set) -> http response
// - output 2 -> http response (validation error / caught error)
// Change notes:
// 1. Initial version.
// 2. Node status shows every request / error, to see whether a download reaches Node-RED
//    (e.g. through the VRM proxy).
// ==========================

const BACKUP_DIR = '/data/home/nodered/grid-control-backups';
const NAME_PATTERN = /^[A-Za-z0-9._-]+\.tar\.gz$/;

function timeLabel() {
    const now = new Date();
    return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
}

function textResponse(statusCode, text) {
    node.status({ fill: 'red', shape: 'dot', text: timeLabel() + ' ' + statusCode + ' ' + text });
    msg.statusCode = statusCode;
    msg.headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    msg.payload = text;
    return [null, msg];
}

if (!msg.res) {
    return null;
}

if (msg.error) {
    return textResponse(500, 'Backup request failed: ' + (msg.error.message || 'unknown error'));
}

const name = String((msg.req && msg.req.query && msg.req.query.name) || '');

if (!NAME_PATTERN.test(name)) {
    return textResponse(400, 'Invalid backup name');
}

node.status({ fill: 'blue', shape: 'dot', text: timeLabel() + ' sending ' + name });
msg.filename = BACKUP_DIR + '/' + name;
msg.statusCode = 200;
msg.headers = {
    'Content-Type': 'application/gzip',
    'Content-Disposition': 'attachment; filename="' + name + '"',
    'Cache-Control': 'no-store'
};
return [msg, null];
