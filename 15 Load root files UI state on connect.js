// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `15 Load root files UI state on connect.js` and the embedded `func` for "Load root files UI state on connect"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Fires when a dashboard client connects and emits a request to load the persisted
//   root-files UI state so the panel is pre-populated on first open.
// Input:
// - msg (client-connected event from ui_control node)
// Output (1):
// - output 1 -> { topic: 'load-root-files-ui-state-request' }
// Change notes:
// 1. Initial version.
// ==========================
return { topic: 'load-root-files-ui-state-request' };