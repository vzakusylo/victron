// On Start (d#131): reload the settings file if the context came back empty; a new node instance
// has no timers, so drop running sequences and queued writes.
context.set('needLoad', context.get('settings') === undefined);
const old = Object.keys(context.get('seqs') || {}); const oldQ = (context.get('queue') || []).length;
context.set('seqs', {}); context.set('queue', []); context.set('pumping', false);
context.set('bootNote', { dropped: old.length + oldQ, text: 'automations node started'
    + (old.length ? '; running sequences dropped: ' + old.join(', ') : '') + (oldQ ? '; ' + oldQ + ' queued writes dropped' : '') });
