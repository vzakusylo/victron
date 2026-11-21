// On Start (d#131): reload the settings file if the context came back empty; a new node instance
// has no timers, so drop running sequences and queued writes.
context.set('needLoad', context.get('settings') === undefined);
// d#194: with an empty context the settings file has not been read yet; saving before 'load' would overwrite it
// with the defaults (20 Nov 00:36). A kept context was loaded earlier and may be saved.
context.set('settingsLoaded', context.get('settings') !== undefined);
context.set('saveHeldNoted', false);
const old = Object.keys(context.get('seqs') || {}); const oldQ = (context.get('queue') || []).length;
context.set('seqs', {}); context.set('queue', []); context.set('pumping', false);
context.set('bootNote', { dropped: old.length + oldQ, text: 'automations node started'
    + (old.length ? '; running sequences dropped: ' + old.join(', ') : '') + (oldQ ? '; ' + oldQ + ' queued writes dropped' : '') });
// d#168: the node does not know whether a defrost just ended (lastDefrost is lost with the context), and the
// outdoor sensor reads 15-45 °C for minutes after one (14 Nov 08:42: 17.8 °C at 3 °C outdoor started a DHW cycle).
// Treat the start as a defrost: no outdoor samples, no DHW start and no heating mode step for DEFROST_QUIET_MIN.
const startAt = Date.now();
context.set('lastDefrost', startAt);
context.set('startedAt', startAt);   // idle.js: a lastDefrost equal to this was not a real defrost
const d0 = context.get('dhw'); if (d0 && d0.state === 'HEATING') { d0.outS = []; d0.outAvg = null; context.set('dhw', d0); }
// Do not replay an old temperature slope or pending shower request after a restart.
const shower = context.get('shower');
if (shower) { shower.samples = []; shower.episode = null; shower.demand = null; context.set('shower', shower); }
