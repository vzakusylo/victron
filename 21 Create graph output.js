// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `21 Create graph output.js` and the embedded `func` for "Create graph output"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Transforms the normalised forecast.solar hourly data into a chart.js / ui_chart
//   payload with labels, series names, and two-dimensional data arrays.
// Input:
// - msg.payload : normalised hourly forecast data (output of "Processed info" / "Adjust solar forecast for shade")
// Output (1):
// - output 1 -> msg.payload = [{ labels: [...], series: [...], data: [[...], ...] }]
//   for consumption by a Node-RED ui_chart node
// Change notes:
// 1. Initial version.
// ==========================
var m = {};
m.labels = [];
m.data = [];

m.series = [];
m.data = [];
m.labels = [];

for (let j = 0; j <= msg.days; j++) {
    m.data[j] = [];
}

if (msg.watt === 'watt_hours_day') {
    var i = 0;
    m.series.push("Watt hours per day");
    for (const key in msg.payload.result) {
        m.labels.push(key);
        if (msg.kwhoutput) {
            m.data[i] = +(Math.round(msg.payload.result[key]/100)*.1).toFixed(1);
        } else {
            m.data[i] = msg.payload.result[key];
        }
        i++;
    }
    m.data = [m.data];
    return { payload: [m] };
}

for (let i = 0; i <= 23; i++) {

    m.labels.push(i.toString()+':00');
    if (msg.resolution === 4) {
       m.labels.push(i.toString()+':15');
    }
    if (msg.resolution === 2 || msg.resolution == 4) {
       m.labels.push(i.toString()+':30');
    }
    if (msg.resolution === 4) {
       m.labels.push(i.toString()+':45');
    }

    for (let j = 0; j <= msg.days; j++) {
        m.data[j].push(0);
        if (msg.resolution === 4) {
           m.data[j].push(0)
        }
        if (msg.resolution === 2 || msg.resolution == 4) {
           m.data[j].push(0)
        }
        if (msg.resolution === 4) {
           m.data[j].push(0)
        }

    }
}

var offset = 0;
for (const key in msg.payload.result) {
    var d = new Date(key)
    if (m.series.indexOf(d.toISOString().split('T')[0]) === -1) {
        m.series.push(d.toISOString().split('T')[0])
    }

    var h = d.getHours();
    var minutes = d.getMinutes();

    if (minutes === 0 ) {
        offset = 0;
    } else {
        offset++;
    }

    if (msg.kwhoutput) {
        m.data[m.series.length - 1][h*msg.resolution+offset] = +(Math.round(msg.payload.result[key]/100)*.1).toFixed(1);
    } else {
        m.data[m.series.length - 1][h*msg.resolution+offset] = msg.payload.result[key];
    }
}

return { payload: [m] };
