// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `28 Store uploaded backup.js` and the embedded `func` for "Store uploaded backup"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - HTTP POST /grid-backup/upload (multipart, field `backup`) stores an uploaded backup in the
//   backup folder as `uploaded-<timestamp>-<name>.tar.gz`. Restoring is a separate, confirmed step.
// Flow:
// - stage 1 (from "POST /grid-backup/upload"): validate, set msg.filename -> output 1 (file write)
// - stage 2 (back from the file write node, msg.backupUploadName set): answer the browser on
//   output 2 and tell "Manage backup dashboard" on output 3
// Outputs (3):
// - output 1 -> file "Write uploaded backup"
// - output 2 -> http response
// - output 3 -> "Manage backup dashboard" (topic backup-uploaded)
// Change notes:
// 1. Initial version.
// ==========================

const BACKUP_DIR = '/data/home/nodered/grid-control-backups';
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function jsonResponse(statusCode, body) {
    msg.statusCode = statusCode;
    msg.headers = { 'Content-Type': 'application/json' };
    msg.payload = body;
    return msg;
}

if (msg.backupUploadName) {
    const name = msg.backupUploadName;
    jsonResponse(200, { ok: true, name });
    return [null, msg, { topic: 'backup-uploaded', payload: { name } }];
}

const files = msg.req && Array.isArray(msg.req.files) ? msg.req.files : [];
const file = files.find(item => item && item.fieldname === 'backup') || files[0];

if (!file || !file.buffer || !file.buffer.length) {
    return [null, jsonResponse(400, { ok: false, error: 'No file received' }), null];
}

if (file.buffer.length > MAX_UPLOAD_BYTES) {
    return [null, jsonResponse(413, { ok: false, error: 'File is larger than 500 MB' }), null];
}

// gzip magic bytes
if (file.buffer[0] !== 0x1f || file.buffer[1] !== 0x8b) {
    return [null, jsonResponse(400, { ok: false, error: 'Not a .tar.gz file' }), null];
}

const now = new Date();
const stamp = now.getFullYear()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0') + '-'
    + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
const baseName = String(file.originalname || 'backup.tar.gz')
    .replace(/\.tar\.gz$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .substring(0, 80);
const name = 'uploaded-' + stamp + '-' + (baseName || 'backup') + '.tar.gz';

msg.filename = BACKUP_DIR + '/' + name;
msg.payload = file.buffer;
msg.backupUploadName = name;
return [msg, null, null];
