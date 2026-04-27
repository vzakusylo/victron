// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `22 Filter graph.js` and the embedded `func` for "Filter graph"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Trims the graph series to at most `daystoforecast` days by popping excess
//   data and series entries from the end of the chart payload.
// - Pass-through when daystoforecast == -1 (show all).
// Env vars used:
// - `daystoforecast` : maximum number of forecast days to display (-1 = unlimited)
// Input:
// - msg.payload : [{ labels, series, data }] chart payload (from "Create graph output")
// Output (1):
// - output 1 -> msg with trimmed (or unchanged) chart payload
// Change notes:
// 1. Initial version.
// ==========================
var forecasted = msg.payload[0].series.length;

if ((env.get('daystoforecast') > -1) && (env.get('daystoforecast') < forecasted)) {
    for (i = 1; i < (forecasted - env.get('daystoforecast')); i++ ) {
        msg.payload[0].data.pop();
        msg.payload[0].series.pop();
    }
}

if (env.get('watt') === 'watt_hours_day' ) {
    forecasted = msg.payload[0].labels.length;
    for (i = 1; i < (forecasted - env.get('daystoforecast')); i++ ) {
        msg.payload[0].labels.pop();
        msg.payload[0].data[0].pop();
    }
}

if (!env.get('showtoday')) {
    msg.payload[0].data.shift();
    msg.payload[0].series.shift();
}

if (env.get('widengraph')) {
    var c = msg.payload[0].labels.length;
    var x = 0;
    for (i = 0; i < c; i++) {
        var remove = true;
        for (d = 0; d < msg.payload[0].data.length; d++) {
            if (msg.payload[0].data[d][x] > 0) {
                remove = false;
            }
        }
        if (remove) {
            msg.payload[0].labels.splice(x, 1);
            for (d = 0; d < msg.payload[0].data.length; d++) {
                 msg.payload[0].data[d].splice(x, 1);
            }
            x--;
        }
        x++;
    }
    // Still the first and last datapoints should be zero, so
    // add those again
    msg.payload[0].labels.unshift('');
    msg.payload[0].labels.push('');
    for (d = 0; d < msg.payload[0].data.length; d++) {
         msg.payload[0].data[d].unshift(0);
         msg.payload[0].data[d].push(0);
    }   
}

return msg;