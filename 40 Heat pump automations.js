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
//    10-min averages of supply − heating set point (lag) and supply − return (gap): lag below −lagUp
//    and gap < gapMax → one step up; supply above the set point + overC, gap > gapMax + 1 or the
//    current ≥ ampPct of 9.67 A → one step down; at most one step per stepMin (≥ 10 min; the samples are
//    cleared after a step). Supply − return ≤ gapMax = the supply rises smoothly. In On it owns the mode
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
// 21. d#170: defrosts are ignored by the curve following: the heating controller pauses (keeps its samples, shifts
//    them over the pause) during a defrost, the quiet time and until the supply is back at set − supplyReady; the DHW
//    'heating lags' check skips that time too; in a DHW cycle the tank-rise forecast restarts after a defrost.
// 19. d#168: On Start sets lastDefrost = now and clears the outdoor average outside a cycle: after a deploy the
//    outdoor sensor may still be warm from a defrost (14 Nov 08:42 a DHW cycle started at a read 17.8 °C).
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
        check: ({ hp, bypass: b, dhwIdle }) => dhwIdle && n(hp['116']) === 0 && n(hp['115']) > 30 && b['1'] === false && n(hp['102']) < 27 && n(hp['103']) < 14,
        steps: [bypass(true), flagStep(true)] },
    { id: 'df_exchange_on', cloud: 'DF exchange on 31', group: 'Defrost',
        name: 'Defrost over → bypass OFF, flag OFF after 7 min',
        when: 'bypass ON, fan > 300, supply > 27 °C, set point < 45 °C, curve P22 on, no DHW cycle running',
        roles: ['hp', 'bypass'], cooldownMs: 10 * MIN,
        check: ({ hp, bypass: b, dhwIdle }) => dhwIdle && b['1'] === true && n(hp['116']) > 300 && n(hp['102']) > 27 && n(hp['125']) < 45 && String(hp['132']) === '1',
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

// ---- DHW controller settings (d#130, d#142: docs/heat-pump-dhw-curve-plan.md) ----------
const DHW_ID = 'dhw';
const DHW_NAME = 'DHW controller';
const UNIT_MAX_A = 9.67;   // nameplate PW030-DKZLRS-A
const DHW_DEFAULTS = {
    curve: [[-20, 37], [1, 50]],   // outdoor °C → tank target °C; d#161: a straight line, 40 °C at -15, 50 °C at 1
    frostLimit: -20,     // below: no DHW by the heat pump (electric heater only)
    hyst: 3,             // start when tank < target − hyst
    gap: 5,              // DHW: curve supply ≤ return + gap while the ramp runs
    gapRamp: true,       // raise the boiler P23 1 per minute while supply − return ≤ gap
    supplyAdd: 4,        // wanted DHW supply = tank target + supplyAdd
    maxSupply: 55,       // wanted supply cap
    boilerP24: 12,       // boiler curve coefficient (1.2 °C per °C); P23 is computed per cycle
    minIntervalH: 2,     // at most one DHW cycle per … h
    maxMin: 60,          // max DHW cycle …
    maxMinCold: 30,      // … at outdoor ≤ coldLimit
    coldLimit: -10,      // at or below: Silent only, supply ≤ coldCap, coldIntervalH, maxMinCold, heating first
    coldCap: 46,         // wanted supply cap at outdoor ≤ coldLimit
    coldIntervalH: 3,    // min interval at outdoor ≤ coldLimit
    lagC: 2,             // heating lags = 30-min supply average > lagC below the heating curve
    protHz: 80,          // compressor protection: frequency …
    protAmpPct: 85,      // … or current in % of 9.67 A …
    protDischarge: 90,   // … or discharge (DP 104) °C, held 3 min → P23 − 2
    allowPowerful: false,
    defrostLead: 20,     // d#169: no DHW start when the next defrost is expected within … min
    supplyReady: 1,      // d#169: after a defrost start DHW only when supply ≥ heating set − … °C
    defrostEndPct: 30,   // d#173: a defrost after this % of the way to the target ends the cycle …
    defrostNextMin: 60   // … and the next one is planned this many min later
};
const DHW_LIMITS = { frostLimit: [-30, 10], hyst: [1, 10], gap: [3, 10], supplyAdd: [1, 10], maxSupply: [45, 55],
    boilerP24: [5, 30], minIntervalH: [0, 12], maxMin: [15, 180], maxMinCold: [10, 180], coldLimit: [-25, 5],
    coldCap: [40, 55], coldIntervalH: [0, 12], lagC: [1, 10], protHz: [50, 90], protAmpPct: [50, 100], protDischarge: [70, 110],
    defrostLead: [0, 60], supplyReady: [0, 5], defrostEndPct: [0, 100], defrostNextMin: [15, 240] };
// raw values that are missing or out of range keep the value of `base` (default: DHW_DEFAULTS)
function dhwCfg(raw, base) {
    const c = Object.assign(JSON.parse(JSON.stringify(DHW_DEFAULTS)), JSON.parse(JSON.stringify(base || {})));
    for (const k of Object.keys(c)) if (!(k in DHW_DEFAULTS)) delete c[k];   // old keys (switchMargin, preheatAdd)
    const r = raw || {};
    for (const k of Object.keys(DHW_LIMITS)) {
        const v = Number(r[k]);
        if (r[k] !== undefined && r[k] !== null && r[k] !== '' && Number.isFinite(v) && v >= DHW_LIMITS[k][0] && v <= DHW_LIMITS[k][1]) c[k] = v;
    }
    if (typeof r.allowPowerful === 'boolean') c.allowPowerful = r.allowPowerful;
    if (typeof r.gapRamp === 'boolean') c.gapRamp = r.gapRamp;
    if (Array.isArray(r.curve) && r.curve.length >= 2 && r.curve.length <= 8) {
        const pts = r.curve.map((p) => [Number(p[0]), Number(p[1])]);
        const okPts = pts.every((p, i) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= -30 && p[0] <= 20
            && p[1] >= 30 && p[1] <= 55 && (i === 0 || p[0] > pts[i - 1][0]));
        if (okPts) c.curve = pts;
    }
    return c;
}
function curveAt(curve, x) {
    if (x <= curve[0][0]) return curve[0][1];
    const last = curve[curve.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < curve.length; i++) {
        const a = curve[i - 1], b = curve[i];
        if (x <= b[0]) return Math.round((a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])) * 2) / 2;
    }
    return last[1];
}
// built-in heating curve of the pump (P22): 20 + P24 / 10 × (P23 − outdoor), 20…60 °C
function heatCurveAt(p23, p24, x) { return Math.max(20, Math.min(60, 20 + p24 / 10 * (p23 - x))); }
// boiler curve (d#142): P23 that makes the pump's curve give supply `w` at outdoor `x` with P24 `p24`
// d#172: P23 / P24 that make the pump's curve give at least w at outdoor x: P23 first (slope p24), and once P23 would
// pass 40 P23 40 with a steeper P24 (≤ 30)
// d#173: % of the way from the tank at the cycle start to the target (0…100), null when unknown
function dhwProgress(start, tank, target) {
    if (![start, tank, target].every(Number.isFinite) || target <= start) return null;
    return Math.max(0, Math.min(100, Math.round((tank - start) / (target - start) * 100)));
}
function curveCoeffs(w, x, p24) {
    const p23 = Math.ceil(x + (w - 20) / (p24 / 10) - 1e-9);
    if (p23 <= 40) return { p23: Math.max(0, p23), p24 };
    return { p23: 40, p24: Math.min(30, Math.max(p24, Math.ceil((w - 20) * 10 / Math.max(1, 40 - x) - 1e-9))) };
}
function p23For(w, x, p24) { return Math.max(0, Math.min(40, Math.round(x + (w - 20) / (p24 / 10)))); }
// wanted DHW supply at outdoor x (tank target + supplyAdd, capped; capped lower in the cold)
function wantedSupply(c, x) {
    const t = x === null || x < c.frostLimit ? null : curveAt(c.curve, x);
    if (t === null) return null;
    return Math.min(c.maxSupply, t + c.supplyAdd, x <= c.coldLimit ? c.coldCap : 99);
}

// ---- heating power controller (d#166) ---------------------------------------------------
const HEAT_ID = 'heat';
const HEAT_NAME = 'Heating power controller';
const HEAT_DEFAULTS = { lagUp: 1.5, overC: 1, gapMax: 4, stepMin: 10, ampPct: 85, allowPowerful: false, maxBoost: 4 };
const HEAT_LIMITS = { lagUp: [0.5, 5], overC: [0, 5], gapMax: [2, 10], stepMin: [10, 60], ampPct: [50, 100], maxBoost: [0, 8] };
const HEAT_WINDOW_MIN = 10;
const HEAT_LADDER = ['mute', 'smart', 'strong'];
const MODE_NAME = { mute: 'Silent', smart: 'Smart', strong: 'Powerful' };
function heatCfg(raw, base) {
    const c = Object.assign({}, HEAT_DEFAULTS, base || {});
    for (const k of Object.keys(c)) if (!(k in HEAT_DEFAULTS)) delete c[k];
    const r = raw || {};
    for (const k of Object.keys(HEAT_LIMITS)) {
        const v = Number(r[k]);
        if (r[k] !== undefined && r[k] !== null && r[k] !== '' && Number.isFinite(v) && v >= HEAT_LIMITS[k][0] && v <= HEAT_LIMITS[k][1]) c[k] = v;
    }
    if (typeof r.allowPowerful === 'boolean') c.allowPowerful = r.allowPowerful;
    return c;
}
// one decision from the averages: +1 step up, −1 step down, 0 stay (pure, see tests)
function heatDecide(c, a) {
    if (a.lag === null || a.gap === null) return { step: 0, why: 'collecting data' };
    if (a.amp !== null && a.amp >= c.ampPct / 100 * UNIT_MAX_A) return { step: -1, why: 'current ' + a.amp + ' A ≥ ' + c.ampPct + ' % of ' + UNIT_MAX_A + ' A' };
    if (a.gap > c.gapMax + 1) return { step: -1, why: 'supply − return ' + a.gap + ' °C > ' + (c.gapMax + 1) + ' (rises too fast)' };
    if (a.lag > c.overC) return { step: -1, why: 'supply ' + a.lag + ' °C above the set point (> ' + c.overC + ')' };
    if (a.lag < -c.lagUp && a.gap < c.gapMax) return { step: 1, why: 'supply lags ' + (-a.lag) + ' °C behind the set point, supply − return ' + a.gap + ' < ' + c.gapMax };
    return { step: 0, why: 'lag ' + a.lag + ' °C, supply − return ' + a.gap + ' °C: in range' };
}

// Smart Life runs on 7–8 Nov 2026 (outdoor −5…+1 °C), for the page
const RUNS = { 'B46 on <44 -4..1': 6, 'B46 switch >38': 15, 'B46 off >46 -4..1': 8, 'DF exchange off': 45, 'DF exchange on 31': 49, 'DF switch to heating': 6, 'DF safe 10min': 59 };
const RUNS_FAILED = { 'B46 switch >38': 4, 'B46 off >46 -4..1': 3 };

// ---- state ------------------------------------------------------------------
const now = Date.now();
const st = flow.get('heatPump') || {};
// Shared objects live in node context from the first run on, so the timer callbacks
// (runStep / pump / verify) and this invocation always work on the same objects.
function ctx(key, init) { if (context.get(key) === undefined) context.set(key, init); return context.get(key); }
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
function dhwCfgNow() { const s = context.get('settings') || settings; return s.dhw || dhwCfg({}); }
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
function model() {
    const dev = (role) => { const d = st[role] || {}; return { state: d.state || 'UNKNOWN', age: d.lastData ? Math.round((now - d.lastData) / 1000) : null }; };
    const f = context.get('flag') || flag;
    const sq = context.get('seqs') || {};
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
        log: context.get('log') || []
    };
}
function send(out, m) {
    const arr = [null, null, null, null, null, null]; arr[out] = m; node.send(arr);
}
// Device write queue: one SET every WRITE_GAP_MS; every write is checked VERIFY_MS later
// against the value the device reports (ok / fail in the log, like the Smart Life log).
function pump() {
    if (context.get('pumping')) return;
    const q = context.get('queue') || [];
    if (!q.length) return;
    context.set('pumping', true); context.set('pumpAt', Date.now());
    const item = q.shift(); context.set('queue', q);
    if (!item.force && modeOf(item.rule) !== 'live') {
        logEvent({ kind: 'warn', rule: item.rule, cloud: item.cloud, run: item.run, live: true, text: item.text + ' dropped (rule no longer On)' });
    } else if ((context.get('settings') || {}).master) {
        send(OUT[item.role], { payload: { operation: 'SET', dps: item.dps, set: item.set } });
        node.log('Heat pump automations: ' + item.cloud + ' -> ' + item.role + ' DP ' + item.dps + ' = ' + item.set);
        setTimeout(() => {
            const dev = (flow.get('heatPump') || {})[item.role];
            const v = dev && dev.dps ? dev.dps[item.dps] : undefined;
            const good = String(v) === String(item.set);
            logEvent({ kind: good ? 'ok' : 'fail', rule: item.rule, cloud: item.cloud, run: item.run, live: true,
                text: item.text + (good ? ' — confirmed' : ' — NOT confirmed, device reports ' + v) });
        }, VERIFY_MS);
    } else {
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
        q.push({ rule: rule.id, cloud: rule.cloud, run: token, role: s.role, dps: s.dps, set: s.set, text: s.text });
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

// ---- DHW controller (d#130, rebuilt on the pump's curve in d#142) -------------------------
// The pump's weather curve P22 stays ON all the time. The controller only switches the curve's
// values (docs/heat-pump-dhw-curve-plan.md):
//   heating — the owner's P23 / P24 (P23 slider), stored in settings.heatCurve;
//   stop    — P23 0: the curve gives 20 °C and the compressor stops before a valve switch;
//   boiler  — P24 = boilerP24 (12) and P23 computed from the wanted supply (tank target + 4) at
//             the 10-min outdoor average, raised 1 per minute while supply − return ≤ gap.
// States: HEATING → STOP → DHW (⇄ DEFROST_DHW → STOP) → HEATING (end = heating curve back).
// Compressor protection in DHW: Silent only at ≤ coldLimit, supply ≤ coldCap there; ≥ protHz or
// ≥ protAmpPct of 9.67 A or discharge ≥ protDischarge for 3 min → P23 − 2 and Silent (every 3 min);
// held 10 min or 3 steps and hot again → end of the cycle (the electric heater takes over).
// If Node-RED stops mid-cycle the pump still runs on a curve; on every start (and outside a cycle)
// the heating values are written back when the pump shows the stop or boiler values.
// d#144: valve travel, quick retry after an early abort (Er03 on 11 Nov), max duration counts DHW time only
const VALVE_TRAVEL_S = 90;     // valve ON with the curve still at P23 0 (no demand) while the valve moves
const EARLY_MIN = 5;           // a cycle that ends earlier (Er03, valve switched back) …
const RETRY_MIN = 15;          // … is tried again after this, ignoring the interval …
const RETRY_MAX = 2;           // … at most this many times in a row
const HARD_EXTRA_MIN = 30;     // a cycle never lasts longer than max duration + this (defrosts included)
const p23w = (v) => ({ role: 'hp', dps: 133, set: v, text: 'curve P23 ' + v });
const p24w = (v) => ({ role: 'hp', dps: 134, set: v, text: 'curve P24 ' + v });
function dhwState() {
    return ctx('dhw', { state: 'HEATING', since: now, run: null, live: false, lastEnd: 0, p23Cmd: null, p24Cmd: null, rampAt: 0,
        startAt: 0, startTank: null, streak: 0, outS: [], outAvg: null, lagS: [], prog: null, defTicks: 0, fanOkSince: 0,
        valveOnSince: 0, goal: null, want: null, prot: null, curveFixAt: 0, why: '', waitNote: '' });
}
function dhwLastEnd(d) { return Math.max(d.lastEnd || 0, Number((context.get('settings') || settings).dhwLastEnd) || 0); }
function dhwModel() {
    const d = dhwState(), c = dhwCfgNow();
    const out = d.outAvg;
    const cold = out !== null && out <= c.coldLimit;
    const lastEnd = dhwLastEnd(d);
    const s = context.get('settings') || settings;
    return { mode: modeOf(DHW_ID), state: d.state, since: d.since, why: d.why, waitNote: d.waitNote, outAvg: out,
        target: out === null ? null : (out < c.frostLimit ? null : curveAt(c.curve, out)), frost: out !== null && out < c.frostLimit,
        cold, wanted: out === null ? null : wantedSupply(c, out),
        p23Cmd: d.p23Cmd, p24Cmd: d.p24Cmd, goalP23: d.goal, curveSupply: d.p23Cmd !== null && d.p24Cmd !== null && out !== null ? +heatCurveAt(d.p23Cmd, d.p24Cmd, out).toFixed(1) : null,
        prot: d.prot, heatCurve: s.heatCurve || null, plan: dhwPlan(d, c),
        startTank: d.startTank, startAt: d.startAt, lastEnd,
        progress: ['STOP', 'VALVE', 'DHW', 'DEFROST_DHW'].includes(d.state) && out !== null ? dhwProgress(d.startTank, n(((st.hp && st.hp.dps) || {})['108']), out < c.frostLimit ? null : curveAt(c.curve, out)) : null,
        planned: s.dhwRetry && !s.dhwRetry.n ? s.dhwRetry.at : 0,
        blocked: s.dhwBlock || null,
        nextStart: lastEnd ? lastEnd + (cold ? c.coldIntervalH : c.minIntervalH) * 3600 * 1000 : 0, lag: dhwLag(d), cfg: c, defrost: defrostForecast() };
}
// d#143: where the running cycle is heading: tank target and the expected end, from the tank rise
// of the last 6 min (least-squares slope, at least 3 min of DHW), never later than the max duration
function dhwPlan(d, c) {
    if (!['STOP', 'VALVE', 'DHW', 'DEFROST_DHW'].includes(d.state) || d.outAvg === null) return null;
    const target = d.outAvg < c.frostLimit ? null : curveAt(c.curve, d.outAvg);
    if (target === null) return null;
    const cold = d.outAvg <= c.coldLimit;
    const maxDur = (cold ? c.maxMinCold : c.maxMin) * MIN;
    const maxEnd = Math.min(now + Math.max(0, maxDur - (d.dhwMs || 0)), d.startAt + maxDur + HARD_EXTRA_MIN * MIN);
    const s = d.tankS || [];
    const last = s.length ? s[s.length - 1] : null;
    let rate = null, eta = null;
    if (d.state === 'DHW' && s.length >= 2 && last[0] - s[0][0] >= 3 * MIN) {
        const mx = s.reduce((a, p) => a + p[0], 0) / s.length, my = s.reduce((a, p) => a + p[1], 0) / s.length;
        const sxx = s.reduce((a, p) => a + (p[0] - mx) * (p[0] - mx), 0), sxy = s.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
        rate = sxx > 0 ? sxy / sxx * MIN : null;   // °C per minute
        if (rate !== null && rate > 0.02) eta = Math.round(last[0] + Math.max(0, target - (my + rate * (last[0] - mx) / MIN)) / rate * MIN);
    }
    const capped = eta === null || eta > maxEnd;
    return { target, tank: last ? last[1] : d.startTank, startAt: d.startAt, rate: rate === null ? null : Math.round(rate * 100) / 100,
        eta: capped ? maxEnd : eta, byMax: capped, maxEnd };
}
function dhwLag(d) {
    const s = d.lagS || [];
    if (s.length < 20 || s[s.length - 1][0] - s[0][0] < 20 * MIN) return null;
    return Math.round(s.reduce((a, x) => a + x[1], 0) / s.length * 10) / 10;
}
// d#169: next defrost = last start + median of the last intervals (10 min … 3 h); null with < 2 intervals or when overdue
function defrostForecast() {
    const ds = ((context.get('settings') || settings).defrostStarts || []).slice(-7);
    const iv = [];
    for (let i = 1; i < ds.length; i++) { const g = ds[i] - ds[i - 1]; if (g > 10 * MIN && g < 3 * 3600 * 1000) iv.push(g); }
    if (iv.length < 2) return null;
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    const next = ds[ds.length - 1] + med;
    return { last: ds[ds.length - 1], intervalMin: Math.round(med / MIN), next: now - next > 15 * MIN ? null : next };
}
// d#171: the pump's P23 is the heating controller's boost, not a new owner curve (do not store it)
function boostedCurve(heat, P23, P24) {
    const h = context.get('heat') || {};
    if (!heat) return false;
    return (h.boost > 0 && !!h.curveCmd && P23 === h.curveCmd.p23 && P24 === h.curveCmd.p24) || (!!h.p23At && now - h.p23At < 2 * MIN);
}
function saveSettingsFile() { persist(); send(2, saveMsg()); }
function dhwTick() {
    const d = dhwState(), c = dhwCfgNow();
    const md = modeOf(DHW_ID);
    const liveNow = md === 'live' && settings.master;
    const H = (st.hp && st.hp.dps) || {}, V = (st.valve && st.valve.dps) || {}, B = (st.bypass && st.bypass.dps) || {};
    const sup = n(H['102']), ret = n(H['101']), tank = n(H['108']), out = n(H['103']), hz = n(H['115']), fan = n(H['116']);
    const amp = n(H['112']), dis = n(H['104']);
    const P23 = n(H['133']), P24 = n(H['134']), P22on = String(H['132']) === '1';
    const valveOn = V['1'] === true, bypassOn = B['1'] === true;
    const defNow = fan === 0 && hz > 30;
    const devOk = ready('hp') && ready('valve') && ready('bypass');
    const heat = settings.heatCurve || null;
    const go = (state, text, kind) => { d.state = state; d.since = now; if (text) logEvent({ kind: kind || 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text }); };
    const write = (s, force) => {
        if (!d.live && !force) { logEvent({ kind: 'dry', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: false, text: 'would ' + s.text }); return; }
        if (!liveNow) return;
        const q = context.get('queue') || [];
        q.push({ rule: DHW_ID, cloud: DHW_NAME, run: d.run, role: s.role, dps: s.dps, set: s.set, text: s.text, force: !!force });
        context.set('queue', q);
        logEvent({ kind: 'write', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: true, text: s.text });
        pump();
    };
    const modeTo = (m) => {
        if (H['2'] === m) { d.modeCmd = null; return; }
        if (d.modeCmd === m && now - (d.modeAt || 0) < MIN) return;   // sent, wait for the device
        d.modeCmd = m; d.modeAt = now; write(mode(m));
    };
    const curveTo = (p23, p24) => {
        if (p24 !== undefined && p24 !== null && d.p24Cmd !== p24) { d.p24Cmd = p24; write(p24w(p24)); }
        if (d.p23Cmd !== p23) { d.p23Cmd = p23; write(p23w(p23)); }
        d.rampAt = now;
    };
    const heatBack = (force) => {
        if (!P22on) write(p22(true), force);
        if (heat) { write(p24w(heat.p24), force); write(p23w(heat.p23), force); }
        d.p23Cmd = null; d.p24Cmd = null;
    };
    const heatTxt = heat ? 'P23 ' + heat.p23 + ' / P24 ' + heat.p24 : 'no stored heating curve';

    // outdoor: 10-min average outside defrosts (the sensor reads 30–47 °C during / after them)
    if (ready('hp') && Number.isFinite(out) && !recentDefrost && !defNow) d.outS.push([now, out]);
    d.outS = d.outS.filter((x) => now - x[0] <= 10 * MIN);
    if (d.outS.length) d.outAvg = Math.round(d.outS.reduce((a, x) => a + x[1], 0) / d.outS.length * 10) / 10;
    // heating lag: 30-min average of supply − heating curve while heating runs on the heating values
    if (d.state === 'HEATING' && ready('hp') && !valveOn && !bypassOn && !recentDefrost && !defRecovering && hz > 0 && d.outAvg !== null
        && Number.isFinite(P23) && Number.isFinite(P24) && P24 !== c.boilerP24 && P23 > 0) {
        d.lagS.push([now, sup - heatCurveAt(P23, P24, d.outAvg)]);
    }
    d.lagS = d.lagS.filter((x) => now - x[0] <= 30 * MIN);

    // controller switched off / local control OFF during a cycle → back to heating
    if (d.state !== 'HEATING' && (md === 'off' || (d.live && !liveNow))) {
        if (d.live && settings.master) { write(valve(false), true); write(bypass(false), true); heatBack(true); }
        go('HEATING', 'cycle stopped (' + (md === 'off' ? 'controller Off' : 'local control OFF or controller no longer On') + ')'
            + (d.live && settings.master ? ': valve OFF, bypass OFF, heating curve back (' + heatTxt + ')' : ''), 'stop');
        d.run = null; d.lastEnd = now; settings.dhwLastEnd = now; saveSettingsFile();
        context.set('dhw', d); return;
    }
    if (md === 'off') { d.why = 'controller Off'; context.set('dhw', d); return; }
    if (!devOk) { d.waitNote = 'device not connected / stale'; context.set('dhw', d); return; }
    d.waitNote = '';
    const x = d.outAvg === null ? out : d.outAvg;
    const cold = d.outAvg !== null && d.outAvg <= c.coldLimit;
    const target = d.outAvg === null ? null : (d.outAvg < c.frostLimit ? null : curveAt(c.curve, d.outAvg));
    const W = target === null ? 45 : wantedSupply(c, d.outAvg);
    const elapsed = now - d.since;
    const cycleMin = (now - d.startAt) / MIN;
    const maxDur = cold ? c.maxMinCold : c.maxMin;
    // time spent heating the tank (DHW state only): defrosts and switch pauses do not count
    if (d.state === 'DHW' && d.tickAt) d.dhwMs = (d.dhwMs || 0) + Math.min(MIN, Math.max(0, now - d.tickAt));
    d.tickAt = now;
    const dhwMin = (d.dhwMs || 0) / MIN;
    const er03 = (n(H['15']) & 1) === 1;
    const lastEnd = dhwLastEnd(d);
    const endCycle = (why, abort) => {
        if (valveOn) write(valve(false));
        if (bypassOn) write(bypass(false));
        modeTo('mute');
        heatBack();
        // d#174 (owner): an aborted cycle (Er03, the 3-way valve switched back from outside or did not switch) blocks
        // new DHW starts until "Allow DHW again" on the Heat Pump page; no automatic retries (the d#144 retry is gone)
        let retryTxt = '';
        settings.dhwRetry = null;
        if (abort) {
            settings.dhwBlock = { at: now, why };
            retryTxt = '; DHW blocked until allowed again on the Heat Pump page';
        }
        d.lastEnd = now; settings.dhwLastEnd = now; saveSettingsFile();
        go('HEATING', 'end of DHW (' + why + '): tank ' + d.startTank + ' → ' + tank + ' °C after ' + Math.round(cycleMin) + ' min (' + Math.round(dhwMin) + ' min heating) → valve to heating, heating curve back (' + heatTxt + ')' + retryTxt, abort ? 'stop' : 'done');
        d.run = null; d.goal = null; d.want = null;
    };

    switch (d.state) {
    case 'HEATING': {
        // watchdog (On only): valve ON outside a DHW cycle for 60 s → valve back to heating
        if (md === 'live' && valveOn) {
            if (!d.valveOnSince) d.valveOnSince = now;
            else if (now - d.valveOnSince >= MIN && liveNow) {
                d.run = null; d.live = true;
                write(valve(false));
                logEvent({ kind: 'warn', rule: DHW_ID, cloud: DHW_NAME, live: true, text: 'valve ON outside a DHW cycle for 1 min → valve OFF' });
                d.valveOnSince = 0;
            }
        } else d.valveOnSince = 0;
        // heating curve: store the owner's values, or write them back when the pump shows the stop /
        // boiler values outside a cycle (Node-RED stopped mid-cycle, an old version left P22 off)
        if (ready('hp') && Number.isFinite(P23) && Number.isFinite(P24) && now - lastEnd > 2 * MIN && now - (d.curveFixAt || 0) > 2 * MIN) {
            const foreign = !P22on || P23 === 0 || (P24 === c.boilerP24 && !(heat && heat.p24 === c.boilerP24));
            if (foreign && heat && liveNow) {
                d.run = null; d.live = true;
                logEvent({ kind: 'warn', rule: DHW_ID, cloud: DHW_NAME, live: true, text: 'pump curve P22 ' + (P22on ? 'on' : 'off') + ', P23 ' + P23 + ', P24 ' + P24 + ' outside a DHW cycle → heating curve back (' + heatTxt + ')' });
                heatBack(); d.curveFixAt = now;
            } else if (!foreign && (!heat || heat.p23 !== P23 || heat.p24 !== P24) && !boostedCurve(heat, P23, P24)) {
                settings.heatCurve = { p23: P23, p24: P24, at: now };
                logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: 'heating curve stored: P23 ' + P23 + ' / P24 ' + P24 + (heat ? ' (was P23 ' + heat.p23 + ' / P24 ' + heat.p24 + ')' : '') });
                saveSettingsFile();
            }
        }
        const ivH = cold ? c.coldIntervalH : c.minIntervalH;
        const why = [];
        if (target === null) why.push(d.outAvg === null ? 'no outdoor value yet' : 'outdoor ' + d.outAvg + ' °C below the frost limit ' + c.frostLimit + ' °C (electric heater only)');
        else if (!(tank < target - c.hyst)) why.push('tank ' + tank + ' °C ≥ ' + (target - c.hyst) + ' °C (target ' + target + ' − ' + c.hyst + ')');
        const rt = settings.dhwRetry;
        const retryDue = !!(rt && now >= rt.at);
        // d#173: a planned cycle that is not needed any more (tank still ≥ target − hyst) is dropped
        if (retryDue && !rt.n && target !== null && tank >= target - c.hyst) { settings.dhwRetry = null; saveSettingsFile(); }
        if (lastEnd && now - lastEnd < ivH * 3600 * 1000 && !retryDue) why.push('last cycle ' + Math.round((now - lastEnd) / MIN) + ' min ago (min ' + ivH + ' h' + (cold ? ', cold' : '')
            + (rt ? (rt.n ? '; retry ' + rt.n + '/' + RETRY_MAX : '; planned ' + (rt.why || '')) + ' at ' + new Date(rt.at).toTimeString().slice(0, 5) : '') + ')');
        if (defNow || recentDefrost) why.push('defrost now or < ' + DEFROST_QUIET_MIN + ' min ago');
        else {
            // d#169: after a defrost the heating loop first gets back to its set point
            // (d#170: back at the set point − supplyReady, or at the supply from before the defrost − 0.5 if lower)
            if (defRecovering) why.push('after the defrost supply ' + sup + ' °C not back yet (heating set ' + H['125'] + ' − ' + c.supplyReady
                + (Number.isFinite(Number(context.get('preDefSupply'))) ? ', before the defrost ' + context.get('preDefSupply') : '') + ') — heating first');
        }
        const fc = defrostForecast();
        if (fc && fc.next && c.defrostLead > 0 && fc.next - now < c.defrostLead * MIN)
            why.push('defrost expected ≈ ' + new Date(fc.next).toTimeString().slice(0, 5) + ' (every ~' + fc.intervalMin + ' min) — DHW after it');
        if ((context.get('flag') || flag).on) why.push('defrost flag ON');
        if (valveOn) why.push('valve ON');
        if (settings.dhwBlock) why.push('blocked: the last cycle was aborted at ' + new Date(settings.dhwBlock.at).toTimeString().slice(0, 5) + ' (' + settings.dhwBlock.why + ') — allow DHW again on the Heat Pump page');
        if (H['1'] !== true) why.push('heat pump off');
        if (!heat) why.push('heating curve not stored yet');
        const lag = dhwLag(d);
        if (d.outAvg !== null && d.outAvg <= c.coldLimit && lag !== null && lag < -c.lagC) why.push('heating lags ' + lag + ' °C below its curve at ' + d.outAvg + ' °C (heating first)');
        d.why = why.length ? why.join('; ') : 'start conditions met';
        d.streak = why.length ? 0 : d.streak + 1;
        if (d.streak >= HOLD) {
            d.streak = 0; d.run = now + ':' + DHW_ID; d.live = liveNow; d.startAt = now; d.startTank = tank; d.prog = null;
            d.prot = { steps: 0, hotSince: 0, at: 0, cut: 0, reason: '' }; d.p23Cmd = null; d.p24Cmd = null; d.p24Goal = null; d.tankS = []; d.dhwMs = 0;
            logEvent({ kind: d.live ? 'start' : 'test', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live,
                text: (d.live ? 'start' : 'test, would start') + ': tank ' + tank + ' °C < target ' + target + ' − ' + c.hyst + ' at outdoor ' + d.outAvg + ' °C'
                    + ' → wanted supply ' + W + ' °C' + (cold ? ' (cold: Silent only, max ' + c.coldCap + ' °C)' : '') + (retryDue ? (rt.n ? ' [retry ' + rt.n + '/' + RETRY_MAX + ']' : ' [planned ' + (rt.why || '') + ']') : '') + '; curve P23 0 (compressor stops), then valve to the tank' });
            if (!P22on) write(p22(true));
            modeTo('mute'); if (bypassOn) write(bypass(false));
            curveTo(0);
            go('STOP', 'curve P23 0 (curve → 20 °C, compressor stops) before the valve switch');
        }
        break;
    }
    case 'PREHEAT':
    case 'RAMPDOWN': {
        // states of the version before d#142 (only if a context survived a deploy)
        if (valveOn) write(valve(false));
        if (bypassOn) write(bypass(false));
        heatBack(true); d.lastEnd = now; d.run = null;
        go('HEATING', 'state ' + d.state + ' of an older version → heating curve back (' + heatTxt + ')', 'warn');
        break;
    }
    case 'STOP': {
        if (cycleMin >= maxDur + HARD_EXTRA_MIN) { endCycle('hard limit ' + (maxDur + HARD_EXTRA_MIN) + ' min'); break; }
        if ((hz === 0 && elapsed >= 20 * S) || elapsed >= 90 * S) {
            write(valve(true));
            if (bypassOn) write(bypass(false));
            d.defTicks = 0;
            go('VALVE', 'valve to the tank, bypass OFF; curve stays at P23 0 for ' + VALVE_TRAVEL_S + ' s while the valve moves');
        }
        d.why = 'waiting for the compressor to stop (' + hz + ' Hz)';
        break;
    }
    case 'VALVE': {
        // d#144: Er03 (no water flow) came ~40 s after the valve switch when the boiler curve was set at
        // once (11 Nov 06:56–13:05): give the valve its travel time without demand first
        if (er03) { endCycle('fault Er03 (water flow) during the valve switch', true); break; }
        if (defNow) {
            d.defTicks++;
            if (d.defTicks >= 2) { write(valve(false)); if (!bypassOn) write(bypass(true)); d.fanOkSince = 0; d.tankS = []; go('DEFROST_DHW', 'defrost during the valve switch → valve to heating, bypass ON'); break; }
        } else d.defTicks = 0;
        if (!valveOn && elapsed >= MIN) { endCycle('valve did not switch to the tank', true); break; }
        if (elapsed >= VALVE_TRAVEL_S * S) {
            // d#172: a goal above P23 40 makes the boiler curve steeper (P24) instead of capping it
            const cc0 = curveCoeffs(W, x, c.boilerP24); d.p24Goal = cc0.p24;
            d.goal = Math.max(0, cc0.p23 - (d.prot ? d.prot.cut : 0));
            // d#143: after the valve switch the loop fills with tank water (seen 10 Nov 14:17: 40–42 °C), so the
            // gap is counted from the warmest of return / supply / tank; a lower start left the curve below
            // the water and the compressor off for 9 min
            const water = Math.max(Number.isFinite(ret) ? ret : 0, Number.isFinite(sup) ? sup : 0, Number.isFinite(tank) ? tank : 0);
            const startP23 = c.gapRamp ? Math.min(d.goal, p23For(Math.round(water) + c.gap, x, d.p24Goal)) : d.goal;
            curveTo(startP23, d.p24Goal);
            d.prog = { t: now, sup }; d.defTicks = 0;
            go('DHW', 'valve settled, boiler curve P24 ' + d.p24Goal + ' / P23 ' + startP23 + ' (≈ ' + heatCurveAt(startP23, d.p24Goal, x).toFixed(1)
                + ' °C at ' + x + ' °C; goal P23 ' + d.goal + ' ≈ ' + W + ' °C' + (c.gapRamp ? ', start ≤ water ' + Math.round(water) + ' + ' + c.gap + ', then +1 per minute' : '') + ')');
        }
        d.why = 'valve moving to the tank, curve P23 0 (' + Math.round(elapsed / S) + ' / ' + VALVE_TRAVEL_S + ' s)';
        break;
    }
    case 'DHW': {
        if (er03) { endCycle('fault Er03 (water flow)', true); break; }
        if (defNow) {
            d.defTicks++;
            if (d.defTicks >= 2) {
                // d#173: a defrost after ≥ defrostEndPct of the way to the target ends the cycle; the next one is planned
                // defrostNextMin later (it starts then only if the tank is still below target − hyst)
                const pg = dhwProgress(d.startTank, tank, target);
                if (pg !== null && c.defrostEndPct > 0 && pg >= c.defrostEndPct) {
                    endCycle('defrost at ' + pg + ' % of the way ' + d.startTank + ' → ' + target + ' °C');
                    settings.dhwRetry = { n: 0, at: now + c.defrostNextMin * MIN, why: 'after the defrost' };
                    saveSettingsFile();
                    logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, live: d.live, text: 'next DHW cycle planned at ' + new Date(now + c.defrostNextMin * MIN).toTimeString().slice(0, 5) + ' (in ' + c.defrostNextMin + ' min, if the tank is still below target − ' + c.hyst + ')' });
                    break;
                }
                write(valve(false)); if (!bypassOn) write(bypass(true));
                d.fanOkSince = 0; d.tankS = [];   // d#170: the tank-rise forecast restarts after the defrost
                go('DEFROST_DHW', 'defrost during DHW → valve to heating, bypass ON (the tank is not cooled)');
                break;
            }
        } else d.defTicks = 0;
        if (target !== null && tank >= target) { endCycle('tank at target ' + target + ' °C'); break; }
        if (dhwMin >= maxDur) { endCycle('max duration ' + Math.round(maxDur) + ' min of heating at ' + d.outAvg + ' °C outdoor'); break; }
        if (cycleMin >= maxDur + HARD_EXTRA_MIN) { endCycle('hard limit ' + (maxDur + HARD_EXTRA_MIN) + ' min with defrosts'); break; }
        if (!valveOn && elapsed >= MIN) { endCycle('valve switched to heating by someone else', true); break; }
        // tank rise for the expected end (last 10 min)
        if (Number.isFinite(tank)) { d.tankS = (d.tankS || []).concat([[now, tank]]).filter((p) => now - p[0] <= 6 * MIN); }
        // compressor protection (P3 / P4)
        const pr = d.prot || (d.prot = { steps: 0, hotSince: 0, at: 0, cut: 0, reason: '' });
        const reasons = [];
        if (hz >= c.protHz) reasons.push(hz + ' Hz ≥ ' + c.protHz);
        if (amp >= c.protAmpPct / 100 * UNIT_MAX_A) reasons.push(amp + ' A ≥ ' + (c.protAmpPct / 100 * UNIT_MAX_A).toFixed(1));
        if (dis >= c.protDischarge) reasons.push('discharge ' + dis + ' °C ≥ ' + c.protDischarge);
        if (reasons.length) {
            if (!pr.hotSince) pr.hotSince = now;
            const held = now - pr.hotSince;
            pr.reason = reasons.join(', ');
            if (held >= 10 * MIN || (pr.steps >= 3 && held >= 3 * MIN && now - pr.at >= 3 * MIN)) {
                endCycle('compressor protection: ' + pr.reason + ' for ' + Math.round(held / MIN) + ' min after ' + pr.steps + ' steps down — the electric heater takes over');
                break;
            }
            if (held >= 3 * MIN && now - pr.at >= 3 * MIN) {
                pr.steps++; pr.cut += 2; pr.at = now;
                modeTo('mute');
                logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'compressor protection: ' + pr.reason + ' for 3 min → curve P23 − 2 (step ' + pr.steps + '), Silent' });
                d.rampAt = 0;   // apply the cut at once
            }
        } else pr.hotSince = 0;
        // boiler P23: goal from the wanted supply, ramp +1 per minute while supply − return ≤ gap
        const cc1 = curveCoeffs(W, x, c.boilerP24);
        const p24g = Math.max(cc1.p24, d.p24Goal || c.boilerP24);   // the slope only goes up within a cycle
        d.p24Goal = p24g;
        d.goal = Math.max(0, Math.min(40, p23For(W, x, p24g)) - pr.cut);
        const water = Math.max(Number.isFinite(ret) ? ret : 0, Number.isFinite(tank) ? tank : 0);
        const allowed = c.gapRamp ? p23For(Math.round(water) + c.gap, x, p24g) : 40;
        d.want = Math.min(d.goal, allowed);
        if (d.p23Cmd === null || d.p24Cmd !== p24g) curveTo(d.p23Cmd === null ? d.want : Math.min(d.p23Cmd, d.want), p24g);
        else if (d.want > d.p23Cmd && now - d.rampAt >= MIN) curveTo(d.p23Cmd + 1, p24g);
        else if (d.want <= d.p23Cmd - (d.rampAt === 0 ? 1 : 2) && now - d.rampAt >= 30 * S) curveTo(d.want, p24g);
        // power: Silent by default; Smart only when the supply does not rise (not in the cold, not
        // after a protection step); back to Silent near the wanted supply
        if (cold || pr.steps) { if (H['2'] !== 'mute') modeTo('mute'); }
        else if (d.prog && now - d.prog.t >= 10 * MIN) {
            const rise = sup - d.prog.sup;
            if (sup < W - 3 && rise < 2) {
                if (H['2'] === 'mute') { modeTo('smart'); logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'supply rose only ' + rise + ' °C in 10 min → Smart' }); }
                else if (H['2'] === 'smart' && c.allowPowerful) { modeTo('strong'); logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'supply rose only ' + rise + ' °C in 10 min → Powerful' }); }
            }
            d.prog = { t: now, sup };
        }
        if (!cold && !pr.steps && H['2'] !== 'mute' && sup >= W - 1) modeTo('mute');
        d.why = 'DHW: tank ' + tank + ' → ' + target + ' °C (' + (dhwProgress(d.startTank, tank, target) === null ? '?' : dhwProgress(d.startTank, tank, target)) + ' %), supply ' + sup + ' / return ' + ret + ', curve P23 ' + d.p23Cmd + ' (≈ '
            + heatCurveAt(d.p23Cmd, d.p24Cmd || c.boilerP24, x).toFixed(1) + ' °C), goal P23 ' + d.goal + ' (≈ ' + W + ' °C), heating ' + Math.round(dhwMin) + ' / ' + Math.round(maxDur) + ' min (cycle ' + Math.round(cycleMin) + ')'
            + (pr.steps ? ', protection ' + pr.steps + ' step(s)' : '') + (pr.hotSince ? ', hot: ' + pr.reason : '');
        break;
    }
    case 'DEFROST_DHW': {
        if (!defNow && fan > 300) { if (!d.fanOkSince) d.fanOkSince = now; } else d.fanOkSince = 0;
        if (cycleMin >= maxDur + HARD_EXTRA_MIN) { endCycle('hard limit ' + (maxDur + HARD_EXTRA_MIN) + ' min during a defrost'); break; }
        // the outdoor sensor reads high after a defrost; with the curve on that would give a low set point
        const sensorBack = Number.isFinite(out) && d.outAvg !== null && out <= d.outAvg + 3;
        if (d.fanOkSince && now - d.fanOkSince >= MIN && sensorBack) {
            curveTo(0);
            go('STOP', 'defrost over → curve P23 0 (compressor stops), then valve to the tank again');
        }
        d.why = 'defrost during DHW: valve on heating, waiting for the fan' + (sensorBack ? '' : ' and the outdoor sensor (' + out + ' °C)');
        break;
    }
    default:
        heatBack(true);
        go('HEATING', 'unknown state reset, heating curve back', 'warn');
    }
    context.set('dhw', d);
}

// ---- heating power controller tick (d#166) ----------------------------------------
function heatState() { return ctx('heat', { samples: [], boost: 0, p23At: 0, target: null, lastStep: 0, modeCmd: null, modeAt: 0, why: '', decision: '', lag: null, gap: null, run: null }); }
function heatModel() {
    const h = heatState(), c = (context.get('settings') || settings).heat || heatCfg({});
    const H = (st.hp && st.hp.dps) || {};
    return { mode: modeOf(HEAT_ID), cfg: c, lag: h.lag, gap: h.gap, why: h.why, decision: h.decision, lastStep: h.lastStep,
        pumpMode: MODE_NAME[H['2']] || H['2'] || null, boost: h.boost || 0, target: h.target === undefined ? null : h.target, nextStepAt: h.lastStep ? h.lastStep + c.stepMin * MIN : 0 };
}
function publishView() { flow.set('dhwView', Object.assign(dhwModel(), { at: now, master: settings.master, heat: heatModel() })); }
function heatTick() {
    const h = heatState(), c = settings.heat || heatCfg({});
    const md = modeOf(HEAT_ID);
    const H = (st.hp && st.hp.dps) || {}, V = (st.valve && st.valve.dps) || {}, B = (st.bypass && st.bypass.dps) || {};
    const d = context.get('dhw') || {};
    const hold = [];
    if (md === 'off') hold.push('controller Off');
    if (!(ready('hp') && ready('valve') && ready('bypass'))) hold.push('device not connected / stale');
    if (d.state && d.state !== 'HEATING') hold.push('DHW cycle running');
    else if (now - dhwLastEnd(d) < HEAT_WINDOW_MIN * MIN) hold.push('DHW cycle ended < ' + HEAT_WINDOW_MIN + ' min ago');
    if (V['1'] === true) hold.push('valve on DHW');
    if (H['1'] !== true) hold.push('heat pump off');
    if (!HEAT_LADDER.includes(H['2'])) hold.push('pump mode ' + H['2'] + ' unknown');
    if (hold.length) {
        // d#171: a curve boost ends with the hold: a DHW cycle writes the owner's curve back at its end itself;
        // controller Off (or not On) → the owner's P23 back now
        if (h.boost) {
            const hc0 = settings.heatCurve;
            if (hc0 && !(d.state && d.state !== 'HEATING') && md !== 'live' && settings.master && ready('hp')) {
                const q = context.get('queue') || [];
                for (const w of [p24w(hc0.p24), p23w(hc0.p23)]) {
                    q.push({ rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, role: w.role, dps: w.dps, set: w.set, text: w.text, force: true });
                    logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: true, text: 'controller ' + MODE_LABEL[md] + ' → curve boost off, ' + w.text });
                }
                context.set('queue', q);
                pump();
            }
            h.boost = 0;
        }
        h.samples = []; h.lag = null; h.gap = null; h.why = 'waiting: ' + hold.join('; ');
        context.set('heat', h); return;
    }
    // d#170: a defrost (bypass ON, compressor stop, supply drop) and the recovery after it are ignored: no samples,
    // no step, and the samples from before the defrost are kept, so the window continues after it
    const defNowH = n(H['116']) === 0 && n(H['115']) > 30;
    if (defNowH || recentDefrost || defRecovering || B['1'] === true || !(n(H['115']) > 0)) {
        h.why = 'ignored: ' + (defNowH ? 'defrost now' : recentDefrost ? 'defrost < ' + DEFROST_QUIET_MIN + ' min ago'
            : defRecovering ? 'supply recovering after the defrost' : B['1'] === true ? 'bypass ON' : 'compressor stopped')
            + (h.samples.length ? ' (keeps ' + h.samples.length + ' samples from before)' : '');
        h.paused = h.paused || now;
        context.set('heat', h); return;
    }
    // shift the kept samples over the pause, so the 10-min window counts only time outside defrosts
    if (h.paused) { const p = now - h.paused; h.samples = h.samples.map((x) => [x[0] + p, x[1], x[2], x[3]]); h.paused = 0; }
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));   // Number(null) is 0
    const sup = num(H['102']), ret = num(H['101']), amp = num(H['112']), P23 = num(H['133']);
    // d#171: the point to follow is the owner's heating curve (settings.heatCurve at the 10-min outdoor average),
    // not DP 125, which rises with the curve boost; without a stored curve DP 125
    const hc = settings.heatCurve;
    const set = hc && Number.isFinite(d.outAvg) ? +heatCurveAt(hc.p23, hc.p24, d.outAvg).toFixed(1) : num(H['125']);
    h.target = Number.isFinite(set) ? set : null;
    // boost bookkeeping: the pump shows the owner's curve again (DHW end, slider) → boost 0
    // (or any other curve than the one written: the owner moved the slider, a DHW cycle wrote its own)
    if (h.boost && !(h.p23At && now - h.p23At < 2 * MIN) && !(h.curveCmd && P23 === h.curveCmd.p23 && num(H['134']) === h.curveCmd.p24)) { h.boost = 0; h.curveCmd = null; }
    if ([sup, ret, set].every(Number.isFinite)) h.samples.push([now, sup - set, sup - ret, Number.isFinite(amp) ? amp : null]);
    h.samples = h.samples.filter((x) => now - x[0] <= HEAT_WINDOW_MIN * MIN);
    const full = h.samples.length >= 20 && now - h.samples[0][0] >= (HEAT_WINDOW_MIN - 1) * MIN;
    const avg = (i) => Math.round(h.samples.reduce((a, x) => a + x[i], 0) / h.samples.length * 10) / 10;
    h.lag = h.samples.length ? avg(1) : null; h.gap = h.samples.length ? avg(2) : null;
    const amps = h.samples.map((x) => x[3]).filter((x) => x !== null);
    const a = { lag: full ? h.lag : null, gap: full ? h.gap : null, amp: amps.length ? Math.max(...amps.slice(-6)) : null };
    const dec = heatDecide(c, a);
    const cur = HEAT_LADDER.indexOf(H['2']);
    const top = c.allowPowerful ? 2 : 1;
    const boost = h.boost || 0;
    // d#171 / d#172: two levers. Up: power mode first, then the curve: +1 °C of the curve's set point per step above
    // the owner's curve (up to maxBoost °C), through its coefficients — P23 first, P24 (slope) once P23 is at 40.
    // Down: the curve boost first, then the mode. Powerful while it is not allowed → down at once.
    let steps = null, act = '', nb = boost;
    const curveSteps = (b) => {
        const cc = b > 0 ? curveCoeffs(set + b, d.outAvg, hc.p24) : { p23: hc.p23, p24: hc.p24 };
        const out = [];
        if (cc.p24 !== num(H['134'])) out.push(p24w(cc.p24));
        if (cc.p23 !== P23) out.push(p23w(cc.p23));
        return { cc, out };
    };
    if (cur > top) { steps = [mode(HEAT_LADDER[top])]; act = MODE_NAME[HEAT_LADDER[top]]; }
    else if (dec.step > 0 && cur < top) { steps = [mode(HEAT_LADDER[cur + 1])]; act = MODE_NAME[HEAT_LADDER[cur + 1]]; }
    else if (dec.step > 0 && hc && Number.isFinite(set) && Number.isFinite(d.outAvg) && boost < c.maxBoost) {
        nb = Math.min(c.maxBoost, boost + 1);
        const cs = curveSteps(nb);
        if (cs.out.length) { steps = cs.out; act = 'curve +' + nb + ' °C (P23 ' + cs.cc.p23 + ' / P24 ' + cs.cc.p24 + ')'; }
    }
    else if (dec.step < 0 && boost > 0 && hc && Number.isFinite(set) && Number.isFinite(d.outAvg)) {
        nb = Math.max(0, boost - 1);
        const cs = curveSteps(nb);
        steps = cs.out.length ? cs.out : null; act = nb ? 'curve +' + nb + ' °C (P23 ' + cs.cc.p23 + ' / P24 ' + cs.cc.p24 + ')' : 'curve back to yours (P23 ' + hc.p23 + ' / P24 ' + hc.p24 + ')';
        if (!steps) h.boost = nb;
    }
    else if (dec.step < 0 && cur > 0) { steps = [mode(HEAT_LADDER[cur - 1])]; act = MODE_NAME[HEAT_LADDER[cur - 1]]; }
    h.decision = dec.why;
    const early = h.lastStep && now - h.lastStep < c.stepMin * MIN;
    if (!steps) { h.why = dec.why + (dec.step ? ' (already ' + MODE_NAME[H['2']] + (boost ? ', curve +' + boost + ' °C' : '') + ' — limit)' : ''); context.set('heat', h); return; }
    if (early && cur <= top) { h.why = dec.why + ' → ' + act + ' after ' + new Date(h.lastStep + c.stepMin * MIN).toTimeString().slice(0, 5); context.set('heat', h); return; }
    if (steps[0].dps === 2 && h.modeCmd === steps[0].set && now - h.modeAt < MIN) { context.set('heat', h); return; }
    const live = md === 'live' && settings.master;
    h.run = now + ':' + HEAT_ID; h.lastStep = now;
    if (steps[0].dps === 2) { h.modeCmd = steps[0].set; h.modeAt = now; }
    else { h.boost = nb; h.p23At = now; h.curveCmd = nb ? curveSteps(nb).cc : null; }
    h.samples = [];   // the next decision only sees the new mode / curve
    h.why = dec.why + ' → ' + act;
    for (const s of steps) {
        if (live) {
            const q = context.get('queue') || [];
            q.push({ rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, role: s.role, dps: s.dps, set: s.set, text: s.text });
            context.set('queue', q);
            logEvent({ kind: 'write', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: true, text: dec.why + ' → ' + act + ': ' + s.text });
            pump();
        } else {
            logEvent({ kind: 'dry', rule: HEAT_ID, cloud: HEAT_NAME, run: h.run, live: false, text: dec.why + ' → would ' + s.text });
        }
    }
    context.set('heat', h);
}

// ---- load ---------------------------------------------------------------------
if (msg.topic === 'load') {
    try {
        const s = JSON.parse(String(msg.payload || '{}'));
        settings = { master: s.master === true, modes: {}, dhw: dhwCfg(s.dhw),
            heatCurve: s.heatCurve && Number.isFinite(s.heatCurve.p23) && Number.isFinite(s.heatCurve.p24) ? s.heatCurve : null,
            dhwLastEnd: Number(s.dhwLastEnd) || 0, heat: heatCfg(s.heat),
            dhwBlock: s.dhwBlock && Number.isFinite(s.dhwBlock.at) ? { at: s.dhwBlock.at, why: String(s.dhwBlock.why || '') } : null,
            dhwRetry: s.dhwRetry && Number.isFinite(s.dhwRetry.at) ? s.dhwRetry : null,
            defrostStarts: Array.isArray(s.defrostStarts) ? s.defrostStarts.filter(Number.isFinite).slice(-8) : [] };
        for (const r of RULES) if (s.modes && MODES.includes(s.modes[r.id])) settings.modes[r.id] = s.modes[r.id];
        for (const id of [DHW_ID, HEAT_ID]) if (s.modes && MODES.includes(s.modes[id])) settings.modes[id] = s.modes[id];
        persist();
        logEvent({ kind: 'setting', text: 'settings loaded: local control ' + (settings.master ? 'ON' : 'OFF') });
    } catch (e) {
        settings = { master: false, modes: {} };
        persist();
        logEvent({ kind: 'warn', text: 'settings file unreadable, local control OFF: ' + e.message });
    }
    node.status({ fill: settings.master ? 'green' : 'grey', shape: 'dot', text: 'master ' + (settings.master ? 'ON' : 'OFF') });
    return [{ payload: model() }, null, null, null, null, null];
}

// ---- ui -----------------------------------------------------------------------
if (msg.topic === 'ui') {
    const p = msg.payload || {};
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
        settings.modes[DHW_ID] = p.mode;
        persist();
        logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: 'controller set to ' + MODE_LABEL[p.mode]
            + (p.mode !== 'live' ? ' — no other rule heats the tank now' : '') });
        publishView();
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'mode' && p.id === HEAT_ID) {
        if (!MODES.includes(p.mode)) { node.warn('Heat pump automations: bad heating mode ' + JSON.stringify(p)); return null; }
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
        settings.modes[r.id] = p.mode;
        persist();
        logEvent({ kind: 'setting', rule: r.id, cloud: r.cloud, text: 'rule set to ' + MODE_LABEL[p.mode] });
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'modeAll') {
        if (!MODES.includes(p.mode)) { node.warn('Heat pump automations: bad modeAll request ' + JSON.stringify(p)); return null; }
        for (const r of RULES) settings.modes[r.id] = p.mode;
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
{
    const hpd = (st.hp && st.hp.dps) || {};
    const inDef = ready('hp') && n(hpd['116']) === 0 && n(hpd['115']) > 30;
    if (inDef) context.set('lastDefrost', now);
    // d#169: defrost starts (edge), kept in the settings file for the next-defrost forecast
    // d#170: supply just before the defrost — the recovery ends when the supply is back there (or at the set point)
    if (!inDef && !(context.get('bypassWasOn')) && Number.isFinite(Number(hpd['102'])) && hpd['102'] !== null && n(hpd['116']) > 0) context.set('supBefore', Number(hpd['102']));
    context.set('bypassWasOn', ((st.bypass && st.bypass.dps) || {})['1'] === true);
    if (inDef && !context.get('inDefrost')) {
        context.set('preDefSupply', context.get('supBefore'));
        settings.defrostStarts = (settings.defrostStarts || []).filter((x) => now - x < 12 * 3600 * 1000).concat([now]).slice(-8);
        persist(); send(2, saveMsg());
    }
    context.set('inDefrost', inDef);
}
const recentDefrost = now - (context.get('lastDefrost') || 0) < DEFROST_QUIET_MIN * MIN;
// d#170: the supply drop of a defrost and its recovery are not a lag of the curve. From a defrost until the
// supply is back at the heating set − supplyReady (at most 60 min after it) the heating controller and the
// DHW "heating lags" check ignore supply − curve; the heating controller keeps its samples from before.
const defRecovering = (() => {
    const hpd = (st.hp && st.hp.dps) || {};
    const last = context.get('lastDefrost') || 0;
    if (!last || now - last >= 60 * MIN) return false;
    if (recentDefrost) return true;
    const sup = hpd['102'] === null ? NaN : Number(hpd['102']), set = hpd['125'] === null ? NaN : Number(hpd['125']);
    const ready = ((settings.dhw || {}).supplyReady !== undefined ? settings.dhw.supplyReady : DHW_DEFAULTS.supplyReady);
    const pre = Number(context.get('preDefSupply'));
    const goal = Number.isFinite(pre) ? Math.min(set - ready, pre - 0.5) : set - ready;
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
dhwTick();
heatTick();
// d#134: the Heat Pump page (34 / 35) draws the boiler curve next to the heating curve
publishView();
persist();
const liveCount = RULES.filter((r) => modeOf(r.id) === 'live').length;
const running = Object.keys(context.get('seqs') || {}).length;
node.status({ fill: settings.master ? 'green' : 'grey', shape: running ? 'dot' : 'ring',
    text: 'master ' + (settings.master ? 'ON' : 'OFF') + ' · on ' + liveCount + '/' + RULES.length + ' · flag ' + ((context.get('flag') || flag).on ? 'ON' : 'OFF') + (running ? ' · running ' + running : '') });
return [{ payload: model() }, null, null, null, null, null];
