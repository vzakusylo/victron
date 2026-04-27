// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `10 create forecast.solar url.js` and the embedded `func` for "create forecast.solar url"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Builds the forecast.solar API endpoint URL from node environment variables.
// - Supports optional API key for authenticated (higher rate-limit) requests.
// Env vars used:
// - `apikey` (optional) -> if set, injected into URL path for authenticated access
// - `type`              -> endpoint type (e.g. `estimate`)
// Input:
// - msg (any) -> triggers URL construction
// Output (1):
// - output 1 -> msg with msg.url set to the constructed forecast.solar endpoint
// Change notes:
// 1. Initial version.
// ==========================
msg.url = 'https://api.forecast.solar/';

if (env.get('apikey')) {
    msg.url += env.get('apikey') + '/';
    }

msg.url += env.get('type') + '/';

msg.url += env.get('watt') + '/';

msg.url += env.get('latitude') + '/' +
           env.get('longitude') + '/' +
           env.get('declination') + '/' +
           env.get('azimuth') + '/' +
           env.get('modules power');

msg.topic = 'solar forecast: '+(env.get('type') || '');
msg.topic += (' '+env.get('watt') || '');
if (env.get('kwhoutput')) {
    msg.topic += ' (kWh)';
}
return msg;