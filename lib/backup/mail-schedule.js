//! Node 26: Mail schedule and state.
const pad2 = n => String(n).padStart(2, '0');

// Wall-clock parts of `ts` in MAIL_TZ (the GX itself runs in UTC).
function zoneParts(ts) {
    const parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: MAIL_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(ts)).forEach(p => { parts[p.type] = p.value; });
    return { y: Number(parts.year), mo: Number(parts.month) - 1, d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute) };
}

function zoneText(ts) {
    const p = zoneParts(ts);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay()];
    return wd + ' ' + p.y + '-' + pad2(p.mo + 1) + '-' + pad2(p.d) + ' ' + pad2(p.h) + ':' + pad2(p.mi);
}

// The first Monday 07:00 (MAIL_TZ) strictly after `ts`.
function nextMailDue(ts) {
    const p = zoneParts(ts);
    for (let k = 0; k <= 7; k += 1) {
        const day = new Date(Date.UTC(p.y, p.mo, p.d + k));
        if (day.getUTCDay() !== MAIL_WEEKDAY) {
            continue;
        }
        const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), MAIL_HOUR, 0);
        const z = zoneParts(wall);
        const offset = Date.UTC(z.y, z.mo, z.d, z.h, z.mi) - wall;     // zone offset at that moment
        const due = wall - offset;
        if (due > ts) {
            return due;
        }
    }
    return ts + 7 * 24 * 3600 * 1000;
}

function mailState(state) {
    state.mail = Object.assign({ dueAt: 0, tries: 0, lastAt: 0, lastOk: null, lastText: '', lastAuto: false }, state.mail || {});
    return state.mail;
}
