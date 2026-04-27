// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `09 Store solar prediction.js` and the embedded `func` for "Store solar prediction"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Stores today's solar forecast summary into flow context so the battery controller
//   and analytics model can use it for restoration planning and KPI display.
// Input:
// - msg.payload : { today: { energyKWh, peakKW, condition }, source, location, activeWindow }
// Flow context write:
// - `solarForecastToday` -> { updatedAt, source, location, activeWindow, condition, energyKWh, peakKW }
// Output (1):
// - output 1 -> msg pass-through after storing
// Change notes:
// 1. Initial version.
// ==========================
const data = msg.payload || {};
const today = data.today || { energyKWh: 0, peakKW: 0, condition: 'unknown' };
const summary = {
    updatedAt: new Date().toISOString(),
    source: data.source || 'forecast.solar',
    location: data.location || 'Hokksund, Norway',
    activeWindow: data.activeWindow || '11:00-17:00',
    condition: today.condition || 'unknown',
    energyWh: Number(today.energyWh) || 0,
    energyKWh: Number(today.energyKWh) || 0,
    peakW: Number(today.peakW) || 0,
    peakKW: Number(today.peakKW) || 0,
    activeHours: Number(today.activeHours) || 0
};

flow.set('solarForecastAdjusted', data);
flow.set('solarForecastToday', summary);

node.status({
    fill: summary.energyKWh > 0 ? 'green' : 'yellow',
    shape: 'dot',
    text: `${summary.condition} | ${summary.energyKWh.toFixed(2)}kWh | ${summary.activeWindow}`
});

msg.topic = 'solar-forecast-today';
msg.payload = summary;
return msg;