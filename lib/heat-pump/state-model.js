//! Node 34: Heat pump dashboard model.
function buildModel(st, now) {
    const hp = st.hp;
    const d = hp.dps;
    const items = [];
    Object.keys(HP_DPS).forEach((dp) => {
        if (d[dp] === undefined) return;
        const [code, label, unit] = HP_DPS[dp];
        let value = d[dp];
        if (code === 'fault') value = decodeFaults(value).join(', ') || 'none';
        else if (code === 'mode') value = MODE_LABELS[value] || value;
        else if (code === 'work_mode') value = WORK_MODE_LABELS[value] || value;
        else if (typeof value === 'boolean') value = value ? 'ON' : 'OFF';
        items.push({ dp, code, label, unit, value });
    });
    const unknown = Object.keys(d).filter((dp) => !HP_DPS[dp]).map((dp) => ({ dp, value: d[dp] }));

    const fan = num(d['116']);
    const freq = num(d['115']);
    const defrostSign = fan === 0 && freq !== null && freq > 30;

    // Compressor load: frequency and current vs rated maxima, and an estimated electrical power
    const current = num(d['112']);
    const dcBus = num(d['114']);
    const pct = (value, max) => (value === null ? null : Math.max(0, Math.min(100, Math.round(value / max * 100))));
    const freqPct = pct(freq, COMPRESSOR_MAX_HZ);
    const currentPct = pct(current, COMPRESSOR_MAX_A);
    // load = estimated input power / nameplate max input power (= current / 9.67 A)
    const powerW = current === null ? null : Math.round(Math.max(0, current) * W_PER_A);
    const loadPct = powerW === null ? null : Math.max(0, Math.min(100, Math.round(powerW / UNIT_MAX_W * 100)));

    const devices = ROLES.map((role) => {
        const dev = st[role];
        const age = dev.lastData ? Math.round((now - dev.lastData) / 1000) : null;
        return {
            role,
            label: ROLE_LABELS[role],
            state: dev.state,
            ageSeconds: age,
            stale: !dev.lastData || now - dev.lastData > (CLOUD_ROLES.includes(role) ? CLOUD_STALE_MS : STALE_MS),
            source: dev.source || null,
            switchOn: role === 'hp' ? (typeof d['1'] === 'boolean' ? d['1'] : null) : (role === 'meter' || CLOUD_ROLES.includes(role) ? null : switchValue(dev))
        };
    });

    const meterFresh = st.meter.lastData && now - st.meter.lastData <= STALE_MS;
    const meter = meterFresh ? st.meter.reading : null;
    const connected = (role) => st[role].state === 'CONNECTED' && st[role].lastData && now - st[role].lastData <= STALE_MS;
    const cloudTemp = (role) => {
        const c = st[role];
        return c && c.state === 'CONNECTED' && c.lastTempAt && now - c.lastTempAt <= CLOUD_STALE_MS ? num(c.dps.temp) : null;
    };

    return {
        updated: new Date(now).toISOString(),
        readOnly: false,
        controls: {
            curve: connected('hp') && num(d['133']) !== null && !dhwCycle(),
            curveMin: 20,
            curveMax: 40,
            bypass: connected('bypass') && switchValue(st.bypass) !== null
        },
        devices,
        summary: {
            supply: num(d['102']),
            ret: num(d['101']),
            tank: num(d['108']),
            outdoor: outdoorShown(d).value,
            outdoorHeld: outdoorShown(d).held,
            outdoorRaw: num(d['103']),
            accTemp: cloudTemp('acc'),
            plateTemp: cloudTemp('plate'),
            compressorHz: freq,
            fanRpm: fan,
            compressorA: current,
            compressorLoadPct: loadPct,
            compressorFreqPct: freqPct,
            compressorCurrentPct: currentPct,
            compressorMaxHz: COMPRESSOR_MAX_HZ,
            compressorMaxA: COMPRESSOR_MAX_A,
            compressorPowerW: powerW,
            compressorPowerBasis: W_PER_A + ' W/A (nameplate 9.67 A = 2.13 kW)',
            unitMaxW: UNIT_MAX_W,
            resource: flow.get('compressorResource') || null,
            powerW: meter ? meter.powerW : null,
            powerV: meter ? meter.voltageV : null,
            powerA: meter ? meter.currentA : null,
            powerEnergyKwh: meter ? meter.energyKwh : null,
            powerSource: st.meter.reading ? st.meter.reading.source : null,
            meterDps: Object.keys(st.meter.dps).map((dp) => ({ dp, value: st.meter.dps[dp] })),
            heatingSetpoint: num(d['125']),
            dhwSetpoint: num(d['123']),
            mode: MODE_LABELS[d['2']] || d['2'] || null,
            workMode: WORK_MODE_LABELS[d['5']] || d['5'] || null,
            curve: d['132'] === undefined ? null : { enabled: String(d['132']) === '1', p23: num(d['133']), p24: num(d['134']) },
            faults: decodeFaults(d['15']),
            valveToDhw: switchValue(st.valve),
            bypassOn: switchValue(st.bypass),
            defrostSign
        },
        curveChart: buildCurveChart(d),
        dhwChart: buildDhwChart(d),
        heatCtl: buildHeatCtl(),
        status: buildStatus(),
        items,
        unknown
    };
}
