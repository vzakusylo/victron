// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `48 Payback model.js` and the embedded `func` for "Payback model" in `flows.json`
//   must always stay synchronized.
// Purpose:
// - Backend of the "Payback" dashboard page (49): how much the system (battery, inverter, PV,
//   controller) has saved since the first hour of energy history, split into peak shaving
//   (kapasitetsledd), solar and battery time shift, and how much is left until the equipment
//   cost is paid back.
// Data (read by the exec node "Read payback data", `sh -c <payload>`):
// - grid-control-logs/energy-YYYY-MM.csv: hour,grid_wh,ac_wh,sol_wh,bill_wh,peak_w,setpoint_w,season,min
//   (hour = local time "YYYY-MM-DD HH")
// - grid-control-logs/energy-YYYY-MM-DD.log (legacy, before the CSV): "YYYY-MM-DD HH:00 | Grid …Wh | AC …Wh | Sol …Wh"
//   (the CSV wins for the same hour)
// - grid-control-config/payback.json: settings saved from the page (equipment, prices, tariff)
// Model per hour (all loads are behind the MultiPlus, so AC load = what the house would import
// without the system; there is no export):
// - with the system:    import = grid_wh, billable = bill_wh (grid x night factor 22-06)
// - without the system: import = ac_wh,   billable = ac_wh x night factor
// - energy saving  = (ac_wh - grid_wh) x (energy price + grid energy charge day/night)
// - solar part     = sol_wh x the same price; battery shift = energy saving - solar part
//   (positive when the battery moves import to cheaper night hours, negative for its losses)
// - peak shaving per month: Elvenett kapasitetsledd = average of the 3 highest billable hours on
//   3 different days -> step price; saving = price(without) - price(with), scaled by the share of
//   the month that has data (the current month counts as far as it has run)
// Payback: equipment cost (EUR x EUR/NOK) - total saving; time left = remaining / average saving
// per day of data (a straight-line estimate: winter and summer months differ).
// Input (msg.topic):
// - 'ui'   (page 49) payload { action: 'open' | 'refresh' | 'save', settings }
// - 'tick' (inject, hourly) -> read the data again
// - 'read' (exec stdout)    -> parse, compute, send the model
// Output (3):
// - output 1 -> ui_template "Payback page", msg.payload = model
// - output 2 -> exec node "Read payback data"
// - output 3 -> file node "Write payback settings" (msg.filename, msg.payload JSON)
// Change notes:
// 1. Initial version (d#148).
// ==========================

const LOG_DIR = '/data/home/nodered/grid-control-logs';
const CFG_FILE = '/data/home/nodered/grid-control-config/payback.json';

// Defaults: equipment from the owner (EUR); Elvenett household tariff 2026 incl. VAT (verify on
// elvenett.no and change on the page when the prices change).
const DEFAULTS = {
    eurNok: 11.7,
    items: [
        { name: 'Inverter', eur: 700 },
        { name: 'Cerbo GX', eur: 300 },
        { name: 'Shunts (2 x 70)', eur: 140 },
        { name: 'Battery', eur: 1000 },
        { name: 'Wires and cabinet', eur: 500 },
        { name: 'Solar panels', eur: 350 }
    ],
    energyPrice: 1.0,          // NOK/kWh: spot + supplier markup, incl. VAT
    gridDay: 0.3516,           // NOK/kWh: grid energy charge 06-22, incl. taxes
    gridNight: 0.1641,         // NOK/kWh: grid energy charge 22-06
    nightFactor: 0.7,          // night hours count at 70 % for the capacity step
    tierLimitsKW: [2, 5, 10, 15, 20, 25, 50, 75, 100, 125],
    tierPrices: [160, 233, 331, 496, 638, 803, 1133, 1511, 1894, 2275]   // NOK/month
};

function shellQuote(script) { return "'" + String(script).replace(/'/g, "'\\''") + "'"; }
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r0 = (x) => Math.round(x);
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function readCmd() {
    return shellQuote([
        'cd ' + LOG_DIR + ' || exit 0',
        'echo "@@CFG"; cat ' + CFG_FILE + ' 2>/dev/null; echo',
        'for f in energy-????-??.csv; do [ -f "$f" ] && { echo "@@CSV $f"; cat "$f"; }; done',
        'for f in energy-????-??-??.log; do [ -f "$f" ] && { echo "@@LOG $f"; cat "$f"; }; done',
        'echo "@@END"'
    ].join('\n'));
}

// Validates settings from the page or the file; anything missing or invalid falls back to the default.
function cleanSettings(s) {
    s = s && typeof s === 'object' ? s : {};
    const out = {
        eurNok: Math.min(50, Math.max(1, num(s.eurNok, DEFAULTS.eurNok))),
        energyPrice: Math.min(20, Math.max(0, num(s.energyPrice, DEFAULTS.energyPrice))),
        gridDay: Math.min(10, Math.max(0, num(s.gridDay, DEFAULTS.gridDay))),
        gridNight: Math.min(10, Math.max(0, num(s.gridNight, DEFAULTS.gridNight))),
        nightFactor: Math.min(1, Math.max(0, num(s.nightFactor, DEFAULTS.nightFactor))),
        tierLimitsKW: DEFAULTS.tierLimitsKW.slice(),
        tierPrices: DEFAULTS.tierPrices.map((p, i) => Math.max(0, num(Array.isArray(s.tierPrices) ? s.tierPrices[i] : undefined, p))),
        items: []
    };
    const items = Array.isArray(s.items) ? s.items : DEFAULTS.items;
    for (const it of items.slice(0, 30)) {
        const name = String((it && it.name) || '').replace(/[<>]/g, '').trim().slice(0, 60);
        const eur = Math.max(0, num(it && it.eur, 0));
        if (name || eur) out.items.push({ name: name || 'Item', eur: r2(eur) });
    }
    return out;
}

// stdout -> { cfg, hours: { 'YYYY-MM-DD HH': { grid, ac, sol, bill|null } } }
function parse(text) {
    const hours = {};
    let cfg = null, mode = '', cfgText = '';
    for (const line of String(text || '').split(/\r?\n/)) {
        if (line.startsWith('@@')) {
            mode = line.slice(2, 5);
            continue;
        }
        if (mode === 'CFG') { cfgText += line; continue; }
        if (mode === 'CSV') {
            const p = line.split(',');
            if (!/^\d{4}-\d{2}-\d{2} \d{2}$/.test(p[0] || '')) continue;
            hours[p[0]] = { grid: num(p[1], 0), ac: num(p[2], 0), sol: num(p[3], 0), bill: p[4] === undefined || p[4] === '' ? null : num(p[4], null), csv: true };
        }
        else if (mode === 'LOG') {
            const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}):\d{2} \| Grid (-?\d+)Wh \| AC (-?\d+)Wh \| Sol (-?\d+)Wh/);
            if (m && !(hours[m[1]] && hours[m[1]].csv)) hours[m[1]] = { grid: Number(m[2]), ac: Number(m[3]), sol: Number(m[4]), bill: null };
        }
    }
    if (cfgText.trim()) {
        try { cfg = JSON.parse(cfgText); } catch (e) { cfg = null; }
    }
    return { cfg, hours };
}

function tierOf(kw, st) {
    for (let i = 0; i < st.tierLimitsKW.length; i += 1) if (kw < st.tierLimitsKW[i]) return i;
    return st.tierLimitsKW.length - 1;
}

function compute(hours, st, nowTs) {
    const keys = Object.keys(hours).sort();
    const months = {};
    const tot = { energy: 0, solar: 0, solarKWh: 0, gridKWh: 0, loadKWh: 0, peak: 0 };
    for (const k of keys) {
        const h = hours[k];
        const hour = Number(k.slice(11, 13));
        const night = hour >= 22 || hour < 6;
        const f = night ? st.nightFactor : 1;
        const price = st.energyPrice + (night ? st.gridNight : st.gridDay);
        const mk = k.slice(0, 7), dk = k.slice(0, 10);
        const m = months[mk] || (months[mk] = { month: mk, days: {}, energy: 0, solar: 0, solarKWh: 0, gridKWh: 0, loadKWh: 0, hours: 0 });
        const d = m.days[dk] || (m.days[dk] = { with: 0, without: 0 });
        const billWith = h.bill !== null && h.bill !== undefined ? h.bill : Math.max(0, h.grid) * f;
        d.with = Math.max(d.with, billWith);
        d.without = Math.max(d.without, Math.max(0, h.ac) * f);
        m.energy += (h.ac - h.grid) / 1000 * price;
        m.solar += Math.max(0, h.sol) / 1000 * price;
        m.solarKWh += Math.max(0, h.sol) / 1000;
        m.gridKWh += Math.max(0, h.grid) / 1000;
        m.loadKWh += Math.max(0, h.ac) / 1000;
        m.hours += 1;
    }
    const now = new Date(nowTs);
    const rows = [];
    let firstDay = '', daysCovered = 0;
    for (const mk of Object.keys(months).sort()) {
        const m = months[mk];
        const dayKeys = Object.keys(m.days).sort();
        if (!firstDay) firstDay = dayKeys[0];
        const top3 = (field) => {
            const v = dayKeys.map((dk) => m.days[dk][field]).sort((a, b) => b - a).slice(0, 3);
            return v.length ? v.reduce((s, x) => s + x, 0) / v.length / 1000 : 0;
        };
        const kwWith = top3('with'), kwWithout = top3('without');
        const tWith = tierOf(kwWith, st), tWithout = tierOf(kwWithout, st);
        const y = Number(mk.slice(0, 4)), mo = Number(mk.slice(5, 7));
        const daysInMonth = new Date(y, mo, 0).getDate();
        const share = Math.min(1, dayKeys.length / daysInMonth);
        const peak = (st.tierPrices[tWithout] - st.tierPrices[tWith]) * share;
        const isCurrent = y === now.getFullYear() && mo === now.getMonth() + 1;
        daysCovered += m.hours / 24;
        rows.push({
            month: mk, current: isCurrent, days: dayKeys.length, daysInMonth,
            kwWith: r2(kwWith), kwWithout: r2(kwWithout), tierWith: tWith + 1, tierWithout: tWithout + 1,
            peak: r0(peak), solar: r0(m.solar), shift: r0(m.energy - m.solar), total: r0(peak + m.energy),
            solarKWh: r1(m.solarKWh), gridKWh: r0(m.gridKWh), loadKWh: r0(m.loadKWh)
        });
        tot.energy += m.energy; tot.solar += m.solar; tot.solarKWh += m.solarKWh;
        tot.gridKWh += m.gridKWh; tot.loadKWh += m.loadKWh; tot.peak += peak;
    }
    const costEur = st.items.reduce((s, it) => s + it.eur, 0);
    const costNok = costEur * st.eurNok;
    const saved = tot.peak + tot.energy;
    const remaining = Math.max(0, costNok - saved);
    const perDay = daysCovered > 0 ? saved / daysCovered : 0;
    const daysLeft = perDay > 0 ? remaining / perDay : null;
    const payDate = daysLeft !== null ? new Date(nowTs + daysLeft * 86400000) : null;
    return {
        firstDay, daysCovered: r1(daysCovered),
        costEur: r2(costEur), costNok: r0(costNok),
        saved: r0(saved), peak: r0(tot.peak), solar: r0(tot.solar), shift: r0(tot.energy - tot.solar),
        solarKWh: r0(tot.solarKWh), gridKWh: r0(tot.gridKWh), loadKWh: r0(tot.loadKWh),
        remaining: r0(remaining), paidPct: costNok > 0 ? Math.min(100, r1(saved / costNok * 100)) : 0,
        perDay: r2(perDay), perYear: r0(perDay * 365), perMonth: r0(perDay * 30.4),
        yearsLeft: daysLeft !== null ? r1(daysLeft / 365) : null,
        payDate: payDate ? payDate.getFullYear() + '-' + String(payDate.getMonth() + 1).padStart(2, '0') : '',
        months: rows.reverse()
    };
}

function model(st, nowTs, error) {
    const hours = context.get('hours') || {};
    return {
        topic: 'model',
        payload: Object.assign({ settings: st, defaults: DEFAULTS, error: error || '', updated: new Date(nowTs).toISOString(), hoursCount: Object.keys(hours).length },
            compute(hours, st, nowTs))
    };
}

const nowTs = Date.now();
const action = msg.topic === 'ui' && msg.payload ? String(msg.payload.action || 'open') : '';

if (msg.topic === 'read') {
    const p = parse(msg.payload);
    context.set('hours', p.hours);
    const st = cleanSettings(p.cfg || context.get('settings') || DEFAULTS);
    context.set('settings', st);
    node.status({ fill: 'green', shape: 'dot', text: Object.keys(p.hours).length + ' h of data, ' + new Date(nowTs).toTimeString().slice(0, 5) });
    return [model(st, nowTs), null, null];
}

if (action === 'save') {
    const st = cleanSettings(msg.payload.settings);
    context.set('settings', st);
    return [model(st, nowTs), null, { filename: CFG_FILE, payload: JSON.stringify(st, null, 1) }];
}

if (action === 'reset') {
    const st = cleanSettings(DEFAULTS);
    context.set('settings', st);
    return [model(st, nowTs), null, { filename: CFG_FILE, payload: JSON.stringify(st, null, 1) }];
}

// 'open' / 'refresh' / 'tick': show what is cached, then read the files again
const st = context.get('settings');
return [st ? model(st, nowTs) : null, { topic: 'read', payload: readCmd() }, null];
