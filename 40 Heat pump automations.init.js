// On Start (d#131): reload the settings file if the context came back empty; a new node instance
// has no timers, so drop running sequences and queued writes.
context.set('needLoad', context.get('settings') === undefined);
const old = Object.keys(context.get('seqs') || {}); const oldQ = (context.get('queue') || []).length;
context.set('seqs', {}); context.set('queue', []); context.set('pumping', false);
context.set('bootNote', { dropped: old.length + oldQ, text: 'automations node started'
    + (old.length ? '; running sequences dropped: ' + old.join(', ') : '') + (oldQ ? '; ' + oldQ + ' queued writes dropped' : '') });
// d#168: the node does not know whether a defrost just ended (lastDefrost is lost with the context), and the
// outdoor sensor reads 15-45 °C for minutes after one (14 Nov 08:42: 17.8 °C at 3 °C outdoor started a DHW cycle).
// Treat the start as a defrost: no outdoor samples, no DHW start and no heating mode step for DEFROST_QUIET_MIN.
context.set('lastDefrost', Date.now());
const d0 = context.get('dhw'); if (d0 && d0.state === 'HEATING') { d0.outS = []; d0.outAvg = null; context.set('dhw', d0); }
