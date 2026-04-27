// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `11 Processed info.js` and the embedded `func` for "Processed info"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Processes the raw forecast.solar API JSON response into a normalised hourly payload
//   ready for shade adjustment and graph display.
// Env vars used:
// - `type`       -> forecast type selector
// - `watt`       -> watt vs kWh output toggle
// - `kwhoutput`  -> kWh output flag
// Input:
// - msg.payload : raw forecast.solar API JSON response (from http-request node)
// Output (1):
// - output 1 -> msg with normalised hourly forecast payload; msg.resolution and msg.days set
// Change notes:
// 1. Initial version.
// ==========================
msg.resolution = 60;
msg.days = 1;
msg.type = env.get('type');
msg.watt = env.get('watt');
msg.kwhoutput = env.get('kwhoutput');

var key1 = Object.keys(msg.payload.result)[1];
var key2 = Object.keys(msg.payload.result)[2];
var key3 = Object.keys(msg.payload.result)[Object.keys(msg.payload.result).length-1];

var d1 = new Date(key1);
var d2 = new Date(key2); 
var d3 = new Date(key3);
msg.resolution = 3600000 / (d2.getTime() - d1.getTime());

msg.days = Math.floor((d3.getTime() - d1.getTime()) / (1000 * 3600 * 24));

if (msg.watt === 'watt_hours_day') {
    msg.resolution = null;
}

return msg;