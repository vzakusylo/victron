// ==========================
// SAVE CONTROLLER CONSTANTS
// ==========================
// Source of the function node "Save controller constants" in flows.json.
// Purpose:
// - Validates the values sent by the Constants page against flow `controllerConstantsSpec`
//   (defaults, ranges and kinds, published by "Build controller constants state", 24).
// - Stores only the values that differ from the default in flow `controllerConstantsOverrides`
//   and in the config file. The controller reads the overrides on its next run (no redeploy).
// Config file:
// - /data/home/nodered/grid-control-config/controller-constants.json
// Input:
// - msg.topic = 'save-controller-constants', msg.payload = { KEY: value, ... } (the whole form;
//   `{}` resets everything to the defaults)
// Outputs (2):
// - output 1 -> file write msg (filename + payload JSON string)
// - output 2 -> status msg for the dashboard
// ==========================

const CONFIG_PATH = '/data/home/nodered/grid-control-config/controller-constants.json';

function isValidMmdd(value) {
    const month = Math.floor(value / 100);
    const day = value % 100;
    // 2024 is a leap year, so 29 Feb is accepted.
    return month >= 1 && month <= 12 && day >= 1 && day <= new Date(2024, month, 0).getDate();
}

function status(ok, message, extra) {
    return { topic: 'controller-constants-save-status', payload: Object.assign({ ok, message }, extra) };
}

if (msg.topic !== 'save-controller-constants' || !msg.payload || typeof msg.payload !== 'object') {
    return null;
}

const spec = flow.get('controllerConstantsSpec');
if (!spec) {
    return [null, status(false, 'Constants are not loaded yet. Reload the page and try again.')];
}

const errors = [];
const overrides = {};

Object.keys(msg.payload).forEach(key => {
    const field = spec[key];
    if (!field) {
        return; // unknown key
    }
    const value = Number(msg.payload[key]);
    if (msg.payload[key] === null || msg.payload[key] === '' || !Number.isFinite(value)) {
        errors.push(`${key}: not a number`);
    }
    else if (value < field.min || value > field.max) {
        errors.push(`${key}: ${value} out of range [${field.min}–${field.max}]`);
    }
    else if (field.kind !== 'number' && !Number.isInteger(value)) {
        errors.push(`${key}: ${value} must be a whole number`);
    }
    else if (field.kind === 'mmdd' && !isValidMmdd(value)) {
        errors.push(`${key}: ${value} is not a valid MMDD date (e.g. 1017 = 17 Oct)`);
    }
    else if (value !== field.def) {
        overrides[key] = value;
    }
});

if (errors.length > 0) {
    return [null, status(false, 'Validation errors: ' + errors.join('; '), { errors })];
}

flow.set('controllerConstantsOverrides', overrides);

const count = Object.keys(overrides).length;
return [
    { filename: CONFIG_PATH, payload: JSON.stringify(overrides, null, 2), encoding: 'utf8' },
    status(true, `Saved ${count} override(s). The controller uses them from its next update.`, { overrideCount: count, savedAt: new Date().toISOString() })
];
