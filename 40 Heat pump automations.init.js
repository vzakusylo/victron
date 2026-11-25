// On Start (d#131): reload the settings file if the context came back empty; a new node instance
// has no timers, so drop running sequences and queued writes.
context.set('needLoad', context.get('settings') === undefined);
// d#194: with an empty context the settings file has not been read yet; saving before 'load' would overwrite it
// with the defaults (20 Nov 00:36). A kept context was loaded earlier and may be saved.
context.set('settingsLoaded', context.get('settings') !== undefined);
context.set('saveHeldNoted', false);
const old = Object.keys(context.get('seqs') || {}); const oldQ = (context.get('queue') || []).length;
context.set('seqs', {}); context.set('queue', []); context.set('pumping', false);
const curveLease = context.get('hpCurveLease');
if (curveLease) context.set('hpCurveLease', { ...curveLease, until: 0 });
const ownerRequest = context.get('ownerCurveRequest');
if (ownerRequest) {
    context.set('ownerCurveRequest', null);
    context.set('ownerCurveResult', { requestId: ownerRequest.requestId, ok: false, text: 'Heating curve not applied: controller restarted before confirmation' });
}
context.set('bootNote', { dropped: old.length + oldQ, text: 'automations node started'
    + (old.length ? '; running sequences dropped: ' + old.join(', ') : '') + (oldQ ? '; ' + oldQ + ' queued writes dropped' : '') });
// #include lib/heat-pump/defrost-reading.js
const startAt = Date.now();
const hp = (flow.get('heatPump') || {}).hp;
const dps = hp?.dps || {};
const clearReading = freshAutomationDevice(hp, startAt) && hp.lastData <= startAt && defrostReading(dps) === false;
const last = context.get('lastDefrost') || 0;
const realLast = last !== context.get('startedAt') ? last : 0;
const view = flow.get('dhwView');
const viewAge = startAt - view?.at;
const unknownGap = !(viewAge >= 0 && viewAge <= FRESH_MS);
const recovery = context.get('inDefrost') || context.get('defRecPrev') || (last && startAt - last < DEFROST_QUIET_MIN * MIN)
    || view?.outHeld;
const cleanRestart = clearReading && !recovery && !unknownGap;
// Keep the full d#168 hold if telemetry is missing or still indicates a defrost. Preserve a known recovery.
if (!cleanRestart) context.set('lastDefrost', clearReading && !unknownGap && realLast ? realLast : startAt);
else if (last !== realLast) context.set('lastDefrost', 0);
context.set('startedAt', startAt);
context.set('cleanRestart', cleanRestart);
const outdoor = dhwMeasurement(dps['103']);
context.set('restartOutdoor', cleanRestart && Number.isFinite(outdoor) ? [startAt, outdoor] : null);
const d0 = context.get('dhw'); if (d0 && d0.state === 'HEATING') {
    d0.outS = []; d0.outAvg = null;
    if (ownerRequest?.sentAt) d0.curveCaptureHeld = true;
    context.set('dhw', d0);
}
// Do not replay an old temperature slope or pending shower request after a restart.
const shower = context.get('shower');
if (shower) { shower.samples = []; shower.episode = null; shower.demand = null; context.set('shower', shower); }
