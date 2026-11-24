//! @shared
const FRESH_MS = 5 * 60 * 1000;
const DEFROST_QUIET_MIN = 15;
const MIN = 60 * 1000;

function freshAutomationDevice(dev, at) {
    return !!(dev && dev.state === 'CONNECTED' && dev.lastData && at - dev.lastData <= FRESH_MS);
}
function dhwMeasurement(value) {
    return value === null || value === undefined || value === '' || typeof value === 'boolean' ? NaN : Number(value);
}
function defrostReading(hp) {
    const fan = dhwMeasurement(hp['116']), hz = dhwMeasurement(hp['115']);
    if (!Number.isFinite(fan) || fan < 0 || !Number.isFinite(hz) || hz < 0) return null;
    return fan === 0 && hz > 30;
}
