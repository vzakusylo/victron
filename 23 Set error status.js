// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `23 Set error status.js` and the embedded `func` for "Set error status"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Shows a red error status badge on the node and passes the error payload downstream
//   so it can be displayed or logged by connected nodes.
// Input:
// - msg.payload : error message string
// Output (1):
// - output 1 -> msg with node status set to red and error text visible in the editor
// Change notes:
// 1. Initial version.
// ==========================
node.warn(msg.payload)
msg.payload = ({ fill: "red", text: msg.payload });

return msg;