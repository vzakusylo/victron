// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `40 Heat pump automations.js` and the embedded `func` for "Heat pump automations"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Local replacements for the Tuya cloud scenes (Smart Life "B…" DHW cycles and "DF…" defrost
//   handling) that control heating and the DHW boiler, moved onto the GX.
// - One MASTER switch turns local control on / off for all rules at once. Master OFF (default)
//   = no rule writes to a device; rules are only evaluated and logged.
// - Each rule has its own mode: 'off' (not evaluated), 'dry' (evaluated, every step logged as
//   "would …", nothing written; default) or 'live' (writes, only while the master is ON).
//   Before a rule goes live, switch the matching Smart Life scene off, otherwise both act.
// Defrost flag:
// - An INTERNAL flag replaces the cloud-only "Voksen heating" Defrost DP. It is set and cleared
//   by the DF / switch / off rules exactly where the cloud scenes set it, and cleared after
//   10 min at the latest (DF safe 10min). It is internal state, not a device, so flag steps run
//   in 'dry' too: the flag then follows what the cloud flag would do.
// Input (msg.topic):
// - 'tick' (inject, every 10 s) -> evaluate all rules, send the page model.
// - 'load' (file in, on start)  -> msg.payload = saved settings JSON.
// - 'ui'   (Automations page)   -> payload { action: 'refresh' | 'master' | 'mode' | 'flag', on, id, mode }.
// Output (5):
// - output 1 -> Automations page (ui_template), msg.payload = page model
// - output 2 -> Tuya node "Heating pump"          { operation: 'SET', dps, set }
// - output 3 -> file node, msg.filename + msg.payload (settings JSON)
// - output 4 -> Tuya node "Off Heating exchange"  { operation: 'SET', dps: 1, set }
// - output 5 -> Tuya node "Boiler valve relay"    { operation: 'SET', dps: 1, set }
// Safety:
// - A rule needs every device it reads CONNECTED with data ≤ 5 min old.
// - Conditions must hold on HOLD consecutive ticks (3 × 10 s); then the rule rests COOLDOWN.
// - A rule's sequence (steps + delays, as in the cloud scene) runs with timers; the same rule does
//   not start again while it runs. Device writes go through one queue, ≥ WRITE_GAP_MS apart.
// - Steps of a live rule are only sent while the master is ON; switching the master OFF stops
//   all running sequences.
// - Settings live in CONFIG_PATH; a missing / broken file means master OFF, all rules 'dry'.
// DPs: hp 1 power, 2 mode (smart / strong / mute), 102 supply, 103 outdoor, 108 DHW tank,
//      115 compressor Hz, 116 fan 1 rpm, 125 heating set point, 132 curve P22 ('1' on / '0' off);
//      valve / bypass DP 1 (true = ON). Valve ON = DHW tank, bypass ON = heat exchanger bypassed.
// Change notes:
// 1. d#123: master switch, per-rule mode, rule B46 mode smart-silent, cloud catalog.
// 2. d#124: one-step rules B42 / B50 / B recovery, rules read several devices, 5 outputs.
// 3. d#125: internal defrost flag (no Voksen heating), sequences with delays, DF rules and all
//    B40 / B42 / B46 / B50 on / switch / off rules; mode rules B46 / B42 smart-silent,
//    B42 powerful-silent and B50 force heating removed (owner: not moved). Tick 10 s.
// ==========================

const CONFIG_PATH = '/data/home/nodered/grid-control-config/heat-pump-automations.json';
const FRESH_MS = 5 * 60 * 1000;
const LOG_MAX = 150;
const MODES = ['off', 'dry', 'live'];
const HOLD = 3;
const WRITE_GAP_MS = 1500;
const FLAG_MAX_MS = 10 * 60 * 1000;
const MIN = 60 * 1000;
const S = 1000;

// ---- step helpers ---------------------------------------------------------
const set = (v) => ({ role: 'hp', dps: 125, set: v, text: 'set point ' + v + ' °C' });
const mode = (m) => ({ role: 'hp', dps: 2, set: m, text: 'mode ' + ({ smart: 'Smart', strong: 'Powerful', mute: 'Silent' })[m] });
const p22 = (on) => ({ role: 'hp', dps: 132, set: on ? '1' : '0', text: 'curve P22 ' + (on ? 'on' : 'off') });
const valve = (on) => ({ role: 'valve', dps: 1, set: on, text: 'valve ' + (on ? 'ON (DHW)' : 'OFF (heating)') });
const bypass = (on) => ({ role: 'bypass', dps: 1, set: on, text: 'bypass ' + (on ? 'ON' : 'OFF') });
const flagStep = (on) => ({ flag: on, text: 'defrost flag ' + (on ? 'ON' : 'OFF') });
const wait = (ms) => ({ delay: ms, text: 'wait ' + (ms >= MIN ? ms / MIN + ' min' : ms / S + ' s') });
const note = (text) => ({ note: text, text: 'notify: ' + text });

const n = (v) => Number(v);
const between = (v, a, b) => n(v) >= a && n(v) <= b;
const hpTxt = (h) => 'set ' + h['125'] + ', supply ' + h['102'] + ', tank ' + h['108'] + ', outdoor ' + h['103'] + ', fan ' + h['116'] + ', ' + h['115'] + ' Hz';
const rel = (d) => (d['1'] === true ? 'ON' : 'OFF');

// ---- rules = Smart Life scenes (read 2026-11-08) ---------------------------
// c = { hp, valve, bypass, flag } (dps objects + internal flag boolean)
const RULES = [
    // Defrost handling (DF scenes) — they own the internal flag
    { id: 'df_exchange_off', cloud: 'DF exchange off', group: 'Defrost',
        name: 'Defrost starts during heating → bypass ON, flag ON',
        when: 'fan 0, compressor > 30 Hz, bypass OFF, supply < 27 °C, outdoor < 14 °C',
        roles: ['hp', 'bypass'], cooldownMs: 3 * MIN,
        check: ({ hp, bypass: b }) => n(hp['116']) === 0 && n(hp['115']) > 30 && b['1'] === false && n(hp['102']) < 27 && n(hp['103']) < 14,
        steps: [bypass(true), flagStep(true)] },
    { id: 'df_exchange_on', cloud: 'DF exchange on 31', group: 'Defrost',
        name: 'Defrost over → bypass OFF, flag OFF after 7 min',
        when: 'bypass ON, fan > 300, supply > 27 °C, set point < 45 °C, curve P22 on',
        roles: ['hp', 'bypass'], cooldownMs: 10 * MIN,
        check: ({ hp, bypass: b }) => b['1'] === true && n(hp['116']) > 300 && n(hp['102']) > 27 && n(hp['125']) < 45 && String(hp['132']) === '1',
        steps: [bypass(false), wait(7 * MIN), flagStep(false)] },
    { id: 'df_switch_to_heating', cloud: 'DF switch to heating', group: 'Defrost',
        name: 'Defrost during DHW → valve to heating, bypass ON, flag ON',
        when: 'fan 0, compressor > 30 Hz, valve ON, outdoor < 14 °C, flag OFF, set point 40 / 42 / 46 / 50',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v, flag }) => n(hp['116']) === 0 && n(hp['115']) > 30 && v['1'] === true && n(hp['103']) < 14 && !flag && [40, 42, 46, 50].includes(n(hp['125'])),
        steps: [note('defrost during DHW'), flagStep(true), valve(false), bypass(true)] },

    // B40 · outdoor −20…−11 °C
    { id: 'b40_on', cloud: 'B40 on <36 -20..-11', group: 'B40 · outdoor −20…−11 °C',
        name: 'B40 start: preheat with bypass',
        when: 'tank < 36, valve OFF, supply > 35, outdoor −20…−11, bypass OFF, set point < 40',
        roles: ['hp', 'valve', 'bypass'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v, bypass: b }) => n(hp['108']) < 36 && v['1'] === false && n(hp['102']) > 35 && between(hp['103'], -20, -11) && b['1'] === false && n(hp['125']) < 40,
        steps: [p22(false), mode('strong'), set(40), bypass(true)] },
    { id: 'b40_switch', cloud: 'B40 switch >37', group: 'B40 · outdoor −20…−11 °C',
        name: 'B40 switch valve to the tank',
        when: 'valve OFF, fan > 250, set point = 40, supply > 37, flag OFF',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v, flag }) => v['1'] === false && n(hp['116']) > 250 && n(hp['125']) === 40 && n(hp['102']) > 37 && !flag,
        steps: [flagStep(true), set(20), wait(MIN), valve(true), set(40), bypass(false)] },
    { id: 'b40_off', cloud: 'B40 off >39', group: 'B40 · outdoor −20…−11 °C',
        name: 'B40 end: valve back to heating',
        when: 'outdoor −20…−11, tank > 39, fan > 300, supply > 38, set point = 40, valve ON',
        roles: ['hp', 'valve'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v }) => between(hp['103'], -20, -11) && n(hp['108']) > 39 && n(hp['116']) > 300 && n(hp['102']) > 38 && n(hp['125']) === 40 && v['1'] === true,
        steps: [set(37), valve(false), wait(4 * S), set(37), valve(false), p22(true)] },

    // B42 · outdoor −10…−5 °C
    { id: 'b42_on', cloud: 'B42 on <41 -10..-5', group: 'B42 · outdoor −10…−5 °C',
        name: 'B42 start: preheat with bypass',
        when: 'outdoor −10…−5, tank < 41, fan > 400, supply > 35, valve OFF, bypass OFF, set point < 40',
        roles: ['hp', 'valve', 'bypass'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v, bypass: b }) => between(hp['103'], -10, -5) && n(hp['108']) < 41 && n(hp['116']) > 400 && n(hp['102']) > 35 && v['1'] === false && b['1'] === false && n(hp['125']) < 40,
        steps: [p22(false), mode('strong'), set(42), bypass(true)] },
    { id: 'b42_switch', cloud: 'B42 switch >39', group: 'B42 · outdoor −10…−5 °C',
        name: 'B42 switch valve to the tank',
        when: 'supply > 39, set point = 42, valve OFF, fan > 300, flag OFF',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v, flag }) => n(hp['102']) > 39 && n(hp['125']) === 42 && v['1'] === false && n(hp['116']) > 300 && !flag,
        steps: [flagStep(true), set(20), wait(MIN), valve(true), set(42), bypass(false)] },
    { id: 'b42_off', cloud: 'B42 off >42', group: 'B42 · outdoor −10…−5 °C',
        name: 'B42 end: set point down, valve back, P22 on',
        when: 'tank > 42, supply > 41, valve ON, set point = 42',
        roles: ['hp', 'valve'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v }) => n(hp['108']) > 42 && n(hp['102']) > 41 && v['1'] === true && n(hp['125']) === 42,
        // cloud also runs the tap-to-run scene "Slowly cool down" before P22 on (not read yet, not included)
        steps: [set(41), wait(10 * S), valve(false), set(41), wait(MIN), set(39), wait(MIN), valve(false), mode('mute'), wait(3 * MIN), p22(true)] },

    // B46 · outdoor −4…1 °C (ran on 7–8 Nov)
    { id: 'b46_on', cloud: 'B46 on <44 -4..1', group: 'B46 · outdoor −4…1 °C',
        name: 'B46 start: preheat with bypass',
        when: 'tank < 44, outdoor −4…1, fan > 300, supply > 30, valve OFF, bypass OFF, set point < 40',
        roles: ['hp', 'valve', 'bypass'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v, bypass: b }) => n(hp['108']) < 44 && between(hp['103'], -4, 1) && n(hp['116']) > 300 && n(hp['102']) > 30 && v['1'] === false && b['1'] === false && n(hp['125']) < 40,
        steps: [p22(false), mode('smart'), set(46), bypass(true)] },
    { id: 'b46_switch', cloud: 'B46 switch >38', group: 'B46 · outdoor −4…1 °C',
        name: 'B46 switch valve to the tank',
        when: 'supply > 38, fan > 40, valve OFF, set point = 46, flag OFF',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v, flag }) => n(hp['102']) > 38 && n(hp['116']) > 40 && v['1'] === false && n(hp['125']) === 46 && !flag,
        steps: [flagStep(true), set(20), wait(MIN), valve(true), set(46), bypass(false)] },
    { id: 'b46_off', cloud: 'B46 off >46 -4..1', group: 'B46 · outdoor −4…1 °C',
        name: 'B46 end: valve back, set point down in steps, P22 on',
        when: 'tank > 46, fan > 400, supply > 46, valve ON, outdoor −4…1, flag OFF, set point = 46',
        roles: ['hp', 'valve'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v, flag }) => n(hp['108']) > 46 && n(hp['116']) > 400 && n(hp['102']) > 46 && v['1'] === true && between(hp['103'], -4, 1) && !flag && n(hp['125']) === 46,
        steps: [set(45), bypass(false), wait(10 * S), set(45), wait(3 * S), valve(false), wait(2 * S), valve(false),
            wait(MIN), set(43), wait(MIN), set(41), wait(MIN), set(39), wait(MIN), set(38), wait(MIN), set(35), mode('mute'), p22(true)] },

    // B50 · outdoor > 1 °C
    { id: 'b50_on', cloud: 'B50 on <47 >1', group: 'B50 · outdoor > 1 °C',
        name: 'B50 start: preheat with bypass',
        when: 'tank < 47, outdoor > 1, valve OFF, flag OFF, bypass OFF, heat pump on',
        roles: ['hp', 'valve', 'bypass'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v, bypass: b, flag }) => n(hp['108']) < 47 && n(hp['103']) > 1 && v['1'] === false && !flag && b['1'] === false && hp['1'] === true && n(hp['125']) !== 50,
        steps: [p22(false), set(50), bypass(true)] },
    { id: 'b50_switch_warm', cloud: 'B50 switch >47 >0', group: 'B50 · outdoor > 1 °C',
        name: 'B50 switch valve to the tank (outdoor > 0)',
        when: 'valve OFF, set point = 50, outdoor > 0, tank < 49, flag OFF, supply > 47',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v, flag }) => v['1'] === false && n(hp['125']) === 50 && n(hp['103']) > 0 && n(hp['108']) < 49 && !flag && n(hp['102']) > 47,
        steps: [note('B50 switch'), flagStep(true), set(20), wait(MIN), valve(true), set(50), bypass(false)] },
    { id: 'b50_switch_cold', cloud: 'B50 switch >45 <1', group: 'B50 · outdoor > 1 °C',
        name: 'B50 switch valve to the tank (outdoor < 1)',
        when: 'supply > 45, set point = 50, valve OFF, outdoor < 1, flag OFF, tank < 49',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v, flag }) => n(hp['102']) > 45 && n(hp['125']) === 50 && v['1'] === false && n(hp['103']) < 1 && !flag && n(hp['108']) < 49,
        steps: [flagStep(true), set(20), wait(MIN), valve(true), set(50), bypass(false)] },
    { id: 'b50_off', cloud: 'B50 off >49', group: 'B50 · outdoor > 1 °C',
        name: 'B50 end: Silent, set point 25, valve back, P22 on',
        when: 'tank > 49, valve ON',
        roles: ['hp', 'valve'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v }) => n(hp['108']) > 49 && v['1'] === true,
        steps: [mode('mute'), set(25), valve(false), wait(10 * S), valve(false), set(25), wait(10 * S), valve(false), wait(10 * S), flagStep(true), wait(10 * S), flagStep(false), p22(true)] },
    { id: 'b50_preheat_bypass', cloud: 'B50 preheat exchange off', group: 'B50 · outdoor > 1 °C',
        name: 'B50 preheat: bypass ON',
        when: 'set point = 50, valve OFF, bypass OFF, tank < 50',
        roles: ['hp', 'valve', 'bypass'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v, bypass: b }) => n(hp['125']) === 50 && v['1'] === false && b['1'] === false && n(hp['108']) < 50,
        steps: [bypass(true)] },

    // B42 mode (kept)
    { id: 'b42_mode_smart', cloud: 'B42 mode silent-smart <44', group: 'B42 · outdoor −10…−5 °C',
        name: 'B42: Silent → Smart when supply < 44 °C',
        when: 'mode Silent, set point = 42, supply < 44',
        roles: ['hp'], cooldownMs: 10 * MIN,
        check: ({ hp }) => hp['2'] === 'mute' && n(hp['125']) === 42 && n(hp['102']) < 44,
        steps: [mode('smart')] },

    // Boiler safety
    { id: 'b_recovery_valve_off', cloud: 'B recovery off', group: 'Boiler safety',
        name: 'Recovery: valve back to heating',
        when: 'valve ON while the set point is a heating value (33 / 35 / 36 / 37)',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v }) => v['1'] === true && [33, 35, 36, 37].includes(n(hp['125'])),
        steps: [valve(false)] }
];
const OUT = { hp: 1, bypass: 3, valve: 4 };

// Not moved (owner decision 2026-11-08) and not active as local rules
const NOT_MOVED = [
    { cloud: 'B46 mode smart-silent >48', what: 'Smart, set 46, supply > 48 → Silent' },
    { cloud: 'B42 mode smart-silent >6a', what: 'Smart, set 42, supply > 44, valve ON → Silent' },
    { cloud: 'B42 mode powerful-silent >45', what: 'Smart / Powerful, set 42, supply > 45, fan > 300 → Silent' },
    { cloud: 'B42 mode silent-smart <45', what: 'Silent → Smart below 45 °C supply' },
    { cloud: 'B50 force heating mode', what: 'set 50, work mode Cooling → Heating' },
    { cloud: 'HP silent >0', what: 'outdoor > 0, flag OFF, set < 40, valve OFF → Silent' }
];
// Smart Life runs on 7–8 Nov 2026 (outdoor −5…+1 °C), for the page
const RUNS = { 'B46 on <44 -4..1': 6, 'B46 switch >38': 15, 'B46 off >46 -4..1': 8, 'DF exchange off': 45, 'DF exchange on 31': 49, 'DF switch to heating': 6, 'DF safe 10min': 59 };
const RUNS_FAILED = { 'B46 switch >38': 4, 'B46 off >46 -4..1': 3 };

// ---- state ------------------------------------------------------------------
const now = Date.now();
const st = flow.get('heatPump') || {};
// Shared objects live in node context from the first run on, so the timer callbacks
// (runStep / pump) and this invocation always work on the same objects.
function ctx(key, init) { if (context.get(key) === undefined) context.set(key, init); return context.get(key); }
let settings = ctx('settings', { master: false, modes: {} });
const runtime = ctx('runtime', {});
const log = ctx('log', []);
const flag = ctx('flag', { on: false, since: 0, by: '' });
const queue = ctx('queue', []);
const seqs = ctx('seqs', {});   // ruleId -> { idx, total, startedAt, live, token }

function modeOf(id) { return MODES.includes(settings.modes[id]) ? settings.modes[id] : 'dry'; }
function ready(role) {
    const dev = st[role];
    return !!(dev && dev.state === 'CONNECTED' && dev.lastData && now - dev.lastData <= FRESH_MS);
}
function addLog(kind, text, t) {
    log.unshift({ t: t || Date.now(), kind, text });
    if (log.length > LOG_MAX) log.length = LOG_MAX;
}
function saveMsg() { return { filename: CONFIG_PATH, payload: JSON.stringify(settings, null, 2) }; }
function persist() {
    context.set('settings', settings); context.set('runtime', runtime); context.set('log', log);
    context.set('flag', flag); context.set('queue', queue); context.set('seqs', seqs);
}
function setFlag(on, by) {
    if (flag.on === on) return;
    flag.on = on; flag.since = Date.now(); flag.by = by;
    addLog('flag', 'defrost flag ' + (on ? 'ON' : 'OFF') + ' (' + by + ')');
}
function model() {
    const dev = (role) => { const d = st[role] || {}; return { state: d.state || 'UNKNOWN', age: d.lastData ? Math.round((now - d.lastData) / 1000) : null }; };
    return {
        updated: new Date(now).toISOString(),
        master: !!settings.master,
        devices: { hp: dev('hp'), valve: dev('valve'), bypass: dev('bypass') },
        flag: { on: flag.on, since: flag.since, by: flag.by, maxMin: FLAG_MAX_MS / MIN },
        hold: HOLD,
        rules: RULES.map((r) => {
            const rt = runtime[r.id] || {}; const sq = seqs[r.id];
            return { id: r.id, name: r.name, cloud: r.cloud, group: r.group, when: r.when,
                then: r.steps.map((s) => s.text).join(' → '), mode: modeOf(r.id), ok: !!rt.ok, streak: rt.streak || 0,
                detail: rt.detail || '', lastFire: rt.lastFire || 0, lastText: rt.lastText || '',
                runs: RUNS[r.cloud] || 0, runsFailed: RUNS_FAILED[r.cloud] || 0,
                running: sq ? { idx: sq.idx, total: sq.total, live: sq.live } : null };
        }),
        notMoved: NOT_MOVED,
        queue: queue.length,
        log
    };
}
function send(out, m) {
    const arr = [null, null, null, null, null]; arr[out] = m; node.send(arr);
}
// Device write queue: one SET every WRITE_GAP_MS
function pump() {
    if (context.get('pumping')) return;
    const q = context.get('queue') || [];
    if (!q.length) return;
    context.set('pumping', true);
    const item = q.shift(); context.set('queue', q);
    if (context.get('settings').master) {
        send(OUT[item.role], { payload: { operation: 'SET', dps: item.dps, set: item.set } });
        node.log('Heat pump automations: ' + item.rule + ' -> ' + item.role + ' DP ' + item.dps + ' = ' + item.set);
    } else {
        const lg = context.get('log') || []; lg.unshift({ t: Date.now(), kind: 'warn', text: item.rule + ': ' + item.text + ' dropped (master OFF)' }); context.set('log', lg);
    }
    setTimeout(() => { context.set('pumping', false); pump(); }, WRITE_GAP_MS);
}
// Sequence runner (timers). Each step: device write (queued if live, logged if dry), flag, note or delay.
function runStep(rule, token) {
    const sq = (context.get('seqs') || {})[rule.id];
    if (!sq || sq.token !== token) return;
    const lg = context.get('log') || [];
    const settingsNow = context.get('settings') || {};
    if (sq.live && !settingsNow.master) {
        lg.unshift({ t: Date.now(), kind: 'warn', text: rule.cloud + ': sequence stopped (master OFF) at step ' + (sq.idx + 1) + '/' + sq.total });
        context.set('log', lg); const all = context.get('seqs'); delete all[rule.id]; context.set('seqs', all); return;
    }
    if (sq.idx >= rule.steps.length) {
        lg.unshift({ t: Date.now(), kind: 'info', text: rule.cloud + ': sequence done' });
        context.set('log', lg); const all = context.get('seqs'); delete all[rule.id]; context.set('seqs', all); return;
    }
    const s = rule.steps[sq.idx];
    let next = 0;
    if (s.delay) { next = s.delay; }
    else if (s.flag !== undefined) {
        const f = context.get('flag') || { on: false };
        if (f.on !== s.flag) { f.on = s.flag; f.since = Date.now(); f.by = rule.cloud; context.set('flag', f);
            lg.unshift({ t: Date.now(), kind: 'flag', text: 'defrost flag ' + (s.flag ? 'ON' : 'OFF') + ' (' + rule.cloud + ')' }); }
    } else if (s.note) {
        lg.unshift({ t: Date.now(), kind: 'info', text: rule.cloud + ': ' + s.note });
    } else if (sq.live) {
        const q = context.get('queue') || []; q.push({ rule: rule.cloud, role: s.role, dps: s.dps, set: s.set, text: s.text }); context.set('queue', q);
        lg.unshift({ t: Date.now(), kind: 'write', text: rule.cloud + ': ' + s.text + ' (step ' + (sq.idx + 1) + '/' + sq.total + ')' });
        pump();
    } else {
        lg.unshift({ t: Date.now(), kind: 'dry', text: rule.cloud + ': would ' + s.text + ' (step ' + (sq.idx + 1) + '/' + sq.total + ')' });
    }
    if (lg.length > LOG_MAX) lg.length = LOG_MAX;
    context.set('log', lg);
    const all = context.get('seqs'); all[rule.id].idx = sq.idx + 1; context.set('seqs', all);
    setTimeout(() => runStep(rule, token), next);
}

// ---- load ---------------------------------------------------------------------
if (msg.topic === 'load') {
    try {
        const s = JSON.parse(String(msg.payload || '{}'));
        settings = { master: s.master === true, modes: {} };
        for (const r of RULES) if (s.modes && MODES.includes(s.modes[r.id])) settings.modes[r.id] = s.modes[r.id];
        addLog('info', 'settings loaded: master ' + (settings.master ? 'ON' : 'OFF'));
    } catch (e) {
        settings = { master: false, modes: {} };
        addLog('warn', 'settings file unreadable, master OFF: ' + e.message);
    }
    persist();
    node.status({ fill: settings.master ? 'green' : 'grey', shape: 'dot', text: 'master ' + (settings.master ? 'ON' : 'OFF') });
    return [{ payload: model() }, null, null, null, null];
}

// ---- ui -----------------------------------------------------------------------
if (msg.topic === 'ui') {
    const p = msg.payload || {};
    if (p.action === 'master' && typeof p.on === 'boolean') {
        settings.master = p.on;
        if (!p.on) { for (const id of Object.keys(seqs)) if (seqs[id].live) delete seqs[id]; queue.length = 0; }
        addLog('info', 'master switched ' + (p.on ? 'ON — live rules may write' : 'OFF — no local writes, live sequences stopped'));
        node.log('Heat pump automations: master ' + (p.on ? 'ON' : 'OFF'));
        persist();
        node.status({ fill: p.on ? 'green' : 'grey', shape: 'dot', text: 'master ' + (p.on ? 'ON' : 'OFF') });
        return [{ payload: model() }, null, saveMsg(), null, null];
    }
    if (p.action === 'mode') {
        const r = RULES.find((x) => x.id === p.id);
        if (!r || !MODES.includes(p.mode)) { node.warn('Heat pump automations: bad mode request ' + JSON.stringify(p)); return null; }
        settings.modes[r.id] = p.mode;
        addLog('info', r.cloud + ': mode → ' + p.mode);
        persist();
        return [{ payload: model() }, null, saveMsg(), null, null];
    }
    if (p.action === 'flag' && p.on === false) {
        setFlag(false, 'reset on the page');
        persist();
        return [{ payload: model() }, null, null, null, null];
    }
    return [{ payload: model() }, null, null, null, null];
}

// ---- tick: evaluate every rule ----------------------------------------------------
// DF safe 10min: the flag never stays ON longer than FLAG_MAX_MS
if (flag.on && now - flag.since >= FLAG_MAX_MS) setFlag(false, 'DF safe 10min');

for (const r of RULES) {
    const md = modeOf(r.id);
    const rt = runtime[r.id] || { streak: 0, lastFire: 0 };
    runtime[r.id] = rt;
    if (md === 'off') { rt.ok = false; rt.streak = 0; rt.detail = 'rule off'; continue; }
    if (seqs[r.id]) { rt.ok = false; rt.streak = 0; rt.detail = 'running step ' + (seqs[r.id].idx + 1) + '/' + seqs[r.id].total; continue; }
    const notReady = r.roles.filter((role) => !ready(role));
    if (notReady.length) { rt.ok = false; rt.streak = 0; rt.detail = notReady.join(', ') + ' not connected / stale'; continue; }
    const c = { hp: (st.hp && st.hp.dps) || {}, valve: (st.valve && st.valve.dps) || {}, bypass: (st.bypass && st.bypass.dps) || {}, flag: flag.on };
    rt.ok = !!r.check(c);
    rt.detail = hpTxt(c.hp) + ', valve ' + rel(c.valve) + ', bypass ' + rel(c.bypass) + ', flag ' + (flag.on ? 'ON' : 'OFF');
    rt.streak = rt.ok ? (rt.streak || 0) + 1 : 0;
    if (rt.streak >= HOLD && now - (rt.lastFire || 0) >= r.cooldownMs) {
        const live = md === 'live' && settings.master;
        rt.lastFire = now; rt.streak = 0;
        rt.lastText = (live ? 'started' : 'dry-run' + (md === 'live' ? ' (master OFF)' : '')) + ': ' + r.steps.map((s) => s.text).join(' → ');
        addLog(live ? 'start' : 'dry', r.cloud + ': conditions met (' + rt.detail + ') → ' + (live ? 'start' : 'would start') + ' ' + r.steps.length + ' steps');
        const token = now + ':' + r.id;
        seqs[r.id] = { idx: 0, total: r.steps.length, startedAt: now, live, token };
        persist();
        runStep(r, token);
    }
}
persist();
const liveCount = RULES.filter((r) => modeOf(r.id) === 'live').length;
const running = Object.keys(context.get('seqs') || {}).length;
node.status({ fill: settings.master ? 'green' : 'grey', shape: running ? 'dot' : 'ring',
    text: 'master ' + (settings.master ? 'ON' : 'OFF') + ' · live ' + liveCount + '/' + RULES.length + ' · flag ' + (flag.on ? 'ON' : 'OFF') + (running ? ' · running ' + running : '') });
return [{ payload: model() }, null, null, null, null];
