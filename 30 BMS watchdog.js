// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `30 BMS watchdog.js` and the embedded `func` for "BMS watchdog"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Keeps DVCC "Controlling BMS" pointed at the SerialBattery. After a reboot it was found empty
//   (com.victronenergy.system /ActiveBmsService = []), so the MultiPlus raised "BMS connection lost"
//   + "Low battery" and stayed in Passthru until the BMS was selected again by hand.
// How it works (every 30 s, via the dbus CLI in the exec node, works as user `nodered`):
// - reads /ActiveBmsService (system), /Settings/SystemSetup/BmsInstance (settings), the SerialBattery
//   /Connected, and the VE.Bus /State + BMS-lost / low-battery alarms
// - while a BMS is active, the current BmsInstance value is remembered in
//   /data/home/nodered/grid-control-config/bms-watchdog-good.txt (exact value, no format guessing)
// - when no BMS is active for 2 checks in a row while the SerialBattery is connected, the remembered
//   value is written back to /Settings/SystemSetup/BmsInstance (at most once per 5 minutes) and a GX
//   notification is raised
// - a VE.Bus system still in Passthru (state 8) with "BMS connection lost" while a BMS is active is only
//   reported (restarting VE.Bus automatically would interrupt the inverter)
// Inputs:
// - inject tick (any topic) -> start a check
// - topic `bms-watchdog-exec` (exec stdout) -> evaluate
// Outputs (2):
// - output 1 -> exec "Run BMS watchdog" (`sh -c <payload>`)
// - output 2 -> "Format GX notification" (msg.notification = { title, message, type })
// Flow context:
// - `bmsWatchdogState` (also shown on the Device page)
// Change notes:
// 1. Initial version.
// 2. Topic `bms-watchdog-force` (Driver page button) checks immediately and repairs on that check,
//    skipping the 2-check wait and the cooldown. Any other non-exec topic starts a normal check.
// ==========================

const GOOD_FILE = '/data/home/nodered/grid-control-config/bms-watchdog-good.txt';
const STATE_KEY = 'bmsWatchdogState';
const MISSING_CHECKS_BEFORE_REPAIR = 2;
const REPAIR_COOLDOWN_MS = 5 * 60 * 1000;
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const PASSTHRU_GRACE_MS = 2 * 60 * 1000;
const BUSY_TIMEOUT_MS = 25000;
const NOTIFICATION_TITLE = 'BMS watchdog';

function shellQuote(text) {
    return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

const READ_SCRIPT = [
    'F="' + GOOD_FILE + '"',
    'g() { dbus -y "$1" "$2" GetValue 2>/dev/null | sed "s/^value = //"; }',
    'B=$(dbus -y 2>/dev/null | grep -m 1 "^com.victronenergy.battery.tty")',
    'V=$(dbus -y 2>/dev/null | grep -m 1 "^com.victronenergy.vebus")',
    'echo "@@ACTIVE $(g com.victronenergy.system /ActiveBmsService)"',
    'echo "@@SETTING $(g com.victronenergy.settings /Settings/SystemSetup/BmsInstance)"',
    'echo "@@BATT $B"',
    '[ -n "$B" ] && echo "@@CONNECTED $(g "$B" /Connected)"',
    '[ -n "$V" ] && { echo "@@VEBUS $V"; echo "@@VSTATE $(g "$V" /State)"; echo "@@BMSLOST $(g "$V" /Alarms/BmsConnectionLost)"; echo "@@LOWBATT $(g "$V" /Alarms/LowBattery)"; }',
    'echo "@@GOOD $(head -n 1 "$F" 2>/dev/null)"',
    'true'
];

function buildSaveGoodScript(value) {
    return 'mkdir -p "' + GOOD_FILE.replace(/\/[^/]+$/, '') + '" && printf "%s\\n" ' + shellQuote(value) + ' > "' + GOOD_FILE + '" && echo "@@SAVED"';
}

// Writes the remembered value back with the same type it was read with:
// a number -> `%<n>` (dbus CLI integer syntax), a quoted string -> plain string argument.
function buildRepairScript(value) {
    const trimmed = String(value).trim();
    const argument = /^-?\d+$/.test(trimmed)
        ? '%' + trimmed
        : shellQuote(trimmed.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'));
    return 'dbus -y com.victronenergy.settings /Settings/SystemSetup/BmsInstance SetValue ' + argument + ' >/dev/null 2>&1; echo "@@WROTE $?"';
}

function isActiveBms(value) {
    const text = String(value || '').trim();
    return Boolean(text) && !['[]', "''", '""', 'None', '0', 'null'].includes(text);
}

function parse(rawText) {
    const values = {};
    String(rawText || '').split(/\r?\n/).forEach(line => {
        const match = line.match(/^@@([A-Z]+) ?(.*)$/);
        if (match) {
            values[match[1]] = match[2].trim();
        }
    });
    return values;
}

function notify(state, key, type, message, nowTs) {
    state.lastNotified = state.lastNotified || {};
    if (nowTs - (Number(state.lastNotified[key]) || 0) < NOTIFY_COOLDOWN_MS) {
        return null;
    }
    state.lastNotified[key] = nowTs;
    return { notification: { title: NOTIFICATION_TITLE, message, type }, payload: message };
}

function timeLabel(ts) {
    const date = new Date(ts);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

const nowTs = Date.now();
let state = flow.get(STATE_KEY) || { missingCount: 0, busySince: 0, lastRepairAt: 0, passthruSince: 0 };

if (msg.topic !== 'bms-watchdog-exec') {
    // `bms-watchdog-force` (Driver page "Restore Controlling BMS now"): repair on this check,
    // without waiting for the second missing check or the cooldown.
    if (msg.topic === 'bms-watchdog-force') {
        state.forceRepair = true;
    }
    if (state.busySince && nowTs - state.busySince < BUSY_TIMEOUT_MS) {
        flow.set(STATE_KEY, state);
        return null;
    }
    state.busySince = nowTs;
    flow.set(STATE_KEY, state);
    return [{ topic: 'bms-watchdog-exec', bmsWatchdogStep: 'read', payload: shellQuote(READ_SCRIPT.join('\n')) }, null];
}

state.busySince = 0;
const step = msg.bmsWatchdogStep || 'read';
const values = parse(msg.payload);

// Results of a follow-up write: only record them, the next periodic read evaluates again.
if (step === 'save-good') {
    state.goodSavedAt = values.SAVED !== undefined ? nowTs : state.goodSavedAt;
    flow.set(STATE_KEY, state);
    return null;
}

if (step === 'repair') {
    const ok = values.WROTE === '0';
    state.lastRepairResult = ok ? 'written' : 'write failed (exit ' + (values.WROTE || '?') + ')';
    flow.set(STATE_KEY, state);
    node.status({ fill: ok ? 'yellow' : 'red', shape: 'dot', text: timeLabel(nowTs) + ' repair ' + state.lastRepairResult });
    return [null, ok ? null : notify(state, 'repair-failed', 'alarm', 'Could not restore Controlling BMS automatically. Select it in Settings > System setup > Charge control.', nowTs)];
}

const active = values.ACTIVE || '';
const setting = values.SETTING || '';
const good = values.GOOD || '';
const batteryService = values.BATT || '';
const batteryConnected = values.CONNECTED === '1';
const vebusState = values.VSTATE === undefined ? null : Number(values.VSTATE);
const bmsLost = Number(values.BMSLOST) || 0;
const lowBattery = Number(values.LOWBATT) || 0;
const activeOk = isActiveBms(active);

Object.assign(state, {
    checkedAt: new Date(nowTs).toISOString(),
    active,
    setting,
    good,
    batteryService,
    batteryConnected,
    vebusService: values.VEBUS || '',
    vebusState,
    bmsLost,
    lowBattery
});

const outputs = [null, null];
const forced = Boolean(state.forceRepair);
state.forceRepair = false;

if (activeOk) {
    state.missingCount = 0;
    state.status = 'ok';
    state.statusText = 'Active BMS ' + active + (forced ? ' - nothing to restore' : '');

    // Remember the working setting so it can be restored exactly.
    if (setting && setting !== good) {
        outputs[0] = { topic: 'bms-watchdog-exec', bmsWatchdogStep: 'save-good', payload: shellQuote(buildSaveGoodScript(setting)) };
        state.good = setting;
    }

    // Multi did not recover after the BMS came back.
    if (vebusState === 8 && bmsLost > 0) {
        state.passthruSince = state.passthruSince || nowTs;
        if (nowTs - state.passthruSince >= PASSTHRU_GRACE_MS) {
            state.status = 'warning';
            state.statusText = 'BMS active, but MultiPlus still in Passthru with "BMS connection lost" - restart the VE.Bus system';
            outputs[1] = notify(state, 'passthru', 'warning', state.statusText, nowTs);
        }
    }
    else {
        state.passthruSince = 0;
    }
}
else if (!batteryConnected) {
    state.missingCount = 0;
    state.status = 'waiting';
    state.statusText = batteryService ? 'SerialBattery not connected yet (' + batteryService + ')' : 'No SerialBattery service on D-Bus';
}
else {
    state.missingCount = (Number(state.missingCount) || 0) + 1;
    state.status = 'alarm';
    state.statusText = 'No active BMS although ' + batteryService + ' is connected (check ' + state.missingCount + ')';

    if (!good) {
        state.statusText += ' - no remembered setting yet, select Controlling BMS by hand once';
        outputs[1] = notify(state, 'no-good', 'alarm', 'No active BMS: select Controlling BMS in Settings > System setup > Charge control.', nowTs);
    }
    else if (setting === good) {
        state.statusText += ' - setting already correct, waiting for system calc';
        if (state.missingCount >= MISSING_CHECKS_BEFORE_REPAIR * 3) {
            outputs[1] = notify(state, 'stuck', 'alarm', 'No active BMS although Controlling BMS is set. Re-select it in Settings > System setup > Charge control.', nowTs);
        }
    }
    else if (forced || (state.missingCount >= MISSING_CHECKS_BEFORE_REPAIR && nowTs - (Number(state.lastRepairAt) || 0) >= REPAIR_COOLDOWN_MS)) {
        state.lastRepairAt = nowTs;
        state.lastRepairFrom = setting;
        state.statusText = 'Restoring Controlling BMS ' + (setting || '(empty)') + ' -> ' + good;
        outputs[0] = { topic: 'bms-watchdog-exec', bmsWatchdogStep: 'repair', payload: shellQuote(buildRepairScript(good)) };
        outputs[1] = notify(state, 'repair', 'warning', 'Controlling BMS was lost (' + (setting || 'empty') + '); restored automatically to the SerialBattery.', nowTs);
    }
}

flow.set(STATE_KEY, state);
node.status({
    fill: state.status === 'ok' ? 'green' : (state.status === 'waiting' ? 'grey' : (state.status === 'warning' ? 'yellow' : 'red')),
    shape: 'dot',
    text: timeLabel(nowTs) + ' ' + state.statusText
});
return outputs;
