// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `12 update ratelimit.js` and the embedded `func` for "update ratelimit"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Reads the rate-limit data from the forecast.solar API response and stores it
//   into flow context for monitoring and status display.
// Input:
// - msg.payload.message.ratelimit : { remaining, limit }
// Flow context write:
// - `forecast.solar.ratelimit.remaining`
// - `forecast.solar.ratelimit.limit`
// Output (1):
// - output 1 -> msg pass-through
// Change notes:
// 1. Initial version.
// ==========================
var remaining = msg.payload.message.ratelimit.remaining || 0;
var limit = msg.payload.message.ratelimit.limit;

flow.set('forecast.solar.ratelimit.remaining', remaining)
flow.set('forecast.solar.ratelimit.limit', limit)

return msg;