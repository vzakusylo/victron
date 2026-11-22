//! lib/heat-pump/kick.js: stuck supply kick (kickTick).
//! Included into "40 Heat pump automations.js" by `// #include` (tools/includes.js); it runs in that
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
// ---- stuck supply kick (d#175) ---------------------------------------------------
// Sometimes the supply stays flat below its point in Silent although the compressor runs; a short Smart wakes it up
// (owner: Silent → Smart → Silent and the supply rises). Heating only, against the owner's curve.
// Not during defrost/recovery, bypass or with a stopped compressor; at most one kick per 2 × kickMin.
function kickMode(k, m, text, live) {
    const s = mode(m);
    if (live) {
        const q = context.get('queue') || [];
        q.push({ rule: HEAT_ID, cloud: HEAT_NAME, run: k.run, ...s, intent: 'kick', protection: m === 'mute' });
        context.set('queue', q);
        logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: k.run, live: true, text: text + ' → ' + s.text });
        pump();
    } else logEvent({ kind: 'dry', rule: HEAT_ID, cloud: HEAT_NAME, run: k.run, live: false, text: text + ' → would ' + s.text });
}

function holdKickForDhw() {
    const k = context.get('kick');
    if (!k) return false;
    k.s = []; k.why = '';
    const active = k.phase === 'smart';
    k.phase = null;
    context.set('kick', k);
    if (!active) return false;
    cancelModeWrite(item => item.run === k.run);
    const q = context.get('queue') || [];
    const unsent = q.some(w => w.run === k.run);
    context.set('queue', q.filter(w => w.run !== k.run));
    if (unsent) return false;
    const live = k.live && modeOf(HEAT_ID) === 'live' && settings.master;
    kickMode(k, 'mute', 'kick ended for DHW', live);
    return live;
}

function kickTick() {
    const c = settings.heat || heatCfg({});
    const k = ctx('kick', { s: [], phase: null, at: 0, last: 0, run: null, why: '' });
    const H = (st.hp && st.hp.dps) || {}, B = (st.bypass && st.bypass.dps) || {}, V = (st.valve && st.valve.dps) || {};
    const d = context.get('dhw') || {}, h = context.get('heat') || {};
    const md = modeOf(HEAT_ID);
    const dhwPending = modeOf(DHW_ID) !== 'off' && (d.streak > 0 || settings.dhwManual?.until > now ||
        (dhwCfgNow().showerForce && context.get('shower')?.demand?.until > now));
    if ((d.state && d.state !== 'HEATING') || dhwPending || V['1'] === true ||
        now - dhwLastEnd(d) < HEAT_WINDOW_MIN * MIN) {
        holdKickForDhw();
        return;
    }
    const live = md === 'live' && settings.master;
    // second half of a kick: back to Silent after kickSec (also when the conditions changed meanwhile)
    if (k.phase === 'smart') {
        if (now - k.at >= c.kickSec * S) {
            k.phase = null; k.s = [];
            // the heating controller may have chosen Smart itself meanwhile: then it stays
            const hh = context.get('heat') || {};
            if (hh.modeAt > k.at && hh.modeCmd === 'smart') logEvent({ kind: 'step', rule: HEAT_ID, cloud: HEAT_NAME, run: k.run, live, text: 'kick over, Smart stays (heating controller)' });
            else kickMode(k, 'mute', 'kick over after ' + c.kickSec + ' s', live && k.live);
        }
        context.set('kick', k); return;
    }
    const sup = H['102'] === null ? NaN : Number(H['102']);
    const point = h.target;
    const ok = c.kickMin > 0 && md !== 'off' && ready('hp') && H['1'] === true && H['2'] === 'mute' && n(H['115']) > 0
        && n(H['116']) > 0 && B['1'] !== true && !recentDefrost && !defRecovering
        && Number.isFinite(sup) && Number.isFinite(point) && sup < point - 1
        && (h.decStep || 0) <= 0 && now - (h.lastStep || 0) >= c.kickMin * MIN;
    if (!ok) { k.s = []; k.why = ''; context.set('kick', k); return; }
    k.s.push([now, sup]);
    k.s = k.s.filter((x) => now - x[0] <= c.kickMin * MIN);
    const span = now - k.s[0][0], vals = k.s.map((x) => x[1]);
    const flat = Math.max(...vals) - Math.min(...vals) <= 0.5;
    k.why = flat ? 'supply ' + sup + ' °C flat for ' + Math.round(span / MIN) + ' / ' + c.kickMin + ' min, point ' + point.toFixed(1) + ' °C' : '';
    if (flat && span >= (c.kickMin - 0.5) * MIN && now - k.last >= 2 * c.kickMin * MIN) {
        if (live && modeBlocked({ ...mode('smart'), rule: HEAT_ID, intent: 'kick' })) {
            context.set('kick', k); return;
        }
        k.run = now + ':kick'; k.phase = 'smart'; k.at = now; k.last = now;
        k.live = live;
        kickMode(k, 'smart', 'supply stuck at ' + sup + ' °C for ' + c.kickMin + ' min below its point ' + point.toFixed(1) + ' °C (heating) — kick', live);
    }
    context.set('kick', k);
}
