// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `40 Heat pump automations.js` and the embedded `func` for "Heat pump automations"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Local replacements for all Tuya cloud scenes of the heat pump (Smart Life "B…" DHW cycles
//   and modes, "DF…" defrost handling, "HP…" scenes), moved onto the GX.
// - One MASTER switch ("Local control") turns local control on / off for all rules at once.
//   Master OFF (default) = no rule writes to a device; rules are only evaluated and logged.
// - Each rule has its own mode, shown on the page as Off / Test / On:
//   'off' (not evaluated), 'dry' = Test (evaluated, every step logged as "would …", nothing
//   written) or 'live' = On (writes, only while the master is ON). Default: 'dry' for the
//   rules of d#125, 'off' for the rules added in d#126 (rule.def). The page can also set all
//   rules at once. Before a rule goes On, switch the matching Smart Life scene off.
// Log:
// - Every event (rule start, each step, write result, settings, flag) is one JSON line in
//   LOG_DIR/YYYY-MM-DD.jsonl (local date of the GX), written by output 6. Events of one
//   sequence share `run`, so the "Automation log" page (42 / 43) groups them like the Smart
//   Life log. Each device write is checked VERIFY_MS later against the value the device
//   reports: kind 'ok' or 'fail'.
// Defrost flag:
// - An INTERNAL flag replaces the cloud-only "Voksen heating" Defrost DP. It is set and cleared
//   by the DF / switch / off rules exactly where the cloud scenes set it, and cleared after
//   10 min at the latest (DF safe 10min). It is internal state, not a device, so flag steps run
//   in 'dry' too: the flag then follows what the cloud flag would do.
// Input (msg.topic):
// - 'tick' (inject, every 10 s) -> evaluate all rules, send the page model.
// - 'load' (file in, on start)  -> msg.payload = saved settings JSON.
// - 'ui'   (Automations page)   -> payload { action: 'refresh' | 'master' | 'mode' | 'modeAll' | 'flag', on, id, mode }.
// Output (7):
// - output 1 -> Automations page (ui_template), msg.payload = page model
// - output 2 -> Tuya node "Heating pump"          { operation: 'SET', dps, set }
// - output 3 -> file node, msg.filename + msg.payload (settings JSON)
// - output 4 -> Tuya node "Off Heating exchange"  { operation: 'SET', dps: 1, set }
// - output 5 -> Tuya node "Boiler valve relay"    { operation: 'SET', dps: 1, set }
// - output 6 -> file node "Append automation log" (msg.filename, msg.payload = JSON line) and
//               "Automation log" (42), msg.event = the event object
// - output 7 -> file in node "Read automation settings" (reload after an empty context, d#131)
// Safety:
// - A rule needs every device it reads CONNECTED with data ≤ 5 min old.
// - Conditions must hold on HOLD consecutive ticks (3 × 10 s); then the rule rests COOLDOWN.
// - A rule's sequence (steps + delays, as in the cloud scene) runs with timers; the same rule does
//   not start again while it runs. Device writes go through one queue, ≥ WRITE_GAP_MS apart.
// - Steps of a live rule are only sent while the master is ON; switching the master OFF stops
//   all running sequences.
// - Settings live in CONFIG_PATH; a missing / broken file means master OFF, rules at their default.
// DPs: hp 1 power, 2 mode (smart / strong / mute), 5 work mode, 15 faults (bit 0 = Er03),
//      102 supply, 103 outdoor, 108 DHW tank,
//      115 compressor Hz, 116 fan 1 rpm, 125 heating set point, 132 curve P22 ('1' on / '0' off);
//      valve / bypass DP 1 (true = ON). Valve ON = DHW tank, bypass ON = heat exchanger bypassed.
// Change notes:
// 1. d#123: master switch, per-rule mode, rule B46 mode smart-silent, cloud catalog.
// 2. d#124: one-step rules B42 / B50 / B recovery, rules read several devices, 5 outputs.
// 3. d#125: internal defrost flag (no Voksen heating), sequences with delays, DF rules and all
//    B40 / B42 / B46 / B50 on / switch / off rules; mode rules B46 / B42 smart-silent,
//    B42 powerful-silent and B50 force heating removed (owner: not moved). Tick 10 s.
// 4. d#126: all heat pump scenes: the 6 mode rules back plus HP Er03 restart, HP power <-16,
//    HP smart -15..-7 (new rules default Off). Page modes Off / Test / On, all rules at once.
//    Day log files + write check (ok / fail) for the Automation log page.
// 5. d#127 (review of PR #11): a new node instance drops running sequences and the write queue
//    (their timers are gone after a deploy / restart); watchdog for overdue steps and a stuck
//    write gap; a live sequence stops, and its queued writes are dropped, once the rule is no
//    longer On (On → Test / Off).
// 6. d#128: B50 on / B50 preheat do not start during a defrost or DEFROST_QUIET_MIN after it
//    (outdoor sensor reads high; the cloud B50 on started a DHW cycle that way at 11:29 on 9 Nov).
// d#230: missing or stale telemetry cannot create a defrost edge; bypassed supply is not proof of recovery.
// 7. d#129: B42 off includes the steps of the scene "Slowly cool down" (set 39 → 38 → 37).
// 8. d#130: DHW controller (tank by outdoor curve, one state machine, settings on the page,
//    docs/heat-pump-dhw-controller.md). While it is On, the B* rules, their mode rules,
//    DF switch to heating, B recovery and HP silent >0 are treated as Off (DHW_REPLACES).
// 9. d#131: after a node start without settings in the context, the settings file is read again
//    (output 7 → "Read automation settings"); On Start sets `needLoad`.
// 10. d#134: the 23 rules the DHW controller replaced are deleted (B40 / B42 / B46 / B50 with
//    their mode rules, DF switch to heating, B recovery off, HP silent >0; owner request). Left:
//    DF exchange off / on, HP Er03 restart and the two dead HP mode rules. The tank is heated only
//    by the DHW controller now: with it Off or Test nothing starts a DHW cycle.
//    Every tick also writes flow.dhwView (= the controller's page model) for the boiler curve
//    on the Heat Pump page. DHW cycle without preheat (owner): start = P22 off, Silent, bypass
//    OFF, set point 20 → compressor stops → valve to the tank → set point ≤ return + gap. After a
//    defrost during DHW the same stop → valve sequence runs again.
// 12. d#140: the two HP mode rules whose cloud conditions are never true (HP power <-16,
//    HP smart -15..-7) are deleted (owner). Left: DF exchange off / on and HP Er03 restart.
// 17. d#145: pump faults (DP 15 bits → Er codes) are logged as kind 'error' when they appear (with the
//    valve / Hz / temperatures at that moment) and 'info' when they clear; heat pump, valve or bypass
//    without data for 2 min → 'error', back → 'info'. An aborted DHW cycle ends with kind 'stop'.
// 16. d#144 (Er03 at the valve switch, 11 Nov 06:56–13:05, 4 cycles lost): new state VALVE — valve ON
//    with the curve still at P23 0 for VALVE_TRAVEL_S, then the boiler curve; Er03 seen in VALVE / DHW
//    ends the cycle at once (valve back), and an early abort (< 5 min) is tried again after 15 min
//    (max 2 in a row, settings.dhwRetry); max duration counts only the DHW heating time (defrosts
//    do not), with a hard cap of max + 30 min.
// 15. d#143: dhwModel().plan = tank target and expected end of the running cycle (tank rise of the
//    last 6 min, least-squares, capped by the max duration) for the dashed line on the history chart.
// 14. d#143: the P23 start and ramp limit use the warmest of return / tank (and supply at the
//    switch) + gap: after the valve switch the loop holds tank water, and a curve below it kept the
//    compressor off (first live cycle, 10 Nov 14:17–14:26).
// 13. d#142: DHW on the pump's own curve (docs/heat-pump-dhw-curve-plan.md): P22 stays on; stop =
//    P23 0, boiler = P24 12 + P23 computed from the wanted supply, ramp +1 per minute while supply −
//    return ≤ gap, end = heating curve back (settings.heatCurve, stored from the pump outside cycles).
//    No DP 125 writes, no RAMPDOWN. Compressor protection in the cold and on high Hz / A / discharge.
//    DF rules only while no DHW cycle runs. settings.dhwLastEnd keeps the interval across restarts.
// 11. d#138: the DHW controller panel moved to the Heat Pump page (35); its requests arrive here
//    through "Heat pump command" (37) as the same 'ui' actions. flow.dhwView also carries `master`
//    and is written at once after a DHW mode / settings change.
// 18. d#166: heating power controller (HEAT_ID 'heat', Off / Test / On on the Heat Pump page): outside
//    DHW cycles and defrosts it steps the pump mode Silent ⇄ Smart (⇄ Powerful if allowed) from the
//    d#201: one band around the curve point replaces lagUp / overC / gapMax: below point − bandDown one step up
//    (Smart, then curve +1 °C), above point + bandUp one step down (boost first, then mode); in Smart with the
//    supply at the point → back to Silent; at most one step per stepMin (≥ 10 min; the samples are
//    cleared after a step). In On it owns the mode
//    outside DHW cycles: a mode set by hand (or Powerful while not allowed) is corrected at the next step.
//    d#167 (review of PR #20): gapMin dropped, null DPs ignored, publishView() for flow.dhwView.
// 20. d#169: DHW waits for the defrost: the next one is forecast from the recorded starts (settings.defrostStarts,
//    median interval); no start when it is due within defrostLead min, and after a defrost (≤ 60 min) not before
//    the supply is back at the heating set point − supplyReady. So a cycle starts right after a defrost.
// 22. d#171: the heating controller has two levers: power mode and a curve boost (P23 +1 … +maxBoost above the
//    owner's curve, written to the pump). Up = mode first, then boost; down = boost first, then mode. The followed
//    point is the owner's curve (settings.heatCurve), so the boost does not move it; a boosted P23 is not stored as the
//    owner's curve; Off / DHW cycle end the boost (owner's P23 back).
// 23. d#172: the curve boost is in °C of the curve's set point (+1 °C per step, maxBoost 4 °C) and is written as P23 and,
//    above P23 40, P24 (curveCoeffs); the DHW cycle uses the same: a boiler goal above P23 40 raises its P24.
// 24. d#173: progress of a DHW cycle = % of the way from the start tank to the target (page + why); a defrost after
//    defrostEndPct (30 %) ends the cycle and plans the next one defrostNextMin (60) later (settings.dhwRetry n 0).
// 25. d#174 (owner): an aborted DHW cycle (Er03, valve switched back from outside / did not switch) sets settings.dhwBlock:
//    no new DHW start until 'Allow DHW again' on the Heat Pump page (ui action dhwResume); the d#144 retries are removed.
// 26. d#175: stuck supply kick (kickTick): supply flat (≤ 0.5 °C) for kickMin below its point − 1 in Silent with the
//    compressor running → Smart for kickSec, then Silent; heating (heating controller) and DHW cycles (DHW controller).
//    TH3: kicks are now heating-only; a pending or active DHW cycle ends a kick and clears its samples.
// 27. d#176 (owner): min interval 1 h; in the defrost season (a defrost < 3 h ago) a DHW cycle starts only within
//    afterDefrostWinMin (30) after the supply recovered from a defrost, so the cycle runs between two defrosts; in the
//    cold the heating-first check (heating lags its curve → no DHW) stays.
// 28. d#177 (review of PR #21): holds other than Off / DHW keep the curve boost (no boosted curve stored as the owner's);
//    the defrost season comes from settings.defrostStarts; a Test cycle never sets dhwBlock; no decisions during a kick.
// 21. d#170: defrosts are ignored by the curve following: the heating controller pauses (keeps its samples, shifts
//    them over the pause) during a defrost, the quiet time and until the supply is back at set − supplyReady; the DHW
//    'heating lags' check skips that time too; in a DHW cycle the tank-rise forecast restarts after a defrost.
// 19. d#168: On Start sets lastDefrost = now and clears the outdoor average outside a cycle: after a deploy the
//    outdoor sensor may still be warm from a defrost (14 Nov 08:42 a DHW cycle started at a read 17.8 °C).
// 22. d#195: the pump's own outdoor value. Its curve is computed from a steady ambient value (−1 °C on 20 Nov, DP 125 36 °C
//    at P23 39 / P24 4) while the sensor DP 103 swings −8 … +50 °C. pumpOutdoor() = P23 − (set − 20) / (P24 / 10) is latched
//    in context.pumpOut while it is trustworthy (curve on, valve on heating, bypass off, no defrost / quiet time, P23 / P24
//    unchanged 2 min, set not clamped) and used for 3 h: heating lag and the heating controller's point, and the DHW boiler
//    curve (kept for the whole cycle). Without a valid value the old rules stay (average / live sensor); texts say "fallback".
//    flow.dhwView.pumpOut carries it to the Heat Pump page (34).
// INIT — the node's On Start code is `40 Heat pump automations.init.js` (synced into `initialize`).
// 20. d#161: default boiler curve = a straight line [[-20, 37], [1, 50]] (40 °C at -15, 50 °C at 1;
//    owner). The page sets only the two ends; a saved curve of more points still works.
// ==========================

const CONFIG_PATH = '/data/home/nodered/grid-control-config/heat-pump-automations.json';
const FRESH_MS = 5 * 60 * 1000;
const LOG_MAX = 150;
const MODES = ['off', 'dry', 'live'];
const HOLD = 3;
const WRITE_GAP_MS = 1500;
const FLAG_MAX_MS = 10 * 60 * 1000;
const LOG_DIR = '/data/home/nodered/grid-control-logs/automations';
const VERIFY_MS = 15 * 1000;
const STALE_MS = 60 * 1000;
const DEFROST_QUIET_MIN = 15;
const MIN = 60 * 1000;
const S = 1000;

// ---- step helpers ---------------------------------------------------------
const mode = (m) => ({ role: 'hp', dps: 2, set: m, text: 'mode ' + ({ smart: 'Smart', strong: 'Powerful', mute: 'Silent' })[m] });
const p22 = (on) => ({ role: 'hp', dps: 132, set: on ? '1' : '0', text: 'curve P22 ' + (on ? 'on' : 'off') });
const valve = (on) => ({ role: 'valve', dps: 1, set: on, text: 'valve ' + (on ? 'ON (DHW)' : 'OFF (heating)') });
const bypass = (on) => ({ role: 'bypass', dps: 1, set: on, text: 'bypass ' + (on ? 'ON' : 'OFF') });
const power = (on) => ({ role: 'hp', dps: 1, set: on, text: 'heat pump ' + (on ? 'ON' : 'OFF') });
const workMode = (m) => ({ role: 'hp', dps: 5, set: m, text: 'work mode ' + ({ heat: 'Heating', cool: 'Cooling', wth: 'DHW' })[m] });
const flagStep = (on) => ({ flag: on, text: 'defrost flag ' + (on ? 'ON' : 'OFF') });
const wait = (ms) => ({ delay: ms, text: 'wait ' + (ms >= MIN ? ms / MIN + ' min' : ms / S + ' s') });
const note = (text) => ({ note: text, text: 'notify: ' + text });

const n = (v) => Number(v);
function dhwMeasurement(value) {
    return value === null || value === undefined || value === '' || typeof value === 'boolean' ? NaN : n(value);
}
function defrostReading(hp) {
    const fan = dhwMeasurement(hp['116']), hz = dhwMeasurement(hp['115']);
    if (!Number.isFinite(fan) || fan < 0 || !Number.isFinite(hz) || hz < 0) return null;
    return fan === 0 && hz > 30;
}
const between = (v, a, b) => n(v) >= a && n(v) <= b;
const hpTxt = (h) => 'set ' + h['125'] + ', supply ' + h['102'] + ', tank ' + h['108'] + ', outdoor ' + h['103'] + ', fan ' + h['116'] + ', ' + h['115'] + ' Hz';
const rel = (d) => (d['1'] === true ? 'ON' : 'OFF');

// ---- rules = Smart Life scenes (read 2026-11-08) ---------------------------
// c = { hp, valve, bypass, flag } (dps objects + internal flag boolean)
const RULES = [
    // Defrost handling (DF scenes) — they own the internal flag
    { id: 'df_exchange_off', cloud: 'DF exchange off', group: 'Defrost',
        name: 'Defrost starts during heating → bypass ON, flag ON',
        when: 'fan 0, compressor > 30 Hz, bypass OFF, supply < 27 °C, outdoor < 14 °C, no DHW cycle running',
        roles: ['hp', 'bypass'], cooldownMs: 3 * MIN,
        check: ({ hp, bypass: b, dhwIdle }) => dhwIdle && defrostReading(hp) === true && b['1'] === false && dhwMeasurement(hp['102']) < 27 && dhwMeasurement(hp['103']) < 14,
        steps: [bypass(true), flagStep(true)] },
    { id: 'df_exchange_on', cloud: 'DF exchange on 31', group: 'Defrost',
        name: 'Defrost over → bypass OFF, flag OFF after 7 min',
        when: 'bypass ON, fan > 300, supply > 27 °C, set point < 45 °C, curve P22 on, no DHW cycle running',
        roles: ['hp', 'bypass'], cooldownMs: 10 * MIN,
        check: ({ hp, bypass: b, dhwIdle }) => dhwIdle && b['1'] === true && dhwMeasurement(hp['116']) > 300 && dhwMeasurement(hp['102']) > 27 && dhwMeasurement(hp['125']) < 45 && String(hp['132']) === '1',
        steps: [bypass(false), wait(7 * MIN), flagStep(false)] },

    // Heat pump (HP scenes)
    { id: 'hp_er03_restart', cloud: 'HP Er03 restart', group: 'Heat pump', def: 'off',
        name: 'Er03 water flow failure on DHW → valve back, restart the pump',
        when: 'fault Er03 (water flow), valve ON',
        roles: ['hp', 'valve'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v }) => (n(hp['15']) & 1) === 1 && v['1'] === true,
        // cloud also disables the scene "zz boiler 50 on <47 >1" (already off, not included)
        // d#142: no set point 31 any more; the DHW controller ends its cycle and writes the heating curve back
        steps: [valve(false), wait(30 * S), valve(false), power(false), wait(MIN), power(true), bypass(false), p22(true)] },
];
const OUT = { hp: 1, bypass: 3, valve: 4 };
const OUT_LOG = 5;

// Load and UI messages keep their direct writes. All other topics follow the tick path.
const nodeContext = context;
let pending = msg.topic === 'load' || msg.topic === 'ui' ? null : new Map();
try {
    return runAutomations(pending ? {
        get: key => pending?.has(key) ? pending.get(key) : nodeContext.get(key),
        set: (key, value) => {
            if (pending) pending.set(key, value);
            else nodeContext.set(key, value);
        }
    } : nodeContext);
} finally {
    const batch = pending;
    pending = null; // Timer callbacks from this tick must read and write the current store.
    if (batch?.size) nodeContext.set([...batch.keys()], [...batch.values()]);
}

function runAutomations(context) {
// #include lib/heat-pump/curves.js

// #include lib/heat-pump/heating-decide.js

// Smart Life runs on 7–8 Nov 2026 (outdoor −5…+1 °C), for the page
const RUNS = { 'B46 on <44 -4..1': 6, 'B46 switch >38': 15, 'B46 off >46 -4..1': 8, 'DF exchange off': 45, 'DF exchange on 31': 49, 'DF switch to heating': 6, 'DF safe 10min': 59 };
const RUNS_FAILED = { 'B46 switch >38': 4, 'B46 off >46 -4..1': 3 };

// ---- state ------------------------------------------------------------------
const now = Date.now();
const st = flow.get('heatPump') || {};
function ctx(key, init) {
    const value = context.get(key);
    if (value !== undefined) return value;
    context.set(key, init);
    return init;
}
let settings = ctx('settings', { master: false, modes: {} });
const runtime = ctx('runtime', {});
ctx('log', []);
const flag = ctx('flag', { on: false, since: 0, by: '' });
// A new node instance (deploy of this node, Node-RED restart) has no timers, but the context is
// kept: the node's On Start code (`40 Heat pump automations.init.js`) drops
// running sequences and queued writes and leaves a note here, which is logged once.
const bootNote = context.get('bootNote');
if (bootNote) { context.set('bootNote', null); logEvent({ kind: bootNote.dropped ? 'warn' : 'info', text: bootNote.text }); }
// The context can also come back empty after a deploy (seen 9 Nov 13:40, d#130): then read the
// settings file again (output 7 → file node "Read automation settings" → topic 'load').
// Until it arrives the defaults apply: local control OFF.
if (context.get('needLoad')) {
    context.set('needLoad', false);
    logEvent({ kind: 'warn', text: 'settings missing after the node start → reading the settings file again' });
    node.send([null, null, null, null, null, null, { topic: 'load', filename: CONFIG_PATH }]);
}
const queue = ctx('queue', []);
const seqs = ctx('seqs', {});   // ruleId -> { idx, total, startedAt, live, token, nextAt }

function pad(x) { return String(x).padStart(2, '0'); }
function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function ruleById(id) { return RULES.find((r) => r.id === id); }
function modeOf(id) {
    const s = context.get('settings') || settings;
    if (s.modes && MODES.includes(s.modes[id])) return s.modes[id];
    if (id === DHW_ID) return 'off';
    if (id === HEAT_ID) return 'dry';
    const r = ruleById(id);
    return (r && r.def) || 'dry';
}
function dhwCfgNow() { const s = context.get('settings') || settings; return dhwCfg(s.dhw); }
function ready(role) {
    const dev = st[role];
    return !!(dev && dev.state === 'CONNECTED' && dev.lastData && now - dev.lastData <= FRESH_MS);
}
// One log event: kept in context for the Automations page and appended to the day file
// LOG_DIR/YYYY-MM-DD.jsonl (output 6) for the Automation log page.
// e = { kind, text, rule?, cloud?, run?, live? }
function logEvent(e) {
    e.t = e.t || Date.now();
    const lg = context.get('log') || [];
    lg.unshift(e);
    if (lg.length > LOG_MAX) lg.length = LOG_MAX;
    context.set('log', lg);
    const arr = [null, null, null, null, null, null];
    arr[OUT_LOG] = { topic: 'log', filename: LOG_DIR + '/' + dayKey(e.t) + '.jsonl', payload: JSON.stringify(e) + '\n', event: e };
    node.send(arr);
}
function saveMsg() { return { filename: CONFIG_PATH, payload: JSON.stringify(settings, null, 2) }; }
function persist() {
    context.set('settings', settings); context.set('runtime', runtime);
    context.set('flag', flag); context.set('queue', queue); context.set('seqs', seqs);
}
function setFlag(on, by, extra) {
    const f = context.get('flag') || flag;
    if (f.on === on) return;
    f.on = on; f.since = Date.now(); f.by = by;
    context.set('flag', f);
    logEvent(Object.assign({ kind: 'flag', text: 'defrost flag ' + (on ? 'ON' : 'OFF') + ' (' + by + ')' }, extra || {}));
}
// task 4: a defrost ended while the tank may need heat → DHW can start at once (if the option is on); expires after 60 min
function armAfterDefrost() {
    const d = context.get('dhw') || {};
    if (!d.state || d.state === 'HEATING') context.set('afterDefrostAt', Date.now());
}
function model() {
    const dev = (role) => { const d = st[role] || {}; return { state: d.state || 'UNKNOWN', age: d.lastData ? Math.round((now - d.lastData) / 1000) : null }; };
    const f = context.get('flag') || flag;
    const sq = context.get('seqs') || {};
    const shadow = flow.get(HP_SHADOW_KEY) || {};
    return {
        updated: new Date(now).toISOString(),
        updatedMs: now,
        master: !!settings.master,
        devices: { hp: dev('hp'), valve: dev('valve'), bypass: dev('bypass') },
        flag: { on: f.on, since: f.since, by: f.by, maxMin: FLAG_MAX_MS / MIN },
        hold: HOLD,
        counts: { off: RULES.filter((r) => modeOf(r.id) === 'off').length, dry: RULES.filter((r) => modeOf(r.id) === 'dry').length, live: RULES.filter((r) => modeOf(r.id) === 'live').length },
        rules: RULES.map((r) => {
            const rt = runtime[r.id] || {}; const s = sq[r.id];
            return { id: r.id, name: r.name, cloud: r.cloud, group: r.group, when: r.when,
                then: r.steps.map((x) => x.text).join(' → '), mode: modeOf(r.id), ok: !!rt.ok, streak: rt.streak || 0,
                detail: rt.detail || '', lastFire: rt.lastFire || 0, lastText: rt.lastText || '',
                runs: RUNS[r.cloud] || 0, runsFailed: RUNS_FAILED[r.cloud] || 0,
                running: s ? { idx: s.idx, total: s.total, live: s.live } : null };
        }),
        dhw: dhwModel(),
        queue: (context.get('queue') || []).length,
        shadowDisagreements: shadow.disagreements || 0,
        shadowSameWriterSupersessions: shadow.sameWriterSupersessions || 0,
        log: context.get('log') || []
    };
}
function send(out, m) {
    const arr = [null, null, null, null, null, null]; arr[out] = m; node.send(arr);
}
// #include lib/heat-pump/mode-confirm.js
// #include lib/heat-pump/arbiter.js
// #include lib/heat-pump/arbiter-shadow.js

// Device write queue: one SET every WRITE_GAP_MS; every write is checked VERIFY_MS later
// against the value the device reports (ok / fail in the log, like the Smart Life log).
function pump() {
    if (context.get('pumping')) return;
    const q = context.get('queue') || [];
    if (!q.length) return;
    context.set('pumping', true); context.set('pumpAt', Date.now());
    const item = q.shift(); context.set('queue', q);
    const dp = String(item.dps);
    const invalidCurveWrite = item.role === 'hp' &&
        ((dp === '133' && !inCurveRange(item.set, P23_MIN, P23_MAX)) ||
         (dp === '134' && !inCurveRange(item.set, P24_MIN, P24_MAX)));
    if (invalidCurveWrite) {
        logEvent({ kind: 'warn', rule: item.rule, cloud: item.cloud, run: item.run, live: true,
            text: 'heat pump DP ' + dp + ' = ' + item.set + ' refused (invalid heating curve value)' });
    } else if ((context.get('cancelledShowerRuns') || []).includes(item.run)) {
        logEvent({ kind: 'warn', rule: item.rule, cloud: item.cloud, run: item.run, live: true, text: item.text + ' dropped (forced cycle cancelled)' });
    } else if (!item.force && modeOf(item.rule) !== 'live') {
        logEvent({ kind: 'warn', rule: item.rule, cloud: item.cloud, run: item.run, live: true, text: item.text + ' dropped (rule no longer On)' });
    } else if ((context.get('settings') || {}).master && !modeBlocked(item)) {
        const verifyMode = isModeWrite(item) ? startModeVerification(item) : null;
        shadowCheck(item, 'dequeue', Date.now());
        send(OUT[item.role], { payload: { operation: 'SET', dps: item.dps, set: item.set } });
        node.log('Heat pump automations: ' + item.cloud + ' -> ' + item.role + ' DP ' + item.dps + ' = ' + item.set);
        const verify = verifyMode || (() => {
            if ((context.get('cancelledShowerRuns') || []).includes(item.run)) {
                logEvent({ kind: 'stop', rule: item.rule, cloud: item.cloud, run: item.run, live: true,
                    verificationSuperseded: true,
                    text: item.text + ' — verification superseded by forced-cycle stop' });
                return;
            }
            const dev = (flow.get('heatPump') || {})[item.role];
            const v = dev && dev.dps ? dev.dps[item.dps] : undefined;
            const good = String(v) === String(item.set);
            logEvent({ kind: good ? 'ok' : 'fail', rule: item.rule, cloud: item.cloud, run: item.run, live: true,
                text: item.text + (good ? ' — confirmed' : ' — NOT confirmed, device reports ' + v) });
        });
        setTimeout(() => {
            shadowCheck(item, 'verify', Date.now());
            verify();
        }, VERIFY_MS);
    } else if (!(context.get('settings') || {}).master) {
        logEvent({ kind: 'warn', rule: item.rule, cloud: item.cloud, run: item.run, live: true, text: item.text + ' dropped (master OFF)' });
    }
    setTimeout(() => { context.set('pumping', false); pump(); }, WRITE_GAP_MS);
}
function endSeq(rule) { const all = context.get('seqs') || {}; delete all[rule.id]; context.set('seqs', all); }
// Sequence runner (timers). Each step: device write (queued if live, logged if dry),
// flag, note or delay.
function runStep(rule, token) {
    const sq = (context.get('seqs') || {})[rule.id];
    if (!sq || sq.token !== token) return;
    const base = { rule: rule.id, cloud: rule.cloud, run: token, live: sq.live };
    if (sq.live && !(context.get('settings') || {}).master) {
        logEvent(Object.assign({ kind: 'stop', text: 'sequence stopped (master OFF) at step ' + (sq.idx + 1) + '/' + sq.total }, base));
        endSeq(rule); return;
    }
    if (sq.live && modeOf(rule.id) !== 'live') {
        logEvent(Object.assign({ kind: 'stop', text: 'sequence stopped (rule no longer On) at step ' + (sq.idx + 1) + '/' + sq.total }, base));
        endSeq(rule); return;
    }
    if (modeOf(rule.id) === 'off') {
        logEvent(Object.assign({ kind: 'stop', text: 'sequence stopped (rule switched Off) at step ' + (sq.idx + 1) + '/' + sq.total }, base));
        endSeq(rule); return;
    }
    if (sq.idx >= rule.steps.length) {
        logEvent(Object.assign({ kind: 'done', text: 'sequence done (' + sq.total + ' steps)' }, base));
        endSeq(rule); return;
    }
    const s = rule.steps[sq.idx];
    const stepTxt = ' (step ' + (sq.idx + 1) + '/' + sq.total + ')';
    let next = 0;
    if (s.delay) {
        next = s.delay;
        logEvent(Object.assign({ kind: 'step', text: s.text + stepTxt }, base));
    } else if (s.flag !== undefined) {
        setFlag(s.flag, rule.cloud, base);
    } else if (s.note) {
        logEvent(Object.assign({ kind: 'step', text: 'notify: ' + s.note + stepTxt }, base));
    } else if (sq.live) {
        const q = context.get('queue') || [];
        q.push(shadowTag({ rule: rule.id, cloud: rule.cloud, run: token, role: s.role, dps: s.dps, set: s.set, text: s.text }, 'recovery', Date.now()));
        context.set('queue', q);
        logEvent(Object.assign({ kind: 'write', text: s.text + stepTxt }, base));
        pump();
    } else {
        logEvent(Object.assign({ kind: 'dry', text: 'would ' + s.text + stepTxt }, base));
    }
    const all = context.get('seqs'); all[rule.id].idx = sq.idx + 1; all[rule.id].nextAt = Date.now() + next; context.set('seqs', all);
    setTimeout(() => runStep(rule, token), next);
}
function stopLive(reason) {
    cancelModeRule();
    const all = context.get('seqs') || {};
    for (const id of Object.keys(all)) if (all[id].live) {
        const r = ruleById(id);
        logEvent({ kind: 'stop', rule: id, cloud: r ? r.cloud : id, run: all[id].token, live: true, text: 'sequence stopped (' + reason + ') at step ' + (all[id].idx + 1) + '/' + all[id].total });
        delete all[id];
    }
    context.set('seqs', all);
}
const MODE_LABEL = { off: 'Off', dry: 'Test', live: 'On' };
// DP 15 fault bits of the PW58280 controller (same list as 34)
const FAULT_LABELS = ['Er03', 'Er04', 'Er05', 'Er06', 'Er09', 'Er10', 'Er12', 'Er14', 'Er15', 'Er16',
    'Er18', 'Er20', 'Er21', 'Er23', 'Er26', 'Er27', 'Er29', 'Er32', 'Er33', 'Er34', 'Er42', 'Er62',
    'Er63', 'Er64', 'Er66', 'Er67', 'Er68', 'Er69', 'Er70'];
const FAULT_TEXT = { Er03: 'water flow failure' };

// #include lib/heat-pump/dhw-helpers.js
// #include lib/heat-pump/dhw-tick.js

// #include lib/heat-pump/heating-tick.js

// #include lib/heat-pump/kick.js

// #include lib/heat-pump/idle.js

// ---- load ---------------------------------------------------------------------
if (msg.topic === 'load') {
    const previousModes = [HEAT_ID, DHW_ID, ...RULES.map(r => r.id)].map(id => [id, modeOf(id)]);
    try {
        const s = JSON.parse(String(msg.payload || '{}'));
        const curve = s.heatCurve;
        const validCurve = curve && validHeatCurve(curve.p23, curve.p24);
        settings = { master: s.master === true, modes: {}, dhw: dhwCfg(s.dhw),
            heatCurve: validCurve ? curve : null,
            dhwLastEnd: Number(s.dhwLastEnd) || 0, heat: heatCfg(heatMigrate(s.heat)), dhwLastDone: Number(s.dhwLastDone) || 0,
            dhwBlock: s.dhwBlock && Number.isFinite(s.dhwBlock.at) ? { at: s.dhwBlock.at, why: String(s.dhwBlock.why || '') } : null,
            dhwRetry: s.dhwRetry && Number.isFinite(s.dhwRetry.at) ? s.dhwRetry : null,
            defrostStarts: Array.isArray(s.defrostStarts) ? s.defrostStarts.filter(Number.isFinite).slice(-8) : [],
            showerHistory: Array.isArray(s.showerHistory) ? s.showerHistory.filter(e => e && Number.isFinite(e.at) && Number.isFinite(e.motionAt) && Number.isFinite(e.dropC) && e.dropC >= 2).slice(-64) : [],
            showerLastStart: s.showerLastStart && typeof s.showerLastStart.id === 'string' && Number.isFinite(s.showerLastStart.at) ? s.showerLastStart : null,
            heatWarm: warmCfg(s.heatWarm),
            heatBandSaved: Number.isFinite(s.heatBandSaved) && s.heatBandSaved >= 2 && s.heatBandSaved <= 18 ? s.heatBandSaved : null,
            dhwManual: s.dhwManual && Number.isFinite(s.dhwManual.at) && Number.isFinite(s.dhwManual.until)
                && s.dhwManual.until > s.dhwManual.at && s.dhwManual.until - s.dhwManual.at <= MANUAL_QUEUE_MS ? { at: s.dhwManual.at, until: s.dhwManual.until } : null,
            dhwUsage: usageCfg(s.dhwUsage), dhwUsageLastSeen: Number.isFinite(s.dhwUsageLastSeen) ? s.dhwUsageLastSeen : Number.isFinite(s.dhwUsageLastVisit) ? s.dhwUsageLastVisit : 0 };
        for (const r of RULES) if (s.modes && MODES.includes(s.modes[r.id])) settings.modes[r.id] = s.modes[r.id];
        for (const id of [DHW_ID, HEAT_ID]) if (s.modes && MODES.includes(s.modes[id])) settings.modes[id] = s.modes[id];
        persist();
        if (!settings.master) cancelModeRule();
        else for (const [id, previous] of previousModes) if (modeOf(id) !== previous) cancelModeRule(id);
        context.set('settingsLoaded', true); context.set('saveHeldNoted', false);
        logEvent({ kind: 'setting', text: 'settings loaded: local control ' + (settings.master ? 'ON' : 'OFF') });
        if (curve != null && !validCurve) {
            logEvent({ kind: 'warn', text: 'stored heating curve invalid (P23 ' + JSON.stringify(curve.p23)
                + ' / P24 ' + JSON.stringify(curve.p24) + ') → ignored, re-captured from the pump' });
        }
        if (heatMigrateNote) { logEvent({ kind: 'setting', rule: HEAT_ID, cloud: HEAT_NAME, text: heatMigrateNote }); heatMigrateNote = ''; }
    } catch (e) {
        settings = { master: false, modes: {} };
        persist();
        cancelModeRule();
        // an unreadable file is replaced by the next change made on the dashboard (the defaults are what runs now)
        context.set('settingsLoaded', true); context.set('saveHeldNoted', false);
        logEvent({ kind: 'warn', text: 'settings file unreadable, local control OFF: ' + e.message });
    }
    node.status({ fill: settings.master ? 'green' : 'grey', shape: 'dot', text: 'master ' + (settings.master ? 'ON' : 'OFF') });
    return [{ payload: model() }, null, null, null, null, null];
}

// ---- ui -----------------------------------------------------------------------
if (msg.topic === 'ui') {
    const p = msg.payload || {};
    if (p.action === 'utcpLog') {
        if (msg.fromUtcp !== true) return null;   // only the UTCP node may write "UTCP: …" lines
        logEvent({ kind: p.kind === 'warn' ? 'warn' : 'info', text: ('UTCP: ' + String(p.text || '')).slice(0, 200) });
        return null;
    }
    if (p.action === 'heatWarm') {
        if (typeof p.on !== 'boolean') { node.warn('Heat pump automations: bad warm-up value'); return null; }
        let text;
        if (p.on) {
            const deltaC = p.deltaC === undefined ? WARM_DEFAULTS.deltaC : Number(p.deltaC);
            const hours = p.hours === undefined ? WARM_DEFAULTS.hours : Number(p.hours);
            if (!Number.isFinite(deltaC) || deltaC < WARM_LIMITS.deltaC[0] || deltaC > WARM_LIMITS.deltaC[1]
                || !Number.isFinite(hours) || hours < WARM_LIMITS.hours[0] || hours > WARM_LIMITS.hours[1]) {
                node.warn('Heat pump automations: warm-up out of range'); return null;
            }
            settings.heatWarm = { at: now, until: now + Math.round(hours * 3600 * 1000), deltaC: Math.round(deltaC * 2) / 2 };
            text = 'warm-up started: heating point +' + settings.heatWarm.deltaC + ' °C for ' + hours + ' h';
        } else {
            settings.heatWarm = null;
            text = 'warm-up cancelled: following your heating curve again';
        }
        persist();
        logEvent({ kind: 'setting', rule: HEAT_ID, cloud: HEAT_NAME, text });
        publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'dhwForceRun') {
        if (typeof p.on !== 'boolean') { node.warn('Heat pump automations: bad force run value'); return null; }
        const d = dhwState();
        let text;
        if (p.on) {
            if (d.state !== 'HEATING') { node.warn('Heat pump automations: force run ignored, a DHW cycle is running'); return null; }
            settings.dhwManual = { at: now, until: now + MANUAL_QUEUE_MS };
            text = 'forced boiler run requested: starts as soon as defrost, faults and the DHW block allow (expires in '
                + Math.round(MANUAL_QUEUE_MS / 3600000) + ' h)';
        } else {
            settings.dhwManual = null;
            text = 'forced boiler run cancelled';
            if (d.showerStart && d.showerStart.type === 'manual') {
                d.showerStopRequested = true;
                cancelShowerWrites(d.run);
                context.set('dhw', d);
                text += '; the running forced cycle returns to heating on the next tick';
            }
        }
        persist();
        logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text }); publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'dhwShowerForce') {
        if (typeof p.on !== 'boolean') { node.warn('Heat pump automations: bad shower force value'); return null; }
        settings.dhw = dhwCfg({ showerForce: p.on }, settings.dhw);
        if (!p.on) {
            const s = showerState(); s.demand = null; s.samples = [];
            if (s.episode) s.episode.cancelled = true;
            const d = dhwState();
            if (d.showerStart && d.showerStart.type !== 'manual') {
                d.showerStopRequested = true;
                cancelShowerWrites(d.run);
                for (const e of settings.showerHistory || []) if (e.at === d.showerStart.evidenceAt) e.cancelled = true;
            }
            context.set('shower', s);
        }
        persist();
        logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: p.on ? 'shower early starts enabled; existing safety gates retained'
            : 'shower early starts disabled; any running forced cycle will return to heating on the next tick' });
        publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'master' && typeof p.on === 'boolean') {
        settings.master = p.on;
        persist();
        if (!p.on) { stopLive('local control OFF'); context.set('queue', []); }
        logEvent({ kind: 'setting', text: 'local control switched ' + (p.on ? 'ON — rules set to On write to the devices' : 'OFF — no local writes, running sequences stopped') });
        node.log('Heat pump automations: master ' + (p.on ? 'ON' : 'OFF'));
        node.status({ fill: p.on ? 'green' : 'grey', shape: 'dot', text: 'master ' + (p.on ? 'ON' : 'OFF') });
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'mode' && p.id === DHW_ID) {
        if (!MODES.includes(p.mode)) { node.warn('Heat pump automations: bad DHW mode ' + JSON.stringify(p)); return null; }
        if (modeOf(DHW_ID) !== p.mode) cancelModeRule(DHW_ID);
        settings.modes[DHW_ID] = p.mode;
        persist();
        logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: 'controller set to ' + MODE_LABEL[p.mode]
            + (p.mode !== 'live' ? ' — no other rule heats the tank now' : '') });
        publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'mode' && p.id === HEAT_ID) {
        if (!MODES.includes(p.mode)) { node.warn('Heat pump automations: bad heating mode ' + JSON.stringify(p)); return null; }
        if (modeOf(HEAT_ID) !== p.mode) cancelModeRule(HEAT_ID);
        settings.modes[HEAT_ID] = p.mode;
        const h = heatState(); h.lastStep = 0; h.samples = []; context.set('heat', h);
        persist();
        logEvent({ kind: 'setting', rule: HEAT_ID, cloud: HEAT_NAME, text: 'controller set to ' + MODE_LABEL[p.mode] });
        publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'heatSet' && p.cfg && typeof p.cfg === 'object') {
        const before = JSON.stringify(settings.heat || heatCfg({}));
        settings.heat = heatCfg(p.cfg, settings.heat);
        persist();
        const after = JSON.stringify(settings.heat);
        logEvent({ kind: 'setting', rule: HEAT_ID, cloud: HEAT_NAME, text: before === after ? 'settings unchanged (values out of range are ignored)' : 'settings saved: ' + after });
        publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'dhwResume') {
        const b = settings.dhwBlock;
        settings.dhwBlock = null;
        persist();
        logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: 'DHW allowed again' + (b ? ' (blocked since ' + new Date(b.at).toTimeString().slice(0, 5) + ': ' + b.why + ')' : '') });
        publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'dhwSet' && p.cfg && typeof p.cfg === 'object') {
        const before = JSON.stringify(dhwCfgNow());
        settings.dhw = dhwCfg(p.cfg, dhwCfgNow());
        persist();
        const after = JSON.stringify(settings.dhw);
        logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: before === after ? 'settings unchanged (values out of range are ignored)' : 'settings saved: ' + after });
        publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'mode') {
        const r = ruleById(p.id);
        if (!r || !MODES.includes(p.mode)) { node.warn('Heat pump automations: bad mode request ' + JSON.stringify(p)); return null; }
        if (modeOf(r.id) !== p.mode) cancelModeRule(r.id);
        settings.modes[r.id] = p.mode;
        persist();
        logEvent({ kind: 'setting', rule: r.id, cloud: r.cloud, text: 'rule set to ' + MODE_LABEL[p.mode] });
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'modeAll') {
        if (!MODES.includes(p.mode)) { node.warn('Heat pump automations: bad modeAll request ' + JSON.stringify(p)); return null; }
        for (const r of RULES) {
            if (modeOf(r.id) !== p.mode) cancelModeRule(r.id);
            settings.modes[r.id] = p.mode;
        }
        persist();
        logEvent({ kind: 'setting', text: 'all ' + RULES.length + ' rules: ' + MODE_LABEL[p.mode] });
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'flag' && p.on === false) {
        setFlag(false, 'reset on the page');
        return [{ payload: model() }, null, null, null, null, null];
    }
    return [{ payload: model() }, null, null, null, null, null];
}

// ---- tick: evaluate every rule ----------------------------------------------------
// DF safe 10min: the flag never stays ON longer than FLAG_MAX_MS
if (flag.on && now - flag.since >= FLAG_MAX_MS) setFlag(false, 'DF safe 10min');

// Defrost sign (fan 0 while the compressor runs > 30 Hz): during a defrost the outdoor sensor
// (DP 103) heats up to 30–47 °C and stays high for minutes after it. Rules that start on
// "outdoor > 1" (B50 on / preheat) must not start then (seen 2026-11-09 11:29 in the cloud).
const exchangerInCircuit = ready('bypass') && ((st.bypass && st.bypass.dps) || {})['1'] === false;
{
    const hpd = (st.hp && st.hp.dps) || {};
    const inDef = ready('hp') ? defrostReading(hpd) : null;
    const wasDef = context.get('inDefrost');
    if (inDef) context.set('lastDefrost', now);
    // d#169: defrost starts (edge), kept in the settings file for the next-defrost forecast
    // d#170: supply just before the defrost — the recovery ends when the supply is back there (or at the set point)
    const supply = dhwMeasurement(hpd['102']);
    if (inDef === false && !wasDef && exchangerInCircuit && !context.get('bypassWasOn')
        && Number.isFinite(supply) && dhwMeasurement(hpd['116']) > 0 && dhwMeasurement(hpd['115']) > 0) {
        context.set('supBefore', supply);
        context.set('supBeforeAt', st.hp.lastData);
    }
    context.set('bypassWasOn', !exchangerInCircuit);
    if (inDef && !wasDef) {
        const beforeAt = context.get('supBeforeAt');
        context.set('preDefSupply', beforeAt && now - beforeAt <= FRESH_MS ? context.get('supBefore') : undefined);
        context.set('defrostSince', now);
        settings.defrostStarts = (settings.defrostStarts || []).filter((x) => now - x < 12 * 3600 * 1000).concat([now]).slice(-8);
        saveSettingsFile();
    }
    if (wasDef && inDef === null) {
        context.set('defrostGap', true);
        // The supply-recovery timeout is not evidence that an unobserved defrost ended.
        if (!context.get('defrostGapWarned') && now - context.get('lastDefrost') >= 60 * MIN) {
            context.set('defrostGapWarned', true);
            logEvent({ kind: 'warn', text: 'Defrost exit still unconfirmed after 60 min: waiting for valid fan and compressor readings' });
        }
    }
    else if (inDef !== null) {
        if (wasDef && !inDef) {
            // After a gap the actual end is unknown; start the quiet period at the first confirmed exit.
            if (context.get('defrostGap')) context.set('lastDefrost', now);
            armAfterDefrost();
        }
        context.set('defrostGap', false);
        context.set('defrostGapWarned', false);
        context.set('inDefrost', inDef);
    }
}
const recentDefrost = !!context.get('inDefrost') || now - (context.get('lastDefrost') || 0) < DEFROST_QUIET_MIN * MIN;
// d#176: recoveredAt = when the recovery after the last defrost ended (start window for DHW)
// d#170: the supply drop of a defrost and its recovery are not a lag of the curve. From a defrost until the
// supply is back at the heating set − supplyReady (at most 60 min after it) the heating controller and the
// DHW "heating lags" check ignore supply − curve; the heating controller keeps its samples from before.
const defRecovering = (() => {
    const hpd = (st.hp && st.hp.dps) || {};
    const last = context.get('lastDefrost') || 0;
    if (recentDefrost) return true;
    if (!last || now - last >= 60 * MIN) return false;
    if (!ready('hp') || !exchangerInCircuit) return true;
    const sup = dhwMeasurement(hpd['102']), set = dhwMeasurement(hpd['125']);
    const supplyReady = ((settings.dhw || {}).supplyReady !== undefined ? settings.dhw.supplyReady : DHW_DEFAULTS.supplyReady);
    const pre = Number(context.get('preDefSupply'));
    const goal = Number.isFinite(pre) ? Math.min(set - supplyReady, pre - 0.5) : set - supplyReady;
    return !(Number.isFinite(sup) && Number.isFinite(goal) && sup >= goal);
})();

// d#145: pump faults (DP 15, Er codes) and lost devices as events of their own (kind 'error' when they
// appear, 'info' when they clear) — for the Automation log, the e-mail alerts (47) and the history
{
    const hpd = (st.hp && st.hp.dps) || {};
    const vd = (st.valve && st.valve.dps) || {}, bd = (st.bypass && st.bypass.dps) || {};
    const scene = 'valve ' + (vd['1'] === true ? 'DHW' : 'heating') + ', bypass ' + (bd['1'] === true ? 'ON' : 'OFF') + ', ' + hpd['115'] + ' Hz, fan ' + hpd['116']
        + ', supply ' + hpd['102'] + ' / return ' + hpd['101'] + ' °C, tank ' + hpd['108'] + ' °C, DHW ' + ((context.get('dhw') || {}).state || '?');
    const fl = Number(hpd['15']);
    if (ready('hp') && Number.isFinite(fl)) {
        const prev = context.get('faults');
        if (prev === undefined) context.set('faults', fl);
        else if (fl !== prev) {
            const fs0 = context.get('faultSince') || {};
            for (let i = 0; i < FAULT_LABELS.length; i++) {
                const bit = 1 << i, code = FAULT_LABELS[i], desc = FAULT_TEXT[code] ? ' (' + FAULT_TEXT[code] + ')' : '';
                if ((fl & bit) && !(prev & bit)) { fs0[code] = now; logEvent({ kind: 'error', rule: 'hp_fault', cloud: 'Heat pump fault', text: code + desc + ' appeared — ' + scene }); }
                if (!(fl & bit) && (prev & bit)) { logEvent({ kind: 'info', rule: 'hp_fault', cloud: 'Heat pump fault', text: code + desc + ' cleared' + (fs0[code] ? ' after ' + Math.round((now - fs0[code]) / S) + ' s' : '') }); delete fs0[code]; }
            }
            context.set('faultSince', fs0); context.set('faults', fl);
        }
    }
    const down = context.get('devDown') || {};
    for (const [role, label] of [['hp', 'heat pump'], ['valve', 'boiler valve relay'], ['bypass', 'bypass relay']]) {
        const ok = ready(role), r = down[role] || { since: 0, logged: false };
        if (!ok) {
            if (!r.since) r.since = now;
            if (!r.logged && now - r.since >= 2 * MIN) { r.logged = true; logEvent({ kind: 'error', rule: 'hp_device', cloud: 'Device', text: label + ' not connected / no data for 2 min (state ' + ((st[role] || {}).state || '?') + ')' }); }
        } else {
            if (r.logged) logEvent({ kind: 'info', rule: 'hp_device', cloud: 'Device', text: label + ' connected again after ' + Math.round((now - r.since) / MIN) + ' min' });
            r.since = 0; r.logged = false;
        }
        down[role] = r;
    }
    context.set('devDown', down);
}

// Watchdog: a sequence whose next step is overdue by STALE_MS lost its timer → drop it;
// a write gap that never ended → release the queue.
for (const id of Object.keys(seqs)) {
    const sq = seqs[id];
    if (sq.nextAt && now - sq.nextAt > STALE_MS) {
        const r = ruleById(id);
        logEvent({ kind: 'warn', rule: id, cloud: r ? r.cloud : id, run: sq.token, live: sq.live, text: 'sequence dropped: step ' + (sq.idx + 1) + '/' + sq.total + ' overdue (timer lost)' });
        delete seqs[id];
    }
}
if (context.get('pumping') && now - (context.get('pumpAt') || 0) > STALE_MS) {
    context.set('pumping', false);
    logEvent({ kind: 'warn', text: 'write queue released (gap timer lost)' });
    pump();
}

for (const r of RULES) {
    const md = modeOf(r.id);
    const rt = runtime[r.id] || { streak: 0, lastFire: 0 };
    runtime[r.id] = rt;
    if (md === 'off') { rt.ok = false; rt.streak = 0; rt.detail = 'rule off'; continue; }
    if (seqs[r.id]) { rt.ok = false; rt.streak = 0; rt.detail = 'running step ' + (seqs[r.id].idx + 1) + '/' + seqs[r.id].total; continue; }
    const notReady = r.roles.filter((role) => !ready(role));
    if (notReady.length) { rt.ok = false; rt.streak = 0; rt.detail = notReady.join(', ') + ' not connected / stale'; continue; }
    const c = { hp: (st.hp && st.hp.dps) || {}, valve: (st.valve && st.valve.dps) || {}, bypass: (st.bypass && st.bypass.dps) || {}, flag: flag.on, recentDefrost,
        dhwIdle: !context.get('dhw') || context.get('dhw').state === 'HEATING' };
    rt.ok = !!r.check(c);
    rt.detail = hpTxt(c.hp) + ', valve ' + rel(c.valve) + ', bypass ' + rel(c.bypass) + ', flag ' + (flag.on ? 'ON' : 'OFF');
    rt.streak = rt.ok ? (rt.streak || 0) + 1 : 0;
    if (rt.streak >= HOLD && now - (rt.lastFire || 0) >= r.cooldownMs) {
        const live = md === 'live' && settings.master;
        rt.lastFire = now; rt.streak = 0;
        rt.lastText = (live ? 'started' : 'test run' + (md === 'live' ? ' (local control OFF)' : '')) + ': ' + r.steps.map((s) => s.text).join(' → ');
        const token = now + ':' + r.id;
        seqs[r.id] = { idx: 0, total: r.steps.length, startedAt: now, live, token };
        persist();
        logEvent({ kind: live ? 'start' : 'test', rule: r.id, cloud: r.cloud, run: token, live,
            text: 'conditions met (' + rt.detail + ') → ' + (live ? 'start' : 'test, would start') + ' ' + r.steps.length + ' steps' });
        runStep(r, token);
    }
}
if (context.get('defRecPrev') && !defRecovering && !recentDefrost) context.set('recoveredAt', now);
context.set('defRecPrev', defRecovering || recentDefrost);
pumpOutTick();
dhwTick();
heatTick();
kickTick();
idleTick();
// d#134: the Heat Pump page (34 / 35) draws the boiler curve next to the heating curve
publishView();
persist();
const liveCount = RULES.filter((r) => modeOf(r.id) === 'live').length;
const running = Object.keys(context.get('seqs') || {}).length;
node.status({ fill: settings.master ? 'green' : 'grey', shape: running ? 'dot' : 'ring',
    text: 'master ' + (settings.master ? 'ON' : 'OFF') + ' · on ' + liveCount + '/' + RULES.length + ' · flag ' + ((context.get('flag') || flag).on ? 'ON' : 'OFF') + (running ? ' · running ' + running : '') });
return [{ payload: model() }, null, null, null, null, null];
}
