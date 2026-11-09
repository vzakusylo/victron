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
// INIT — the node's On Start code (`initialize`, kept in flows.json; Sync-40 syncs only `func`):
//    context.set('needLoad', context.get('settings') === undefined);
//    const old = Object.keys(context.get('seqs') || {}); const oldQ = (context.get('queue') || []).length;
//    context.set('seqs', {}); context.set('queue', []); context.set('pumping', false);
//    context.set('bootNote', { dropped: old.length + oldQ, text: 'automations node started'
//        + (old.length ? '; running sequences dropped: ' + old.join(', ') : '') + (oldQ ? '; ' + oldQ + ' queued writes dropped' : '') });
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
const set = (v) => ({ role: 'hp', dps: 125, set: v, text: 'set point ' + v + ' °C' });
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
        // after "wait 3 min" the cloud starts the tap-to-run scene "Slowly cool down" (set 39,
        // 2 min, set 38, 3 min, set 37; read 2026-11-09) and sets P22 on right away; the scene's
        // steps then run on in parallel — here in the same order and timing
        steps: [set(41), wait(10 * S), valve(false), set(41), wait(MIN), set(39), wait(MIN), valve(false), mode('mute'), wait(3 * MIN),
            set(39), p22(true), wait(2 * MIN), set(38), wait(3 * MIN), set(37)] },

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
        when: 'tank < 47, outdoor > 1, valve OFF, flag OFF, bypass OFF, heat pump on; not during / ' + DEFROST_QUIET_MIN + ' min after a defrost (outdoor sensor reads high then)',
        roles: ['hp', 'valve', 'bypass'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v, bypass: b, flag, recentDefrost }) => n(hp['108']) < 47 && n(hp['103']) > 1 && v['1'] === false && !flag && b['1'] === false && hp['1'] === true && n(hp['125']) !== 50 && !recentDefrost,
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
        when: 'set point = 50, valve OFF, bypass OFF, tank < 50; not during / ' + DEFROST_QUIET_MIN + ' min after a defrost',
        roles: ['hp', 'valve', 'bypass'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v, bypass: b, recentDefrost }) => n(hp['125']) === 50 && v['1'] === false && b['1'] === false && n(hp['108']) < 50 && !recentDefrost,
        steps: [bypass(true)] },

    // B42 mode
    { id: 'b42_mode_smart', cloud: 'B42 mode silent-smart <44', group: 'B42 · outdoor −10…−5 °C',
        name: 'B42: Silent → Smart when supply < 44 °C',
        when: 'mode Silent, set point = 42, supply < 44',
        roles: ['hp'], cooldownMs: 10 * MIN,
        check: ({ hp }) => hp['2'] === 'mute' && n(hp['125']) === 42 && n(hp['102']) < 44,
        steps: [mode('smart')] },
    { id: 'b42_mode_smart45', cloud: 'B42 mode silent-smart <45', group: 'B42 · outdoor −10…−5 °C', def: 'off',
        name: 'B42: Silent → Smart when supply < 45 °C, fan > 300',
        when: 'mode Silent, supply < 45, fan > 300, set point = 42',
        roles: ['hp'], cooldownMs: 10 * MIN,
        check: ({ hp }) => hp['2'] === 'mute' && n(hp['102']) < 45 && n(hp['116']) > 300 && n(hp['125']) === 42,
        steps: [mode('smart')] },
    { id: 'b42_mode_silent_valve', cloud: 'B42 mode smart-silent >6a', group: 'B42 · outdoor −10…−5 °C', def: 'off',
        name: 'B42: Smart → Silent when supply > 44 °C (valve on DHW)',
        when: 'set point = 42, supply > 44, mode Smart, valve ON',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v }) => n(hp['125']) === 42 && n(hp['102']) > 44 && hp['2'] === 'smart' && v['1'] === true,
        steps: [mode('mute')] },
    { id: 'b42_mode_powerful_silent', cloud: 'B42 mode powerful-silent >45', group: 'B42 · outdoor −10…−5 °C', def: 'off',
        name: 'B42: Smart / Powerful → Silent when supply > 45 °C',
        when: 'supply > 45, fan > 300, set point = 42, mode Smart or Powerful',
        roles: ['hp'], cooldownMs: 10 * MIN,
        check: ({ hp }) => n(hp['102']) > 45 && n(hp['116']) > 300 && n(hp['125']) === 42 && (hp['2'] === 'smart' || hp['2'] === 'strong'),
        steps: [mode('mute')] },

    // B46 mode
    { id: 'b46_mode_silent', cloud: 'B46 mode smart-silent >48', group: 'B46 · outdoor −4…1 °C', def: 'off',
        name: 'B46: Smart → Silent when supply > 48 °C',
        when: 'mode Smart, set point = 46, supply > 48',
        roles: ['hp'], cooldownMs: 10 * MIN,
        check: ({ hp }) => hp['2'] === 'smart' && n(hp['125']) === 46 && n(hp['102']) > 48,
        steps: [mode('mute')] },

    // B50 work mode
    { id: 'b50_force_heating', cloud: 'B50 force heating mode', group: 'B50 · outdoor > 1 °C', def: 'off',
        name: 'B50: work mode Cooling → Heating',
        when: 'set point = 50, work mode Cooling',
        roles: ['hp'], cooldownMs: 10 * MIN,
        check: ({ hp }) => n(hp['125']) === 50 && hp['5'] === 'cool',
        steps: [workMode('heat')] },

    // Heat pump (HP scenes)
    { id: 'hp_silent_0', cloud: 'HP silent >0', group: 'Heat pump', def: 'off',
        name: 'Heating above 0 °C outdoor → Silent',
        when: 'outdoor > 0, flag OFF, set point < 40, valve OFF (and not already Silent)',
        roles: ['hp', 'valve'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v, flag }) => n(hp['103']) > 0 && !flag && n(hp['125']) < 40 && v['1'] === false && hp['2'] !== 'mute',
        steps: [mode('mute')] },
    { id: 'hp_er03_restart', cloud: 'HP Er03 restart', group: 'Heat pump', def: 'off',
        name: 'Er03 water flow failure on DHW → valve back, restart the pump',
        when: 'fault Er03 (water flow), valve ON',
        roles: ['hp', 'valve'], cooldownMs: 30 * MIN,
        check: ({ hp, valve: v }) => (n(hp['15']) & 1) === 1 && v['1'] === true,
        // cloud also disables the scene "zz boiler 50 on <47 >1" (already off, not included)
        steps: [valve(false), wait(30 * S), valve(false), power(false), wait(MIN), power(true), bypass(false), set(31), p22(true)] },
    { id: 'hp_power_m16', cloud: 'HP power <-16 (dead)', group: 'Heat pump', def: 'off',
        name: 'Below −16 °C → Powerful (cloud conditions can never be true)',
        when: 'outdoor < −16, fan > 250, set point < 37 and > 37, mode Smart or Silent',
        roles: ['hp'], cooldownMs: 30 * MIN,
        check: ({ hp }) => n(hp['103']) < -16 && n(hp['116']) > 250 && n(hp['125']) < 37 && n(hp['125']) > 37 && (hp['2'] === 'smart' || hp['2'] === 'mute'),
        steps: [mode('strong'), note('HP power <-16')] },
    { id: 'hp_smart_m15', cloud: 'HP smart -15..-7 (dead)', group: 'Heat pump', def: 'off',
        name: '−15…−7 °C → Smart (cloud conditions can never be true)',
        when: 'outdoor −15…−7, fan > 250, set point < 35 and > 35, supply > 30, mode Powerful or Silent',
        roles: ['hp'], cooldownMs: 30 * MIN,
        check: ({ hp }) => n(hp['103']) < -7 && n(hp['103']) > -15 && n(hp['116']) > 250 && n(hp['125']) < 35 && n(hp['125']) > 35 && n(hp['102']) > 30 && (hp['2'] === 'strong' || hp['2'] === 'mute'),
        steps: [mode('smart'), wait(15 * MIN), note('HP smart -15..-7')] },

    // Boiler safety
    { id: 'b_recovery_valve_off', cloud: 'B recovery off', group: 'Boiler safety',
        name: 'Recovery: valve back to heating',
        when: 'valve ON while the set point is a heating value (33 / 35 / 36 / 37)',
        roles: ['hp', 'valve'], cooldownMs: 10 * MIN,
        check: ({ hp, valve: v }) => v['1'] === true && [33, 35, 36, 37].includes(n(hp['125'])),
        steps: [valve(false)] }
];
const OUT = { hp: 1, bypass: 3, valve: 4 };
const OUT_LOG = 5;

// ---- DHW controller settings (d#130, docs/heat-pump-dhw-controller.md) ------------
const DHW_ID = 'dhw';
const DHW_NAME = 'DHW controller';
const DHW_DEFAULTS = {
    curve: [[-15, 40], [-10, 42], [-5, 44], [0, 46], [2, 49]],   // outdoor °C → tank target °C
    frostLimit: -20,     // below: no DHW by the heat pump (electric heater only)
    hyst: 3,             // start when tank < target − hyst
    gap: 5,              // DHW: set point ≤ return + gap
    switchMargin: 3,     // switch when supply ≥ tank + margin (it drops 1–2 °C while the compressor stops)
    preheatAdd: 4,       // preheat set point goal = tank + preheatAdd
    supplyAdd: 4,        // DHW supply target = tank target + supplyAdd
    maxSupply: 55,       // set point cap
    minIntervalH: 2,     // at most one DHW cycle per … h
    maxMin: 60,          // max DHW cycle at ≥ −5 °C outdoor …
    maxMinCold: 30,      // … falling linearly to this at ≤ −15 °C
    coldLimit: -10,      // below: no DHW start while heating lags
    lagC: 2,             // heating lags = 30-min supply average > lagC below the heating curve
    allowPowerful: false
};
const DHW_LIMITS = { frostLimit: [-30, 10], hyst: [1, 10], gap: [3, 10], switchMargin: [0, 5], preheatAdd: [1, 10],
    supplyAdd: [1, 10], maxSupply: [45, 55], minIntervalH: [0, 12], maxMin: [15, 180], maxMinCold: [10, 180],
    coldLimit: [-25, 5], lagC: [1, 10] };
// Local rules the controller replaces: they are treated as Off while the controller is On.
const DHW_REPLACES = ['b40_on', 'b40_switch', 'b40_off', 'b42_on', 'b42_switch', 'b42_off', 'b42_mode_smart', 'b42_mode_smart45',
    'b42_mode_silent_valve', 'b42_mode_powerful_silent', 'b46_on', 'b46_switch', 'b46_off', 'b46_mode_silent', 'b50_on',
    'b50_switch_warm', 'b50_switch_cold', 'b50_off', 'b50_preheat_bypass', 'b50_force_heating', 'df_switch_to_heating',
    'b_recovery_valve_off', 'hp_silent_0'];
// raw values that are missing or out of range keep the value of `base` (default: DHW_DEFAULTS)
function dhwCfg(raw, base) {
    const c = JSON.parse(JSON.stringify(base || DHW_DEFAULTS));
    const r = raw || {};
    for (const k of Object.keys(DHW_LIMITS)) {
        const v = Number(r[k]);
        if (r[k] !== undefined && Number.isFinite(v) && v >= DHW_LIMITS[k][0] && v <= DHW_LIMITS[k][1]) c[k] = v;
    }
    if (typeof r.allowPowerful === 'boolean') c.allowPowerful = r.allowPowerful;
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
// kept: the node's On Start code (`initialize` in flows.json, see INIT below the header) drops
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

// ---- DHW controller (d#130) ----------------------------------------------------------
// One state machine instead of the B* rules: tank target from the outdoor curve, preheat
// until the supply reaches the tank, compressor stop (set point 20), valve to the tank,
// set point ramped and kept ≤ return + gap, power Silent → Smart (→ Powerful) only when the
// supply does not rise, defrost during DHW on the heating side, smooth ramp back to heating.
// States: HEATING → PREHEAT → STOP → DHW (⇄ DEFROST_DHW) → RAMPDOWN → HEATING.
function dhwState() {
    return ctx('dhw', { state: 'HEATING', since: now, run: null, live: false, lastEnd: 0, setCmd: null, rampAt: 0,
        startAt: 0, startTank: null, streak: 0, outS: [], outAvg: null, lagS: [], prog: null, defTicks: 0, fanOkSince: 0,
        valveOnSince: 0, goal: null, why: '', waitNote: '' });
}
function dhwModel() {
    const d = dhwState(), c = dhwCfgNow();
    const out = d.outAvg;
    return { mode: modeOf(DHW_ID), state: d.state, since: d.since, why: d.why, waitNote: d.waitNote, outAvg: out,
        target: out === null ? null : (out < c.frostLimit ? null : curveAt(c.curve, out)), frost: out !== null && out < c.frostLimit,
        setCmd: d.setCmd, startTank: d.startTank, startAt: d.startAt, lastEnd: d.lastEnd,
        nextStart: d.lastEnd ? d.lastEnd + c.minIntervalH * 3600 * 1000 : 0, lag: dhwLag(d), cfg: c, replaced: DHW_REPLACES };
}
function dhwLag(d) {
    const s = d.lagS || [];
    if (s.length < 20 || s[s.length - 1][0] - s[0][0] < 20 * MIN) return null;
    return Math.round(s.reduce((a, x) => a + x[1], 0) / s.length * 10) / 10;
}
function dhwTick() {
    const d = dhwState(), c = dhwCfgNow();
    const md = modeOf(DHW_ID);
    const liveNow = md === 'live' && settings.master;
    const H = (st.hp && st.hp.dps) || {}, V = (st.valve && st.valve.dps) || {}, B = (st.bypass && st.bypass.dps) || {};
    const sup = n(H['102']), ret = n(H['101']), tank = n(H['108']), out = n(H['103']), hz = n(H['115']), fan = n(H['116']);
    const valveOn = V['1'] === true, bypassOn = B['1'] === true;
    const defNow = fan === 0 && hz > 30;
    const devOk = ready('hp') && ready('valve') && ready('bypass');
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
    const setTo = (v) => { v = Math.max(20, Math.min(c.maxSupply, Math.round(v))); if (d.setCmd !== v) { d.setCmd = v; d.rampAt = now; write(set(v)); } };
    const modeTo = (m) => {
        if (H['2'] === m) { d.modeCmd = null; return; }
        if (d.modeCmd === m && now - (d.modeAt || 0) < MIN) return;   // sent, wait for the device
        d.modeCmd = m; d.modeAt = now; write(mode(m));
    };

    // outdoor: 10-min average outside defrosts (the sensor reads 30–47 °C during / after them)
    if (ready('hp') && Number.isFinite(out) && !recentDefrost && !defNow) d.outS.push([now, out]);
    d.outS = d.outS.filter((x) => now - x[0] <= 10 * MIN);
    if (d.outS.length) d.outAvg = Math.round(d.outS.reduce((a, x) => a + x[1], 0) / d.outS.length * 10) / 10;
    // heating lag: 30-min average of supply − heating curve while heating runs
    if (d.state === 'HEATING' && ready('hp') && !valveOn && !bypassOn && !recentDefrost && hz > 0 && d.outAvg !== null
        && Number.isFinite(n(H['133'])) && Number.isFinite(n(H['134']))) {
        d.lagS.push([now, sup - heatCurveAt(n(H['133']), n(H['134']), d.outAvg)]);
    }
    d.lagS = d.lagS.filter((x) => now - x[0] <= 30 * MIN);

    // controller switched off / local control OFF during a cycle → back to heating
    if (d.state !== 'HEATING' && (md === 'off' || (d.live && !liveNow))) {
        if (d.live && settings.master) { write(valve(false), true); write(bypass(false), true); write(p22(true), true); }
        go('HEATING', 'cycle stopped (' + (md === 'off' ? 'controller Off' : 'local control OFF or controller no longer On') + ')' + (d.live && settings.master ? ': valve OFF, bypass OFF, P22 on' : ''), 'stop');
        d.run = null; d.setCmd = null; d.lastEnd = now;
        context.set('dhw', d); return;
    }
    if (md === 'off') { d.why = 'controller Off'; context.set('dhw', d); return; }
    if (!devOk) { d.waitNote = 'device not connected / stale'; context.set('dhw', d); return; }
    d.waitNote = '';
    const target = d.outAvg === null ? null : (d.outAvg < c.frostLimit ? null : curveAt(c.curve, d.outAvg));
    const elapsed = now - d.since;
    const cycleMin = (now - d.startAt) / MIN;
    const maxDur = d.outAvg === null || d.outAvg >= -5 ? c.maxMin : d.outAvg <= -15 ? c.maxMinCold
        : c.maxMin + (c.maxMinCold - c.maxMin) * (-5 - d.outAvg) / 10;
    const endCycle = (why) => {
        go('RAMPDOWN', 'end of DHW (' + why + '): tank ' + d.startTank + ' → ' + tank + ' °C after ' + Math.round(cycleMin) + ' min → valve to heating, set point down to the heating curve');
        if (valveOn) write(valve(false));
        if (bypassOn) write(bypass(false));
        modeTo('mute');
        d.goal = d.outAvg === null || !Number.isFinite(n(H['133'])) ? 35 : Math.round(heatCurveAt(n(H['133']), n(H['134']), d.outAvg));
        d.rampAt = now;
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
        const why = [];
        if (target === null) why.push(d.outAvg === null ? 'no outdoor value yet' : 'outdoor ' + d.outAvg + ' °C below the frost limit ' + c.frostLimit + ' °C (electric heater only)');
        else if (!(tank < target - c.hyst)) why.push('tank ' + tank + ' °C ≥ ' + (target - c.hyst) + ' °C (target ' + target + ' − ' + c.hyst + ')');
        if (d.lastEnd && now - d.lastEnd < c.minIntervalH * 3600 * 1000) why.push('last cycle ' + Math.round((now - d.lastEnd) / MIN) + ' min ago (min ' + c.minIntervalH + ' h)');
        if (defNow || recentDefrost) why.push('defrost now or < ' + DEFROST_QUIET_MIN + ' min ago');
        if ((context.get('flag') || flag).on) why.push('defrost flag ON');
        if (valveOn) why.push('valve ON');
        if (H['1'] !== true) why.push('heat pump off');
        const lag = dhwLag(d);
        if (d.outAvg !== null && d.outAvg < c.coldLimit && lag !== null && lag < -c.lagC) why.push('heating lags ' + lag + ' °C below its curve at ' + d.outAvg + ' °C (heating first)');
        d.why = why.length ? why.join('; ') : 'start conditions met';
        d.streak = why.length ? 0 : d.streak + 1;
        if (d.streak >= HOLD) {
            d.streak = 0; d.run = now + ':' + DHW_ID; d.live = liveNow; d.startAt = now; d.startTank = tank; d.prog = null;
            logEvent({ kind: d.live ? 'start' : 'test', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live,
                text: (d.live ? 'start' : 'test, would start') + ': tank ' + tank + ' °C < target ' + target + ' − ' + c.hyst + ' at outdoor ' + d.outAvg + ' °C → preheat (bypass ON, P22 off, Silent)' });
            d.goal = Math.min(c.maxSupply, Math.round(tank + c.preheatAdd));
            d.setCmd = Number.isFinite(n(H['125'])) ? n(H['125']) : 35;
            write(p22(false)); modeTo('mute'); if (!bypassOn) write(bypass(true));
            go('PREHEAT', 'preheat: set point ramps ' + d.setCmd + ' → ' + d.goal + ' °C, switch at supply ≥ ' + (tank + c.switchMargin) + ' °C and return ≥ ' + (tank - 5) + ' °C');
        }
        break;
    }
    case 'PREHEAT': {
        if (defNow) { d.why = 'defrost during preheat — waiting'; break; }
        if (d.setCmd < d.goal && now - d.rampAt >= 30 * S) setTo(d.setCmd + 1);
        if (sup >= tank + c.switchMargin && ret >= tank - 5) {
            write(set(20)); d.setCmd = 20;
            go('STOP', 'supply ' + sup + ' °C ≥ tank ' + tank + ' + ' + c.switchMargin + ', return ' + ret + ' °C → set point 20 (compressor stops) before the valve switch');
        } else if (elapsed >= 30 * MIN) {
            endCycle('preheat did not reach the tank temperature in 30 min');
        } else if (elapsed >= 20 * MIN && H['2'] === 'mute') {
            modeTo('smart'); logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'preheat slow (20 min) → Smart' });
        }
        d.why = 'preheat: supply ' + sup + ' / return ' + ret + ' °C, need ≥ ' + (tank + c.switchMargin) + ' / ' + (tank - 5);
        break;
    }
    case 'STOP': {
        if ((hz === 0 && elapsed >= 20 * S) || elapsed >= MIN) {
            write(valve(true));
            const want = Math.min(c.maxSupply, target === null ? 45 : target + c.supplyAdd, Math.round(ret) + c.gap);
            d.setCmd = null; setTo(Math.max(30, want));
            if (bypassOn) write(bypass(false));
            d.prog = { t: now, sup }; d.defTicks = 0;
            go('DHW', 'valve to the tank, bypass OFF, set point ' + d.setCmd + ' °C (≤ return ' + ret + ' + ' + c.gap + ')');
        }
        d.why = 'waiting for the compressor to stop (' + hz + ' Hz)';
        break;
    }
    case 'DHW': {
        const supTarget = Math.min(c.maxSupply, (target === null ? 45 : target) + c.supplyAdd);
        const want = Math.min(supTarget, Math.round(ret) + c.gap);
        if (defNow) {
            d.defTicks++;
            if (d.defTicks >= 2) {
                write(valve(false)); if (!bypassOn) write(bypass(true));
                d.fanOkSince = 0;
                go('DEFROST_DHW', 'defrost during DHW → valve to heating, bypass ON (the tank is not cooled)');
                break;
            }
        } else d.defTicks = 0;
        if (target !== null && tank >= target) { endCycle('tank at target ' + target + ' °C'); break; }
        if (cycleMin >= maxDur) { endCycle('max duration ' + Math.round(maxDur) + ' min at ' + d.outAvg + ' °C outdoor'); break; }
        if (!valveOn && elapsed >= MIN) { endCycle('valve switched to heating by someone else'); break; }
        if (want > d.setCmd && now - d.rampAt >= MIN) setTo(d.setCmd + 1);
        else if (want < d.setCmd && now - d.rampAt >= 30 * S) setTo(d.setCmd - 1);
        // power: up only when the supply does not rise; back to Silent near the target
        if (d.prog && now - d.prog.t >= 10 * MIN) {
            const rise = sup - d.prog.sup;
            if (sup < want - 3 && rise < 2) {
                if (H['2'] === 'mute') { modeTo('smart'); logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'supply rose only ' + rise + ' °C in 10 min → Smart' }); }
                else if (H['2'] === 'smart' && c.allowPowerful) { modeTo('strong'); logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'supply rose only ' + rise + ' °C in 10 min → Powerful' }); }
            }
            d.prog = { t: now, sup };
        }
        if (H['2'] !== 'mute' && sup >= want - 1) modeTo('mute');
        d.why = 'DHW: tank ' + tank + ' → ' + target + ' °C, supply ' + sup + ' / return ' + ret + ', set point ' + d.setCmd + ' (≤ return + ' + c.gap + ', max ' + supTarget + '), ' + Math.round(cycleMin) + ' / ' + Math.round(maxDur) + ' min';
        break;
    }
    case 'DEFROST_DHW': {
        if (!defNow && fan > 300) { if (!d.fanOkSince) d.fanOkSince = now; } else d.fanOkSince = 0;
        if (cycleMin >= maxDur) { endCycle('max duration during a defrost'); break; }
        if (d.fanOkSince && now - d.fanOkSince >= MIN) {
            d.goal = Math.min(c.maxSupply, Math.round(tank + c.preheatAdd)); d.rampAt = now;
            go('PREHEAT', 'defrost over → preheat again (supply must reach the tank ' + tank + ' °C before the valve switch)');
        }
        d.why = 'defrost during DHW: valve on heating, waiting for the fan';
        break;
    }
    case 'RAMPDOWN': {
        if (d.setCmd === null || d.setCmd <= d.goal) {
            write(p22(true));
            d.lastEnd = now;
            go('HEATING', 'back to heating: P22 on (curve)', 'done');
            d.run = null; d.setCmd = null;
        } else if (now - d.rampAt >= MIN) setTo(Math.max(d.goal, d.setCmd - 1));
        d.why = 'set point down to ' + d.goal + ' °C, 1 °C per minute';
        break;
    }
    default:
        go('HEATING', 'unknown state reset', 'warn');
    }
    context.set('dhw', d);
}

// ---- load ---------------------------------------------------------------------
if (msg.topic === 'load') {
    try {
        const s = JSON.parse(String(msg.payload || '{}'));
        settings = { master: s.master === true, modes: {}, dhw: dhwCfg(s.dhw) };
        for (const r of RULES) if (s.modes && MODES.includes(s.modes[r.id])) settings.modes[r.id] = s.modes[r.id];
        if (s.modes && MODES.includes(s.modes[DHW_ID])) settings.modes[DHW_ID] = s.modes[DHW_ID];
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
            + (p.mode === 'live' ? ' — the ' + DHW_REPLACES.length + ' B* / mode / recovery rules it replaces are Off now' : '') });
        return [{ payload: model() }, null, saveMsg(), null, null, null];
    }
    if (p.action === 'dhwSet' && p.cfg && typeof p.cfg === 'object') {
        const before = JSON.stringify(dhwCfgNow());
        settings.dhw = dhwCfg(p.cfg, dhwCfgNow());
        persist();
        const after = JSON.stringify(settings.dhw);
        logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: before === after ? 'settings unchanged (values out of range are ignored)' : 'settings saved: ' + after });
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
    if (ready('hp') && n(hpd['116']) === 0 && n(hpd['115']) > 30) context.set('lastDefrost', now);
}
const recentDefrost = now - (context.get('lastDefrost') || 0) < DEFROST_QUIET_MIN * MIN;

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
    if (modeOf(DHW_ID) === 'live' && DHW_REPLACES.includes(r.id)) { rt.ok = false; rt.streak = 0; rt.detail = 'replaced by the DHW controller (On)'; continue; }
    if (seqs[r.id]) { rt.ok = false; rt.streak = 0; rt.detail = 'running step ' + (seqs[r.id].idx + 1) + '/' + seqs[r.id].total; continue; }
    const notReady = r.roles.filter((role) => !ready(role));
    if (notReady.length) { rt.ok = false; rt.streak = 0; rt.detail = notReady.join(', ') + ' not connected / stale'; continue; }
    const c = { hp: (st.hp && st.hp.dps) || {}, valve: (st.valve && st.valve.dps) || {}, bypass: (st.bypass && st.bypass.dps) || {}, flag: flag.on, recentDefrost };
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
persist();
const liveCount = RULES.filter((r) => modeOf(r.id) === 'live').length;
const running = Object.keys(context.get('seqs') || {}).length;
node.status({ fill: settings.master ? 'green' : 'grey', shape: running ? 'dot' : 'ring',
    text: 'master ' + (settings.master ? 'ON' : 'OFF') + ' · on ' + liveCount + '/' + RULES.length + ' · flag ' + ((context.get('flag') || flag).on ? 'ON' : 'OFF') + (running ? ' · running ' + running : '') });
return [{ payload: model() }, null, null, null, null, null];
