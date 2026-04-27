// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `13 update status.js` and the embedded `func` for "update status"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Reads remaining / limit from flow context and shows a colour-coded rate-limit
//   status badge on the node (green = ok, yellow = low, red = exhausted).
// Flow context read:
// - `forecast.solar.ratelimit.remaining`
// - `forecast.solar.ratelimit.limit`
// Input:
// - msg (any) -> triggers a status refresh
// Output (1):
// - output 1 -> msg pass-through
// Change notes:
// 1. Initial version.
// ==========================
var remaining = flow.get('forecast.solar.ratelimit.remaining') || -1;
var limit = flow.get('forecast.solar.ratelimit.limit') || -1

var text = remaining.toString() + '/' + limit.toString();
var fill = "green";

if (remaining == 0) {
    fill = "red";
    text = "Limit used";
}

if (remaining > 0 && remaining < limit / 2) {
    fill = "yellow"
}

if (remaining == -1 ) {
    fill = "blue"
    text = "Limits unknown"
}

msg.payload = ({ fill: fill, text: text });

return msg;