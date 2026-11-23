//! Legacy context handoff from controller 01 to the bookkeeping node.
function gridBookkeepingSeed() {
    // Retry until bookkeeping acknowledges the handoff.
    if (flow.get("gridBookkeepingSeeded") !== true) {
        return Object.fromEntries(["hourBudget", "acLoadBudget", "solarBudget", "hourPeak", "tariffDay", "tariffMonth", "tariffHistoryState", "lastTraceTs"]
            .map(key => [key, context.get(key)]).filter(([, value]) => value !== undefined));
    }
}
