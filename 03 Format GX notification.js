// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `03 Format GX notification.js` and the embedded `func` for "Format GX notification"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Normalises and formats an incoming VRM notification message for the GX display node.
// - Accepts numeric or string type codes (0/warning = warning, 1/alarm = alarm).
// Input:
// - msg.payload            : notification message string (or msg.notification.message)
// - msg.notification.type  : 0=warning / 1=alarm  (optional, defaults to 0)
// - msg.notification.title : override title string (optional, defaults to "Day / Night Grid Control")
// Output (1):
// - output 1 -> { title, message, type } notification object for the VRM notification node
// Change notes:
// 1. Initial version.
// ==========================
const defaultTitle = "Day / Night Grid Control";

function normalizeType(value) {
    if (value === 0 || value === "0" || value === "warning") {
        return 0;
    }

    if (value === 1 || value === "1" || value === "alarm") {
        return 1;
    }

    return 2;
}

const title = msg.title || (msg.notification && msg.notification.title) || defaultTitle;
const rawType = msg.type !== undefined
    ? msg.type
    : (msg.notification && (msg.notification.type !== undefined ? msg.notification.type : msg.notification.level));
const rawMessage = (msg.notification && msg.notification.message) || msg.payload;

if (rawMessage === undefined || rawMessage === null || rawMessage === "") {
    return null;
}

const safeTitle = String(title)
    .replace(/\t/g, " ")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 100);

const safeMessage = String(rawMessage)
    .replace(/\t/g, " ")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 500);

msg.payload = `${normalizeType(rawType)}\t${safeTitle}\t${safeMessage}`;
return msg;