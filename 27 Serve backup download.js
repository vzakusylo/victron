// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `27 Serve backup download.js` and the embedded `func` for "Serve backup download"
//   in `flows.json` must always stay synchronized.
// - The node needs `fs` in its Setup → Modules (`libs: [{ var: 'fs', module: 'fs' }]` in flows.json;
//   functionExternalModules is on in the Venus OS Node-RED settings).
// Purpose:
// - HTTP GET /grid-backup/download?name=<backup>.tar.gz -> streams the backup file to the browser.
// - Also answers HTTP errors caught from the backup nodes (msg.error from the catch node).
// Input:
// - msg.req.query.name (from "GET /grid-backup/download")
// - msg.error + msg.res (from "Catch backup HTTP errors")
// Outputs (2):
// - output 1 -> not used since change 3 (the file is streamed straight to msg.res._res)
// - output 2 -> http response (validation error / caught error)
// Change notes:
// 1. Initial version.
// 2. Node status shows every request / error, to see whether a download reaches Node-RED
//    (e.g. through the VRM proxy).
// 3. (d#147) The file is streamed with fs.createReadStream piped into the Express response
//    (Content-Length, back-pressure) instead of "file in" reading the whole archive into one Buffer
//    for "http response". A 46 MB backup took the GX's free RAM and froze Node-RED for minutes.
//    Unknown name -> 404; an aborted download closes the file; the status shows sent MB and time.
// ==========================

const BACKUP_DIR = '/data/home/nodered/grid-control-backups';
const NAME_PATTERN = /^[A-Za-z0-9._-]+\.tar\.gz$/;
const CHUNK = 256 * 1024;

function timeLabel() {
    const now = new Date();
    return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
}

function mb(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB';
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

const file = BACKUP_DIR + '/' + name;
let size = 0;
try {
    const st = fs.statSync(file);
    if (!st.isFile()) {
        return textResponse(404, 'Backup not found: ' + name);
    }
    size = st.size;
}
catch (e) {
    return textResponse(404, 'Backup not found: ' + name);
}

const res = msg.res._res;
const started = Date.now();
let sent = 0;
let done = false;

res.status(200);
res.set({
    'Content-Type': 'application/gzip',
    'Content-Length': String(size),
    'Content-Disposition': 'attachment; filename="' + name + '"',
    'Cache-Control': 'no-store'
});

const stream = fs.createReadStream(file, { highWaterMark: CHUNK });
node.status({ fill: 'blue', shape: 'dot', text: timeLabel() + ' sending ' + name + ' (' + mb(size) + ')' });

stream.on('data', chunk => { sent += chunk.length; });
stream.on('error', error => {
    done = true;
    node.status({ fill: 'red', shape: 'dot', text: timeLabel() + ' read error ' + name + ': ' + error.message });
    if (!res.headersSent) {
        res.status(500).set('Content-Type', 'text/plain; charset=utf-8').end('Backup read failed: ' + error.message);
    }
    else {
        res.destroy();
    }
});
res.on('finish', () => {
    done = true;
    node.status({ fill: 'green', shape: 'dot', text: timeLabel() + ' sent ' + name + ' ' + mb(sent) + ' in ' + Math.round((Date.now() - started) / 1000) + ' s' });
});
res.on('close', () => {
    stream.destroy();
    if (!done) {
        node.status({ fill: 'yellow', shape: 'ring', text: timeLabel() + ' aborted ' + name + ' after ' + mb(sent) + ' of ' + mb(size) });
    }
});
stream.pipe(res);

return null;
