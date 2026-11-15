'use strict';
// Pure classification rules of compare-image.js (kept apart so node --test can load them).

const KNOWN = [
    [/tuya-smart-device.*Key is missing or incorrect/, 'Tuya devices have fake keys'],
    [/Error in setValue: No services available yet/, 'D-Bus service not up yet']
];

// The victron palette asks com.victronenergy.settings for /DeviceInstance while it discovers services; localsettings has no such
// path and answers UnknownObject (found with dbus-monitor, the log line carries no path). Once per start, right after the palette's
// startup line (the log holds all starts); any other UnknownObject is a real error.
const PALETTE_DISCOVERY = 'victron palette: settings has no /DeviceInstance (UnknownObject, localsettings)';
// Independent MQTT connection logging can interleave the two D-Bus discovery lines.
const MQTT_CONNECTED = /^\d{1,2} [A-Za-z]{3} \d{2}:\d{2}:\d{2} - \[info\] \[mqtt-broker:[^\]]+\] Connected to broker: mqtt:\/\/mosquitto:1883$/;

// lines: the nodered log. Returns { unknown: [line], known: Map(reason -> count) }.
function classifyStartLog(lines) {
    const unknown = [], known = new Map();
    let previous = '';
    for (const line of lines) {
        const afterPalette = /Polling is disabled/.test(previous);
        if (line.trim() && !MQTT_CONNECTED.test(line)) previous = line;
        if (/DBUS ERROR MESSAGE .*UnknownObject/.test(line) && afterPalette) { known.set(PALETTE_DISCOVERY, (known.get(PALETTE_DISCOVERY) || 0) + 1); continue; }
        if (!/\[error\]|SyntaxError|ReferenceError|TypeError|DBUS ERROR|Error in /.test(line)) continue;
        const hit = KNOWN.find(([re]) => re.test(line));
        if (hit) known.set(hit[1], (known.get(hit[1]) || 0) + 1);
        else unknown.push(line.trim().slice(0, 160));
    }
    return { unknown, known };
}

// State the flow writes itself while it runs; a changed file with one of these names is not a difference to the backup.
const RUNTIME_STATE_FILES = new Set([
    'grid-control-config/files-dashboard-state.json',
    'grid-control-config/tuya-devices-cloud.json',
    'grid-control-config/tuya-devices-last.json',
    'grid-control-config/tuya-devices-ver.json',
    'grid-control-config/tuya-local-sensors-last.json'
]);

// changed: files outside tools/ whose hash differs. Any other name may be a real difference, so it stays a WARN.
function classifyStateFiles(changed) {
    return {
        expected: changed.filter((file) => RUNTIME_STATE_FILES.has(file)),
        warn: changed.filter((file) => !RUNTIME_STATE_FILES.has(file))
    };
}

module.exports = { classifyStartLog, classifyStateFiles, PALETTE_DISCOVERY };
