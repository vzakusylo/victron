//! lib/heat-pump/heating-decide.js: heating power controller settings and its pure decision: heatCfg, heatMigrate, heatDecide.
//! Included into "40 Heat pump automations.js" by `// #include` (tools/includes.js); it runs in that
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
// ---- heating power controller (d#166) ---------------------------------------------------
const HEAT_ID = 'heat';
const HEAT_NAME = 'Heating power controller';
// One band around the curve point: below point − bandDown step up (Smart, then curve +1 °C), above point + bandUp step
// down (boost first, then mode). Silent is the default: Smart only while the supply lags, back to Silent at the point.
const HEAT_DEFAULTS = { bandDown: 1.5, bandUp: 1, stepMin: 10, ampPct: 85, allowPowerful: false, maxBoost: 4, maxCurveOffset: 4,
    kickMin: 10, kickSec: 60,     // d#175: supply stuck kickMin below its point → Smart for kickSec, then Silent (0 = off)
    // P2: "not following the curve" warning: 10-min supply average more than bandDown + offCurveC below the point for offCurveMin
    offCurveC: 1, offCurveMin: 45,
    // P6 (advanced): the pump set is point + bandUp and its hysteresis (DP 121) max(2, bandUp + bandDown) °C
    band: false, maxHz: 0, maxP23Step: 0, gentleStepMin: 0, preferSilent: false };
const HEAT_LIMITS = { bandDown: [0, 5], bandUp: [0, 5], stepMin: [10, 60], ampPct: [50, 100], maxBoost: [0, 8], maxCurveOffset: [0, 8], kickMin: [0, 60], kickSec: [20, 300], offCurveC: [0, 5], offCurveMin: [10, 240],
    maxHz: [0, 120], maxP23Step: [0, 40], gentleStepMin: [0, 60] };
const BAND_MIN_HYST = 2;   // the pump's DP 121 accepts 2…18 °C, whole degrees
const BAND_MAX_HYST = 18;
const HEAT_WINDOW_MIN = 10;
const HEAT_CAPACITY_HZ = 85;
const HEAT_CAPACITY_TEXT = 'capacity-limited: compressor at max';
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
    if (typeof r.band === 'boolean') c.band = r.band;
    if (typeof r.preferSilent === 'boolean') c.preferSilent = r.preferSilent;
    c.maxP23Step = Math.floor(c.maxP23Step);
    return c;
}
function gentleDecision(c, state, hz, at) {
    const hot = c.maxHz > 0 && hz > c.maxHz;
    const since = hot ? state.since ?? at : null;
    const minMs = Math.max(3, c.gentleStepMin || 0) * 60000;
    return { hot, since, lower: hot && at - since >= 180000 && (!state.last || at - state.last >= minMs) };
}
// settings saved before the band sliders: lagUp / overC were the band limits and always win over bandDown / bandUp
let heatMigrateNote = '';
function heatMigrate(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    const r = Object.assign({}, raw);
    const half = (v) => Math.min(5, Math.max(0, Math.round(Number(v) * 2) / 2));
    const had = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
    const note = [];
    if (had(r.lagUp)) { r.bandDown = half(r.lagUp); note.push('lagUp ' + r.lagUp + ' → band down ' + r.bandDown); }
    if (had(r.overC)) { r.bandUp = half(r.overC); note.push('overC ' + r.overC + ' → band up ' + r.bandUp); }
    delete r.lagUp; delete r.overC; delete r.gapMax;
    if (note.length) heatMigrateNote = 'heating settings migrated: ' + note.join(', ');
    return r;
}
// pump hysteresis (DP 121) for the band option: DP 121 is a whole number of °C (the pump reports 3 after a 3.5 write), so a
// fractional band is rounded up; else the controller would rewrite it every 2 min for ever (H0)
function bandHystOf(c) { return Math.min(BAND_MAX_HYST, Math.max(BAND_MIN_HYST, Math.ceil(c.bandUp + c.bandDown))); }
// one decision from the 10-min average lag = supply − point: +1 step up, −1 step down, 0 stay (pure, see tests)
// a = { lag, amp, cur (mode index 0…2), boost, atCapacity }
function heatDecide(c, a) {
    if (a.lag === null) return { step: 0, why: 'collecting data' };
    if (a.amp !== null && a.amp >= c.ampPct / 100 * UNIT_MAX_A) {
        const amps = 'current ' + a.amp + ' A ≥ ' + c.ampPct + ' % of ' + UNIT_MAX_A + ' A';
        // P1: already Silent without a boost: nothing to step down, and no step up either (blocked, said so)
        if (!(a.cur > 0) && !a.boost) {
            if (a.atCapacity && a.lag < -c.bandDown) return { step: 0, why: HEAT_CAPACITY_TEXT };
            return { step: 0, blocked: a.lag < -c.bandDown, why: amps + (a.lag < -c.bandDown ? ': no step up although the supply is ' + (-a.lag) + ' °C below the point' : '') };
        }
        return { step: -1, why: amps };
    }
    if (a.lag < -c.bandDown) return a.atCapacity ? { step: 0, why: HEAT_CAPACITY_TEXT }
        : { step: 1, why: 'supply ' + (-a.lag) + ' °C below the point (band −' + c.bandDown + ')' };
    if (a.lag > c.bandUp) return { step: -1, why: 'supply ' + a.lag + ' °C above the point (band +' + c.bandUp + ')' };
    // back to Silent only well inside the band, else Silent <-> Smart flips every step (Smart pushes the supply above the point)
    if (a.cur > 0 && !a.boost && a.lag >= c.bandUp / 2) return { step: -1, why: 'supply ' + a.lag + ' °C above the point (≥ band +' + c.bandUp + ' / 2): back to Silent' };
    return { step: 0, why: 'supply ' + (a.lag >= 0 ? '+' : '') + a.lag + ' °C from the point: inside the band' };
}
