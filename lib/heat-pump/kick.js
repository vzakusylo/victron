//! lib/heat-pump/kick.js: stuck supply kick (kickTick).
//! Included into "40 Heat pump automations.js" by `// #include` (tools/includes.js); it runs in that
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
// ---- stuck supply kick (d#175) ---------------------------------------------------
// Sometimes the supply stays flat below its point in Silent although the compressor runs; a short Smart wakes it up
// (owner: Silent → Smart → Silent and the supply rises). Heating: point = the owner's curve (heating controller On);
// DHW cycle: point = the boiler curve now (DHW controller On). Not during a defrost / the recovery, the bypass or a
// stopped compressor; at most one kick per 2 × kickMin.
function kickTick() {
    const c = settings.heat || heatCfg({});
    const k = ctx('kick', { s: [], phase: null, at: 0, last: 0, run: null, why: '' });
    const H = (st.hp && st.hp.dps) || {}, B = (st.bypass && st.bypass.dps) || {};
    const d = context.get('dhw') || {}, h = context.get('heat') || {};
    const inDhw = d.state === 'DHW';
    const owner = inDhw ? DHW_ID : HEAT_ID;
    const live = modeOf(owner) === 'live' && settings.master;
    const send1 = (m, text) => {
        const s = mode(m);
        if (live) {
            const q = context.get('queue') || [];
            q.push({ rule: owner, cloud: inDhw ? DHW_NAME : HEAT_NAME, run: k.run, role: s.role, dps: s.dps, set: s.set, text: s.text });
            context.set('queue', q);
            logEvent({ kind: 'write', rule: owner, cloud: inDhw ? DHW_NAME : HEAT_NAME, run: k.run, live: true, text: text + ' → ' + s.text });
            pump();
        } else logEvent({ kind: 'dry', rule: owner, cloud: inDhw ? DHW_NAME : HEAT_NAME, run: k.run, live: false, text: text + ' → would ' + s.text });
    };
    // second half of a kick: back to Silent after kickSec (also when the conditions changed meanwhile)
    if (k.phase === 'smart') {
        if (now - k.at >= c.kickSec * S) {
            k.phase = null; k.s = [];
            // the heating controller may have chosen Smart itself meanwhile: then it stays
            const hh = context.get('heat') || {};
            if (hh.modeAt > k.at && hh.modeCmd === 'smart') logEvent({ kind: 'step', rule: owner, cloud: HEAT_NAME, run: k.run, live, text: 'kick over, Smart stays (heating controller)' });
            else send1('mute', 'kick over after ' + c.kickSec + ' s');
        }
        context.set('kick', k); return;
    }
    const sup = H['102'] === null ? NaN : Number(H['102']);
    const point = inDhw ? (Number.isFinite(d.p23Cmd) && Number.isFinite(d.pumpLatch) ? heatCurveAt(d.p23Cmd, d.p24Cmd || 12, d.pumpLatch)
        : Number.isFinite(d.p23Cmd) && Number.isFinite(d.outAvg) ? heatCurveAt(d.p23Cmd, d.p24Cmd || 12, d.outAvg) : NaN)
        : (Number.isFinite(h.target) ? h.target : NaN);
    const ok = c.kickMin > 0 && modeOf(owner) !== 'off' && ready('hp') && H['1'] === true && H['2'] === 'mute' && n(H['115']) > 0
        && n(H['116']) > 0 && B['1'] !== true && !recentDefrost && !defRecovering && (inDhw || d.state === 'HEATING' || !d.state)
        && Number.isFinite(sup) && Number.isFinite(point) && sup < point - 1
        && (inDhw || ((h.decStep || 0) <= 0 && now - (h.lastStep || 0) >= c.kickMin * MIN))
        && !(inDhw && ((d.outAvg !== null && d.outAvg <= dhwCfgNow().coldLimit) || (d.prot && d.prot.steps)));   // DHW keeps Silent in the cold / after protection
    if (!ok) { k.s = []; k.why = ''; context.set('kick', k); return; }
    k.s.push([now, sup]);
    k.s = k.s.filter((x) => now - x[0] <= c.kickMin * MIN);
    const span = now - k.s[0][0], vals = k.s.map((x) => x[1]);
    const flat = Math.max(...vals) - Math.min(...vals) <= 0.5;
    k.why = flat ? 'supply ' + sup + ' °C flat for ' + Math.round(span / MIN) + ' / ' + c.kickMin + ' min, point ' + point.toFixed(1) + ' °C' : '';
    if (flat && span >= (c.kickMin - 0.5) * MIN && now - k.last >= 2 * c.kickMin * MIN) {
        k.run = now + ':kick'; k.phase = 'smart'; k.at = now; k.last = now;
        send1('smart', 'supply stuck at ' + sup + ' °C for ' + c.kickMin + ' min below its point ' + point.toFixed(1) + ' °C (' + (inDhw ? 'DHW' : 'heating') + ') — kick');
    }
    context.set('kick', k);
}
