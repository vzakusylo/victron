// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `20 Format notification for log.js` and the embedded `func` for "Format notification for log"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Formats a VRM notification as a timestamped log line and sets msg.filename so a
//   downstream file-append node writes it to today's daily grid-control log file.
// Input:
// - msg.notification.message (preferred) or msg.payload (plain string fallback)
// - msg.notification.timestamp (optional, defaults to now)
// Output (1):
// - output 1 -> msg with:
//     msg.payload  = '<ISO-timestamp> | <message>\n'
//     msg.filename = /data/grid-control-logs/grid-control-YYYY-MM-DD.log
// Change notes:
// 1. Initial version.
// ==========================
const rawMessage = (msg.notification && msg.notification.message) || (typeof msg.payload === 'string' ? msg.payload : null);
if (!rawMessage) return null;

const ts = (msg.notification && msg.notification.timestamp) || new Date().toISOString();
const logLine = ts + ' | ' + rawMessage + '\n';

const d = new Date();
const dateKey = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
].join('-');

const logDir = '/data/home/nodered/grid-control-logs';
msg.filename = logDir + '/grid-control-' + dateKey + '.log';
msg.payload = logLine;
msg.encoding = 'utf8';
return msg;