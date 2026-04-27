// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `16 Refresh dashboard hourly stats.js` and the embedded `func` for "Refresh dashboard hourly stats"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Emits a refresh trigger so the dashboard hourly stats panel reloads its data.
// - Typically connected to a timer inject that fires every minute or on demand.
// Input:
// - msg (any, typically an inject node or timer)
// Output (1):
// - output 1 -> { topic: 'dashboard-refresh' }
// Change notes:
// 1. Initial version.
// ==========================
return { topic: 'dashboard-refresh' };