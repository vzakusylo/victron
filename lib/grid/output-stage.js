//! Paced writes, read-back alarms and status publication for controller 01.
function gridOutputStage(decision, hourKey, waiting, now, nowTs) {
    // Use the same monotonic clock as Node-RED's dropping rate gates, not wall time.
    const processAgeMs = Math.floor(gridClock.uptime() * 1000);
    const feedbackNow = Number(gridClock.hrtime.bigint() / 1000000n);
    const storedFeedback = context.get('gridWriteFeedback') || [];
    const desired = [decision?.finalChargeCurrent, decision?.finalGridSetpoint, decision?.gridCurrentLimitA];
    const commands = [];
    const faults = [];
    const feedback = feedbackChannels.map((channel, i) => {
        const previous = storedFeedback[i];
        const result = advanceGridFeedback(previous, {
            now: feedbackNow, value: desired[i], reading: previous?.reading,
            gap: channel.gap, tolerance: channel.tolerance,
            refresh: i < 2 || previous?.hour !== hourKey, reassert: previous?.hour !== hourKey
        });
        const state = result.state;
        delete state.reading;
        commands[i] = result.write === undefined ? null : { topic: channel.topic, payload: result.write };
        if (commands[i]) state.hour = hourKey;
        if (state.fault) faults.push(`${channel.name}: ${state.fault}`);
        if (result.read) {
            const finish = reading => {
                const current = context.get('gridWriteFeedback')?.[i];
                if (current?.phase === 'reading' && current.sent === state.sent) current.reading = reading;
            };
            readGridOutput(channel).then(finish, error => finish({ error: error.message || String(error) }));
        }
        return state;
    });
    context.set('gridWriteFeedback', feedback);
    const alarmText = faults.length ? `grid not following setpoint: ${faults.join('; ')}` : '';
    context.set('gridFeedbackAlarm', { text: alarmText });
    if (alarmText) node.status({ fill: 'red', shape: 'dot', text: alarmText });
    const notice = gridFeedbackNotice(context.get('gridFeedbackNotice'), faults, feedbackNow, feedbackNow - processAgeMs);
    context.set('gridFeedbackNotice', notice.state);
    const alarm = notice.text ? { notification: { title: 'Grid control', type: 'alarm', message: notice.text }, payload: notice.text } : null;
    const event = notice.text ? { t: nowTs, kind: 'fail', rule: 'grid_feedback', live: true, text: notice.text } : null;
    const day = getHourKey(now).slice(0, 10);
    if (msg.topic === CADENCE_TOPIC) flow.set('gridDecisionPulse', Number(gridClock.hrtime.bigint() / 1000000n));
    const oldDashboard = context.get('gridDashboard') || {};
    const dashboardOutputs = feedbackChannels.map(({ tolerance }, i) => gridDashboardOutput(
        oldDashboard.outputs?.[i], storedFeedback[i], feedback[i], commands[i], nowTs, tolerance));
    const alertCounts = gridDailyFeedbackAlerts({
        day: oldDashboard.feedbackAlertsDay, count: oldDashboard.feedbackAlerts,
        total: oldDashboard.feedbackAlertsTotal
    }, now, event ? 1 : 0);
    const feedbackAlerts = alertCounts.count;
    const dashboard = gridDashboardStatus(oldDashboard.publisher,
        gridDashboardSnapshot(decision, waiting, context.get('gridInputArrivals'), dashboardOutputs,
            feedbackAlerts, flow.get('gridLoopHealth')), feedbackNow, nowTs);
    context.set('gridDashboard', {
        publisher: dashboard.state, outputs: dashboardOutputs, feedbackAlerts,
        feedbackAlertsDay: alertCounts.day, feedbackAlertsTotal: alertCounts.total
    });
    const logMessage = event ? { topic: 'log', filename: `/data/home/nodered/grid-control-logs/automations/${day}.jsonl`,
        payload: JSON.stringify(event) + '\n', event } : null;
    return { commands, alarm, logMessage, dashboard: dashboard.message };
}
