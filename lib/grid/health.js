function gridHeartbeat(previous, pulse, now) {
    const silent = now - pulse >= 10000;
    const notify = silent && !previous.notified && now - (previous.lastAlert ?? -Infinity) >= 900000;
    return {
        silent, notify,
        notified: silent && (notify || previous.notified === true),
        lastAlert: notify ? now : previous.lastAlert
    };
}

function gridP95(samples) {
    if (!samples.length) return null;
    return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
}
