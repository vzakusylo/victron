//! lib/heat-pump/dhw-tick.js: the DHW controller state machine (dhwTick).
//! Included into "40 Heat pump automations.js" by `// #include` (tools/includes.js); it runs in that
//! function node's scope, not as a module. Lines starting with //! are not embedded in flows.json.
function dhwTick() {
    const d = dhwState(), c = dhwCfgNow();
    const md = modeOf(DHW_ID);
    const liveNow = md === 'live' && settings.master;
    const H = (st.hp && st.hp.dps) || {}, V = (st.valve && st.valve.dps) || {}, B = (st.bypass && st.bypass.dps) || {};
    const sup = dhwMeasurement(H['102']), ret = dhwMeasurement(H['101']), tank = dhwMeasurement(H['108']), out = dhwMeasurement(H['103']), hz = dhwMeasurement(H['115']), fan = dhwMeasurement(H['116']);
    const amp = dhwMeasurement(H['112']), dis = dhwMeasurement(H['104']);
    const P23 = dhwMeasurement(H['133']), P24 = dhwMeasurement(H['134']), P22on = heatCurveEnabled(H['132']);
    const valveOn = V['1'] === true, bypassOn = B['1'] === true;
    const defNow = fan === 0 && hz > 30;
    const devOk = ready('hp') && ready('valve') && ready('bypass');
    const heat = settings.heatCurve || null;
    const go = (state, text, kind) => { d.state = state; d.since = now; if (text) logEvent({ kind: kind || 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text }); };
    let shadowWriter = 'dhw';
    const write = (s, force) => {
        if (!d.live && !force) { logEvent({ kind: 'dry', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: false, text: 'would ' + s.text }); return; }
        if (!liveNow) return;
        const q = context.get('queue') || [];
        q.push(shadowTag({ rule: DHW_ID, cloud: DHW_NAME, run: d.run, ...s, force: !!force }, shadowWriter, now));
        context.set('queue', q);
        logEvent({ kind: 'write', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: true, text: s.text });
        pump();
    };
    const modeTo = (m, routineSilent = false) => {
        if (m !== 'mute') d.silentRetry = null;
        if (H['2'] === m) { d.modeCmd = null; return; }
        if (d.modeCmd === m && now - (d.modeAt || 0) < MIN) return;   // sent, wait for the device
        d.modeCmd = m; d.modeAt = now;
        write(routineSilent ? { ...mode(m), silentPhase: d.since } : mode(m));
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
    // H2 / H7: also not while the supply still recovers after the defrost; the average is held meanwhile
    d.outHeld = !!(defNow || recentDefrost || defRecovering);
    if (ready('hp') && Number.isFinite(out) && !d.outHeld && d.outS.at(-1)?.[0] !== now) d.outS.push([now, out]);
    d.outS = d.outS.filter((x) => now - x[0] <= 10 * MIN);
    if (!d.outHeld) {
        if (d.outS.length) d.outAvg = Math.round(d.outS.reduce((a, x) => a + x[1], 0) / d.outS.length * 10) / 10;
        else if (d.state === 'HEATING') d.outAvg = null;
    }
    // heating lag: 30-min average of supply − heating curve while heating runs on the heating values
    const xc = Number.isFinite(d.outAvg) ? d.outAvg : null;
    const ownerMeasured = heat && P23 === heat.p23 && P24 === heat.p24;
    if (d.state === 'HEATING' && ready('hp') && Number.isFinite(sup) && !valveOn && !bypassOn && !d.outHeld && hz > 0 && xc !== null
        && validHeatCurve(P23, P24) && (ownerMeasured || (P24 !== c.boilerP24 && P23 > 0))) {
        d.lagS.push([now, sup - heatCurveAt(P23, P24, xc)]);
    }
    d.lagS = d.lagS.filter((x) => now - x[0] <= 30 * MIN);
    const showerMeasurementsOk = [sup, ret, hz, fan, out, amp, dis, P23, P24, dhwMeasurement(H['15'])].every(Number.isFinite)
        && ['0', '1'].includes(String(H['132'])) && typeof V['1'] === 'boolean' && typeof B['1'] === 'boolean';
    const showerDemand = observeShower(d, c, tank, valveOn, bypassOn, defNow, devOk && showerMeasurementsOk);
    if (d.showerStart && (!devOk || !showerMeasurementsOk || !Number.isFinite(tank))) {
        cancelShowerWrites(d.run);
        if (!d.showerSafetyStopRequested) {
            logEvent({ kind: 'warn', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live,
                text: 'forced cycle safety stop pending: device unavailable or invalid cycle measurements; queued writes cancelled' });
        }
        d.showerSafetyStopRequested = true;
    }

    // controller switched off / local control OFF during a cycle → back to heating
    if (d.state !== 'HEATING' && (md === 'off' || (d.live && !liveNow))) {
        if (d.live && settings.master) { write(valve(false), true); write(bypass(false), true); heatBack(true); }
        go('HEATING', 'cycle stopped (' + (md === 'off' ? 'controller Off' : 'local control OFF or controller no longer On') + ')'
            + (d.live && settings.master ? ': valve OFF, bypass OFF, heating curve back (' + heatTxt + ')' : ''), 'stop');
        d.run = null; d.showerStart = null; d.showerStopRequested = false; d.showerSafetyStopRequested = false; d.lastEnd = now; settings.dhwLastEnd = now; saveSettingsFile();
        context.set('dhw', d); return;
    }
    if (md === 'off') { d.why = 'controller Off'; context.set('dhw', d); return; }
    if (!devOk) { d.waitNote = 'device not connected / stale'; context.set('dhw', d); return; }
    d.waitNote = '';
    const xcTxt = 'sensor ' + xc + ' °C (10-min average)';
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
    const endCycle = (why, abort, forceRestore, eventKind) => {
        if (abort || forceRestore) shadowWriter = 'protection';
        if (abort && d.run) cancelModeWrite(active => active.run === d.run);
        if (valveOn || forceRestore) write(valve(false));
        if ((bypassOn || forceRestore) && !(forceRestore && (defNow || defRecovering || !Number.isFinite(fan) || !Number.isFinite(hz) || typeof B['1'] !== 'boolean'))) write(bypass(false));
        if (forceRestore) write(mode('mute')); else modeTo('mute');
        heatBack();
        // d#174 (owner): an aborted cycle (Er03, the 3-way valve switched back from outside or did not switch) blocks
        // new DHW starts until "Allow DHW again" on the Heat Pump page; no automatic retries (the d#144 retry is gone)
        let retryTxt = '';
        settings.dhwRetry = null;
        if (abort && d.live) {   // d#177: a Test cycle never switches the valve, so it never blocks
            settings.dhwBlock = { at: now, why };
            retryTxt = '; DHW blocked until allowed again on the Heat Pump page';
        }
        d.lastEnd = now; settings.dhwLastEnd = now;
        if (/^tank at target/.test(why)) { d.lastDone = now; settings.dhwLastDone = now; }
        saveSettingsFile();
        go('HEATING', 'end of DHW (' + why + '): tank ' + d.startTank + ' → ' + tank + ' °C after ' + Math.round(cycleMin) + ' min (' + Math.round(dhwMin) + ' min heating) → valve to heating, heating curve back (' + heatTxt + ')' + retryTxt, eventKind || (abort ? 'stop' : 'done'));
        d.run = null; d.goal = null; d.want = null; d.showerStart = null; d.showerStopRequested = false; d.showerSafetyStopRequested = false;
    };
    if (d.showerStart && ((d.showerStart.type !== 'manual' && !c.showerForce) || d.showerStopRequested)) {
        if (d.live) {
            d.run = now + ':dhw-shower-stop';
            endCycle('forced shower cycle stopped by operator' + (defNow || defRecovering ? '; bypass retained for defrost recovery' : ''), false, true);
        } else {
            go('HEATING', 'simulated shower cycle stopped', 'stop');
            d.run = null; d.showerStart = null; d.showerStopRequested = false; d.showerSafetyStopRequested = false;
        }
        context.set('dhw', d); return;
    }
    if (d.showerStart && d.showerSafetyStopRequested) {
        cancelShowerWrites(d.run);
        if (d.live) {
            d.run = now + ':dhw-shower-safety-stop';
            endCycle('forced cycle lost valid cycle measurements or device availability', false, true, 'warn');
        } else {
            go('HEATING', 'simulated shower cycle lost valid cycle measurements', 'warn');
            d.run = null; d.showerStart = null; d.showerStopRequested = false; d.showerSafetyStopRequested = false;
        }
        context.set('dhw', d); return;
    }

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
        const ownerPending = context.get('ownerCurveRequest');
        // After a partial group, only another confirmed apply may update the baseline.
        if (!ownerPending && ready('hp') && Number.isFinite(P23) && Number.isFinite(P24) && now - lastEnd > 2 * MIN && now - (d.curveFixAt || 0) > 2 * MIN) {
            const foreign = !P22on || (P23 === 0 && heat?.p23 !== 0) || (P24 === c.boilerP24 && heat?.p24 !== c.boilerP24);
            if (foreign && heat && liveNow) {
                d.run = null; d.live = true;
                logEvent({ kind: 'warn', rule: DHW_ID, cloud: DHW_NAME, live: true, text: 'pump curve P22 ' + (P22on ? 'on' : 'off') + ', P23 ' + P23 + ', P24 ' + P24 + ' outside a DHW cycle → heating curve back (' + heatTxt + ')' });
                heatBack(); d.curveFixAt = now;
            } else if (!d.curveCaptureHeld && !valveOn && !foreign && validHeatCurve(P23, P24)
                && (!heat || heat.p23 !== P23 || heat.p24 !== P24) && !boostedCurve(heat, P23, P24)) {
                settings.heatCurve = { p23: P23, p24: P24, at: now };
                logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: 'heating curve stored: P23 ' + P23 + ' / P24 ' + P24 + (heat ? ' (was P23 ' + heat.p23 + ' / P24 ' + heat.p24 + ')' : '') });
                saveSettingsFile();
            }
        }
        const ivH = cold ? c.coldIntervalH : c.minIntervalH;
        const manual = manualDemand();
        const demand = manual || showerDemand;
        const forced = !!(demand && demand.until > now && (demand.type === 'manual' || c.showerForce));
        // d#201: a defrost ended (armed ≤ 60 min ago), option on, tank below target, no gap wait → start at once
        const adAt = Number(context.get('afterDefrostAt')) || 0;
        const doneAt = Math.max(d.lastDone || 0, Number(settings.dhwLastDone) || 0);
        const gapWait = !manual && !!doneAt && now - doneAt < c.minGapH * 3600 * 1000;
        const adStart = !!(c.startAfterDefrost && adAt && now - adAt <= 60 * MIN && Number.isFinite(tank) && target !== null && target - tank >= SHOWER_MIN_DEFICIT_C && !gapWait);
        if (adAt && (now - adAt > 60 * MIN || !c.startAfterDefrost)) context.set('afterDefrostAt', 0);
        const why = [];
        if (!Number.isFinite(tank)) why.push('no valid tank temperature');
        if (target === null) why.push(d.outAvg === null ? 'no outdoor value yet' : 'outdoor ' + d.outAvg + ' °C below the frost limit ' + c.frostLimit + ' °C (electric heater only)');
        else if (Number.isFinite(tank)) {
            if (forced && target - tank < SHOWER_MIN_DEFICIT_C) why.push('tank deficit ' + (target - tank).toFixed(1) + ' °C < shower minimum ' + SHOWER_MIN_DEFICIT_C + ' °C (target ' + target + ')');
            else if (!forced && !adStart && !(tank < target - c.hyst)) why.push('tank ' + tank + ' °C ≥ ' + (target - c.hyst) + ' °C (target ' + target + ' − ' + c.hyst + ')');
        }
        if (gapWait) {
            const txt = 'waits: last cycle ended ' + new Date(doneAt).toTimeString().slice(0, 5) + ', gap ' + c.minGapH + ' h';
            why.push(txt);
            if (d.gapLogged !== doneAt && Number.isFinite(tank) && target !== null && tank < target) {
                d.gapLogged = doneAt;
                logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: 'DHW ' + txt });
            }
        }
        const rt = settings.dhwRetry;
        const retryDue = !!(rt && now >= rt.at);
        // d#173: a planned cycle that is not needed any more (tank still ≥ target − hyst) is dropped
        if (retryDue && !rt.n && target !== null && tank >= target - c.hyst) { settings.dhwRetry = null; saveSettingsFile(); }
        if (lastEnd && now - lastEnd < ivH * 3600 * 1000 && !retryDue && !forced && !adStart) why.push('last cycle ' + Math.round((now - lastEnd) / MIN) + ' min ago (min ' + ivH + ' h' + (cold ? ', cold' : '')
            + (rt ? (rt.n ? '; retry ' + rt.n + '/' + RETRY_MAX : '; planned ' + (rt.why || '')) + ' at ' + new Date(rt.at).toTimeString().slice(0, 5) : '') + ')');
        if (defNow || recentDefrost) why.push('defrost now or < ' + DEFROST_QUIET_MIN + ' min ago');
        else if (restartSettling) why.push('settling after restart');
        else {
            // d#169: after a defrost the heating loop first gets back to its set point
            // (d#170: back at the set point − supplyReady, or at the supply from before the defrost − 0.5 if lower)
            if (defRecovering) why.push('after the defrost supply ' + sup + ' °C not back yet (heating set ' + H['125'] + ' − ' + c.supplyReady
                + (Number.isFinite(Number(context.get('preDefSupply'))) ? ', before the defrost ' + context.get('preDefSupply') : '') + ') — heating first');
        }
        // d#176: in the defrost season a cycle starts only in the window right after a defrost (supply recovered)
        // (d#177: the season comes from the recorded defrost starts, not lastDefrost, which a node start sets too)
        const lastDefA = context.get('lastDefrost') || 0, recAt = context.get('recoveredAt') || 0;
        const season = (settings.defrostStarts || []).some((x) => now - x < 3 * 3600 * 1000);
        if (!manual && !adStart && c.afterDefrost && season && !defNow && !recentDefrost && !defRecovering
            && !(recAt > lastDefA && now - recAt <= c.afterDefrostWinMin * MIN))
            why.push('defrost season: start only within ' + c.afterDefrostWinMin + ' min after a defrost' + (recAt > lastDefA ? ' (window closed ' + new Date(recAt + c.afterDefrostWinMin * MIN).toTimeString().slice(0, 5) + ')' : ''));
        const fc = defrostForecast();
        if (fc && fc.next && c.defrostLead > 0 && fc.next - now < c.defrostLead * MIN)
            why.push('defrost expected ≈ ' + new Date(fc.next).toTimeString().slice(0, 5) + ' (every ~' + fc.intervalMin + ' min) — DHW after it');
        if ((context.get('flag') || flag).on) why.push('defrost flag ON');
        if (valveOn) why.push('valve ON');
        if (settings.dhwBlock) why.push('blocked: the last cycle was aborted at ' + new Date(settings.dhwBlock.at).toTimeString().slice(0, 5) + ' (' + settings.dhwBlock.why + ') — allow DHW again on the Heat Pump page');
        if (H['1'] !== true) why.push('heat pump off');
        if (forced && !showerMeasurementsOk) why.push('shower start needs valid cycle measurements');
        if (forced && dhwMeasurement(H['15']) !== 0) why.push('shower start blocked by heat pump fault');
        if (!heat) why.push('heating curve not stored yet');
        const lag = dhwLag(d);
        if (!manual && d.outAvg !== null && d.outAvg <= c.coldLimit && lag !== null && lag < -c.lagC) why.push('heating lags ' + lag + ' °C below its curve at ' + d.outAvg + ' °C (heating first)');
        d.why = why.length ? why.join('; ') : 'start conditions met';
        d.streak = why.length ? 0 : (forced && ['drop', 'manual'].includes(demand.type)) || adStart ? HOLD : d.streak + 1;
        if (d.streak >= HOLD) {
            d.streak = 0; d.run = now + ':' + DHW_ID; d.live = liveNow; d.startAt = now; d.startTank = tank; d.prog = null;
            if (adStart) { context.set('afterDefrostAt', 0); logEvent({ kind: 'setting', rule: DHW_ID, cloud: DHW_NAME, text: 'start DHW after defrost (starts ≥ ' + DEFROST_QUIET_MIN + ' min after it, once the supply is back): tank ' + tank + ' °C ≤ target ' + target + ' − ' + SHOWER_MIN_DEFICIT_C + ' °C' }); }
            d.showerStart = forced ? Object.assign({}, demand) : null;
            d.showerStopRequested = false;
            d.showerSafetyStopRequested = false;
            if (forced && demand.type === 'manual') { settings.dhwManual = null; saveSettingsFile(); }
            else if (forced && d.live) { settings.showerLastStart = { id: showerDemand.id, at: now }; showerState().demand = null; saveSettingsFile(); }
            d.prot = { steps: 0, hotSince: 0, at: 0, cut: 0, reason: '' }; d.p23Cmd = null; d.p24Cmd = null; d.p24Goal = null; d.tankS = []; d.dhwMs = 0;
            logEvent({ kind: d.live ? 'start' : 'test', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live,
                text: (d.live ? 'start' : 'test, would start') + (forced ? (demand.type === 'manual' ? ' [' + demand.reason + '; interval, defrost window and heating priority overridden]' : ' [shower: ' + demand.reason + '; interval overridden]') : '')
                    + ': tank ' + tank + (forced ? ' °C ≤ target ' + target + ' − ' + SHOWER_MIN_DEFICIT_C : ' °C < target ' + target + ' − ' + c.hyst) + ' at outdoor ' + d.outAvg + ' °C'
                    + ' → wanted supply ' + W + ' °C' + (cold ? ' (cold: Silent only, max ' + c.coldCap + ' °C)' : '') + (retryDue ? (rt.n ? ' [retry ' + rt.n + '/' + RETRY_MAX + ']' : ' [planned ' + (rt.why || '') + ']') : '') + '; curve P23 0 (compressor stops), then valve to the tank' });
            const kickRestoredSilent = holdKickForDhw();
            if (!P22on) write(p22(true));
            if (!kickRestoredSilent) modeTo('mute');
            if (bypassOn) write(bypass(false));
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
            if (xc === null) { endCycle('no outdoor average for boiler curve', false, false, 'stop'); break; }
            // d#172: a goal above P23 40 makes the boiler curve steeper (P24) instead of capping it
            const cc0 = curveCoeffs(W, xc, c.boilerP24); d.p24Goal = cc0.p24;
            d.goal = Math.max(0, cc0.p23 - (d.prot ? d.prot.cut : 0));
            // d#143: after the valve switch the loop fills with tank water (seen 10 Nov 14:17: 40–42 °C), so the
            // gap is counted from the warmest of return / supply / tank; a lower start left the curve below
            // the water and the compressor off for 9 min
            const water = Math.max(Number.isFinite(ret) ? ret : 0, Number.isFinite(sup) ? sup : 0, Number.isFinite(tank) ? tank : 0);
            // d#191: the compressor is off here; it starts only with a target well above the water (37 starts
            // 10–18 Nov: median +9.8 °C above return, rarely below +5), so the start uses startGap, not gap
            const startGap = Math.max(c.gap, c.startGap);
            const startP23 = c.gapRamp ? Math.min(d.goal, p23For(Math.round(water) + startGap, xc, d.p24Goal)) : d.goal;
            curveTo(startP23, d.p24Goal);
            d.prog = { t: now, sup }; d.defTicks = 0;
            go('DHW', 'valve settled, boiler curve P24 ' + d.p24Goal + ' / P23 ' + startP23 + ' (≈ ' + heatCurveAt(startP23, d.p24Goal, xc).toFixed(1)
                + ' °C at ' + xcTxt + '; goal P23 ' + d.goal + ' ≈ ' + W + ' °C' + (c.gapRamp ? ', start ≤ water ' + Math.round(water) + ' + ' + startGap + ', then +1 per minute' : '') + ')');
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
        if (xc === null) { endCycle('no outdoor average for boiler curve', false, false, 'stop'); break; }
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
                shadowWriter = 'protection';
                endCycle('compressor protection: ' + pr.reason + ' for ' + Math.round(held / MIN) + ' min after ' + pr.steps + ' steps down — the electric heater takes over');
                break;
            }
            if (held >= 3 * MIN && now - pr.at >= 3 * MIN) {
                shadowWriter = 'protection';
                pr.steps++; pr.cut += 2; pr.at = now;
                modeTo('mute');
                logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'compressor protection: ' + pr.reason + ' for 3 min → curve P23 − 2 (step ' + pr.steps + '), Silent' });
                d.rampAt = 0;   // apply the cut at once
            }
        } else pr.hotSince = 0;
        // boiler P23: goal from the wanted supply, ramp +1 per minute while supply − return ≤ gap
        const cc1 = curveCoeffs(W, xc, c.boilerP24);
        const p24g = Math.max(cc1.p24, d.p24Goal || c.boilerP24);   // the slope only goes up within a cycle
        d.p24Goal = p24g;
        d.goal = Math.max(0, Math.min(40, p23For(W, xc, p24g)) - pr.cut);
        const water = Math.max(Number.isFinite(ret) ? ret : 0, Number.isFinite(tank) ? tank : 0);
        // d#191: until the compressor runs, the ramp may ask startGap above the water (the pump's own start
        // hysteresis); once it runs, the ordinary gap keeps the supply rise gentle
        const gapNow = hz > 0 ? c.gap : Math.max(c.gap, c.startGap);
        const allowed = c.gapRamp ? p23For(Math.round(water) + gapNow, xc, p24g) : 40;
        d.want = Math.min(d.goal, allowed);
        if (d.p23Cmd === null || d.p24Cmd !== p24g) curveTo(d.p23Cmd === null ? d.want : Math.min(d.p23Cmd, d.want), p24g);
        else if (d.want > d.p23Cmd && now - d.rampAt >= MIN) curveTo(d.p23Cmd + 1, p24g);
        else if (d.want <= d.p23Cmd - (d.rampAt === 0 ? 1 : 2) && now - d.rampAt >= 30 * S) curveTo(d.want, p24g);
        // power: Silent by default; Smart only when the supply does not rise (not in the cold, not
        // after a protection step); back to Silent near the wanted supply
        if (cold || pr.steps) {
            shadowWriter = 'protection';
            if (H['2'] !== 'mute') modeTo('mute');
        }
        else if (d.prog && now - d.prog.t >= 10 * MIN) {
            const rise = sup - d.prog.sup;
            if (Number.isFinite(sup) && Number.isFinite(d.prog.sup) && sup < W - 3 && rise < 2) {
                if (H['2'] === 'mute') { modeTo('smart'); logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'supply rose only ' + rise + ' °C in 10 min → Smart' }); }
                else if (H['2'] === 'smart' && c.allowPowerful) { modeTo('strong'); logEvent({ kind: 'step', rule: DHW_ID, cloud: DHW_NAME, run: d.run, live: d.live, text: 'supply rose only ' + rise + ' °C in 10 min → Powerful' }); }
            }
            d.prog = { t: now, sup };
        }
        const silentPaused = dhwSilentPaused(d, now);
        if (!cold && !pr.steps && H['2'] !== 'mute' && sup >= W - 1 && !silentPaused) modeTo('mute', true);
        d.why = 'DHW: tank ' + tank + ' → ' + target + ' °C (' + (dhwProgress(d.startTank, tank, target) === null ? '?' : dhwProgress(d.startTank, tank, target)) + ' %), supply ' + sup + ' / return ' + ret + ', curve P23 ' + d.p23Cmd + ' (≈ '
            + heatCurveAt(d.p23Cmd, d.p24Cmd || c.boilerP24, xc).toFixed(1) + ' °C at ' + xcTxt + '), goal P23 ' + d.goal + ' (≈ ' + W + ' °C), heating ' + Math.round(dhwMin) + ' / ' + Math.round(maxDur) + ' min (cycle ' + Math.round(cycleMin) + ')'
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
