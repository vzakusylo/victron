//! Pure decision used by the controller; inputs, prior state and settings are explicit.
function decideGrid({ now, C, highVoltageSettings, batteryVoltage, consumedAhDeficit,
    hasGridPowerReading, storedGridPowerW, gridPowerSignedW, storedAcLoadPowerW,
    storedPvChargerPowerW, solarGenerationW, manualDischargeStopVoltage, previousGridSetpoint,
    storedExportGuard, solarForecastToday, solarForecastAdjusted }, state) {
    const nowTs = now.getTime();
    const hour = now.getHours();
    let { manualDischarge, voltageLimitActive, forceChargeLimiterActive } = state;
    // Voltage used to convert between W / Wh and A / Ah.
    const referenceVoltage = Math.max(1, batteryVoltage > 0 ? batteryVoltage : C.BATTERY_NOMINAL_VOLTAGE);

    // ==========================
    // SEASON PLAN
    // ==========================
    const nightWindow = isNightHour(hour);
    const morningWindow = isHourWithinWindow(hour, NIGHT_END_HOUR, MORNING_END_HOUR);
    const eveningWindow = hour >= EVENING_START_HOUR;

    const tariffSeason = getTariffSeason(now, C);
    const summerProfile = buildSeasonProfile(false, C);
    const winterProfile = buildSeasonProfile(true, C);
    const seasonProfile = tariffSeason.winter ? winterProfile : summerProfile;
    const baseScheduleSetpoint = nightWindow ? seasonProfile.nightSetpointW : seasonProfile.daySetpointW;
    const gridCurrentLimitA = nightWindow ? seasonProfile.nightCurrentA : seasonProfile.dayCurrentA;
    // Sent on change and re-asserted every hour so a Multi restart or manual edit is corrected.

    // ==========================
    // PROTECTION SETTINGS
    // ==========================
    const highVoltageProtectionEnabled = highVoltageSettings.enabled;
    const highVoltageGridSupportW = highVoltageSettings.gridSupportW;
    const gridSupportMode = highVoltageSettings.gridSupportMode;
    const adaptiveGridSupportEnabled = gridSupportMode !== GRID_SUPPORT_MODE_HV_ONLY;
    const hybridGridSupportEnabled = gridSupportMode === GRID_SUPPORT_MODE_HYBRID;
    const gridSupportStartHour = highVoltageSettings.gridSupportStartHour;
    const gridSupportEndHour = highVoltageSettings.gridSupportEndHour;
    const supportMinGridImportW = clamp(highVoltageSettings.gridSupportMinGridImportW, C.MIN_GRID_SETPOINT, HV_CLAMPED_FIELDS.gridSupportMinGridImportW[1]);
    const gridSupportDisableNoSun = highVoltageSettings.gridSupportDisableNoSun;
    const gridSupportDisableNoSunBelowW = highVoltageSettings.gridSupportDisableNoSunBelowW;
    const gridSupportLowSunBlocked = gridSupportDisableNoSun
        && highVoltageGridSupportW > 0
        && solarGenerationW < gridSupportDisableNoSunBelowW;
    const exportGuardEnabled = highVoltageSettings.exportGuardEnabled;
    const forceChargeEnabled = highVoltageSettings.forceChargeEnabled;
    const forceChargeGridW = highVoltageSettings.forceChargeGridW;
    const forceChargeLimiterEnabled = highVoltageSettings.forceChargeLimiterEnabled;
    const forceChargeLimiterStart = highVoltageSettings.forceChargeLimiterStart;
    const forceChargeLimiterFull = highVoltageSettings.forceChargeLimiterFull;

    // ==========================
    // FORCE CHARGE
    // ==========================
    // The limiter has its own hysteresis: on at or below `start` V, off at or above `release` V.
    if (forceChargeLimiterEnabled && forceChargeEnabled && forceChargeGridW > 0) {
        if (!forceChargeLimiterActive && batteryVoltage <= forceChargeLimiterStart) {
            forceChargeLimiterActive = true;
        }
        if (forceChargeLimiterActive && batteryVoltage >= highVoltageSettings.forceChargeLimiterRelease) {
            forceChargeLimiterActive = false;
        }
    }
    else {
        forceChargeLimiterActive = false;
    }

    const forceChargeAllowed = forceChargeEnabled && forceChargeGridW > 0
        && (!forceChargeLimiterEnabled || forceChargeLimiterActive);

    // With the limiter: `forceChargeGridW` at the start voltage, rising to the full charge power at `full` V.
    let effectiveForceChargeGridW = forceChargeGridW;
    if (forceChargeAllowed && forceChargeLimiterEnabled) {
        const fcTaper = clamp((forceChargeLimiterStart - batteryVoltage) / (forceChargeLimiterStart - forceChargeLimiterFull), 0, 1);
        const maxForceChargeW = Math.round(C.MAX_CHARGE_CURRENT * Math.max(1, batteryVoltage));
        effectiveForceChargeGridW = Math.round(forceChargeGridW + fcTaper * (maxForceChargeW - forceChargeGridW));
    }

    // In FORCE-CHARGE the DVCC limit follows the target power; it is not capped at MAX_CHARGE_CURRENT.
    const forceChargeTargetCurrent = Math.round(effectiveForceChargeGridW / referenceVoltage);

    // ==========================
    // CAPACITY RESTORATION
    // ==========================
    const solarForecast = getSolarForecastSummary(now, solarForecastToday, C);
    const effectiveConsumedAhDeficit = Number.isFinite(consumedAhDeficit) ? consumedAhDeficit : 0;
    const forecastRestoreAh = solarForecast.valid && solarForecast.energyKWh > 0
        ? (solarForecast.energyKWh * 1000 * C.SOLAR_TO_BATTERY_EFFICIENCY) / referenceVoltage
        : 0;
    const gridRestoreAhNeeded = Math.max(0, effectiveConsumedAhDeficit - forecastRestoreAh);
    const remainingNightHours = getWindowRemainingHours(now, NIGHT_START_HOUR, NIGHT_END_HOUR);
    const remainingMorningHours = getRemainingMorningHours(now);
    const remainingMorningCapacityAh = remainingMorningHours * C.MAX_CHARGE_CURRENT;
    const morningSolarChargeHold = solarForecast.valid && forecastRestoreAh > 0 && batteryVoltage > MORNING_SOLAR_HOLD_VOLTAGE;

    if (manualDischarge.active && batteryVoltage <= manualDischargeStopVoltage) {
        manualDischarge = { active: false, startedAt: "", source: "auto-stop-low-voltage" };
    }

    const manualDischargeAllowedByLoad = storedAcLoadPowerW <= C.MANUAL_DISCHARGE_MAX_AC_LOAD_W;
    const manualDischargeEnabled = manualDischarge.active && manualDischargeAllowedByLoad;

    let windowName = "OUTSIDE";
    let baseChargeCurrent = 0;
    let boostActive = false;

    if (manualDischargeEnabled) {
        windowName = "MANUAL-DISCHARGE";
    }
    else if (forceChargeAllowed) {
        windowName = "FORCE-CHARGE";
        baseChargeCurrent = forceChargeTargetCurrent;
    }
    else if (nightWindow) {
        windowName = "NIGHT";
        boostActive = gridRestoreAhNeeded > Math.max(C.RESTORE_AH_DEADBAND, remainingMorningCapacityAh);
    }
    else if (morningWindow) {
        windowName = "MORNING";
        boostActive = !morningSolarChargeHold && gridRestoreAhNeeded > C.RESTORE_AH_DEADBAND;
    }
    else if (eveningWindow) {
        windowName = "EVENING";
    }

    if (boostActive) {
        baseChargeCurrent = C.MAX_CHARGE_CURRENT;
    }

    // ==========================
    // HIGH-VOLTAGE GRID SETPOINT LIMIT
    // ==========================
    if (!highVoltageProtectionEnabled) {
        voltageLimitActive = false;
    }
    else if (!voltageLimitActive && batteryVoltage > highVoltageSettings.start) {
        voltageLimitActive = true;
    }

    if (voltageLimitActive && batteryVoltage <= highVoltageSettings.release) {
        voltageLimitActive = false;
    }

    const requestedGridSetpoint = forceChargeAllowed
        ? Math.min(baseScheduleSetpoint, Math.round(storedAcLoadPowerW + effectiveForceChargeGridW))
        : baseScheduleSetpoint;
    let voltageLimitedSetpoint = requestedGridSetpoint;

    if (voltageLimitActive) {
        // Taper from the requested setpoint down to what the house really takes from the grid.
        const floorSetpoint = forceChargeAllowed
            ? Math.min(requestedGridSetpoint, Math.round(storedAcLoadPowerW))
            : (hasGridPowerReading ? Math.min(requestedGridSetpoint, Math.round(storedGridPowerW)) : 0);
        const taper = clamp(
            (highVoltageSettings.full - batteryVoltage) / (highVoltageSettings.full - highVoltageSettings.start),
            0,
            1
        );

        voltageLimitedSetpoint = Math.round(stepTowards(
            previousGridSetpoint,
            Math.round(floorSetpoint + (requestedGridSetpoint - floorSetpoint) * taper),
            C.MAX_GRID_STEP_W
        ));
    }

    // ==========================
    // GRID SETPOINT CAPS
    // ==========================
    const manualDischargePowerW = Math.round(Math.max(0, batteryVoltage) * C.MANUAL_DISCHARGE_MAX_CURRENT);
    const rawFinalGridSetpoint = manualDischargeEnabled
        ? Math.max(C.MANUAL_DISCHARGE_MIN_GRID_W, Math.round(storedAcLoadPowerW - manualDischargePowerW))
        : Math.max(0, Math.round(Math.min(requestedGridSetpoint, voltageLimitedSetpoint)));

    // Grid CT support: while the HV limiter is active the battery carries `gridSupportW` of the AC load.
    const applyGridSupport = highVoltageGridSupportW > 0
        && highVoltageProtectionEnabled
        && voltageLimitActive
        && hasGridPowerReading
        && !forceChargeAllowed
        && !gridSupportLowSunBlocked
        && !manualDischargeEnabled;
    const supportCap = applyGridSupport
        ? Math.max(C.MIN_GRID_SETPOINT, Math.round(storedAcLoadPowerW - highVoltageGridSupportW))
        : Number.POSITIVE_INFINITY;

    // Adaptive day support: usable stored Ah + the forecast still to come, spread over the support window.
    const batteryRemainingAh = highVoltageSettings.gridSupportBatteryCapacityAh > 0
        ? Math.max(0, highVoltageSettings.gridSupportBatteryCapacityAh - effectiveConsumedAhDeficit)
        : null;
    const usableStoredSupportAh = batteryRemainingAh === null
        ? 0
        : Math.max(0, batteryRemainingAh - highVoltageSettings.gridSupportReserveAh);
    const supportWindowActive = adaptiveGridSupportEnabled && isHourWithinWindow(hour, gridSupportStartHour, gridSupportEndHour);
    const supportWindowRemainingHours = supportWindowActive ? getWindowRemainingHours(now, gridSupportStartHour, gridSupportEndHour) : 0;
    const remainingForecastWh = supportWindowActive ? getRemainingForecastWh(now, gridSupportStartHour, gridSupportEndHour, solarForecastAdjusted) : 0;
    const remainingForecastAh = remainingForecastWh > 0
        ? (remainingForecastWh * C.SOLAR_TO_BATTERY_EFFICIENCY) / referenceVoltage
        : 0;
    const predictedSupportAh = Math.max(
        0,
        remainingForecastAh * (highVoltageSettings.gridSupportForecastConfidencePct / 100) - highVoltageSettings.gridSupportWeakForecastBlockAh
    );
    const plannedGridSupportW = supportWindowActive && supportWindowRemainingHours > 0 && highVoltageGridSupportW > 0
        ? Math.min(
            highVoltageGridSupportW,
            Math.max(0, Math.round((usableStoredSupportAh + predictedSupportAh) * referenceVoltage / supportWindowRemainingHours))
        )
        : 0;
    const liveSolarAssistW = supportWindowActive
        ? Math.round(solarGenerationW * (highVoltageSettings.gridSupportSolarAssistGainPct / 100))
        : 0;
    const adaptiveGridSupportW = supportWindowActive
        ? Math.min(
            highVoltageGridSupportW,
            Math.round(Math.max(0, batteryVoltage) * highVoltageSettings.gridSupportMaxDischargeA),
            Math.max(0, plannedGridSupportW + liveSolarAssistW)
        )
        : 0;
    const adaptiveGridSupportActive = adaptiveGridSupportW > 0
        && adaptiveGridSupportEnabled
        && !boostActive
        && !forceChargeAllowed
        && !gridSupportLowSunBlocked
        && !manualDischargeEnabled
        && !nightWindow
        && hasGridPowerReading
        && (!highVoltageProtectionEnabled || !voltageLimitActive || hybridGridSupportEnabled);
    const adaptiveSupportCap = adaptiveGridSupportActive
        ? Math.max(supportMinGridImportW, Math.round(storedAcLoadPowerW - adaptiveGridSupportW))
        : Number.POSITIVE_INFINITY;

    const applyDayHighAcLoadReduction = !nightWindow
        && storedAcLoadPowerW > C.DAY_HIGH_AC_LOAD_THRESHOLD_W
        && !forceChargeAllowed
        && !manualDischargeEnabled;
    const dayHighAcLoadCap = applyDayHighAcLoadReduction
        ? Math.max(0, rawFinalGridSetpoint - C.DAY_HIGH_AC_LOAD_REDUCTION_W)
        : Number.POSITIVE_INFINITY;

    const cappedGridSetpoint = Math.min(rawFinalGridSetpoint, adaptiveSupportCap, supportCap, dayHighAcLoadCap);

    // ==========================
    // GRID EXPORT GUARD
    // ==========================
    // A negative GRID CT reading means the Multi is inverting surplus from the external MPPT because
    // DVCC does not let the battery absorb it. The battery becomes the compensating load: the DVCC
    // limit is raised to cover PV + boost and the setpoint is floored at the minimum grid import.
    // The boost integrates the CT error every EXPORT_GUARD_UPDATE_INTERVAL_MS until the CT sits at
    // the minimum import; the guard releases itself once the boost is back at 0.
    const exportGuardTargetW = supportMinGridImportW;
    let exportGuard = { active: false, boostW: 0, since: "", lastAdjustTs: 0 };

    if (exportGuardEnabled && hasGridPowerReading) {
        exportGuard = {
            active: Boolean(storedExportGuard.active),
            boostW: Math.max(0, Number(storedExportGuard.boostW) || 0),
            since: String(storedExportGuard.since || ""),
            lastAdjustTs: Number(storedExportGuard.lastAdjustTs) || 0
        };
        const exportGuardErrorW = exportGuardTargetW - gridPowerSignedW;

        if (!exportGuard.active && gridPowerSignedW < 0) {
            exportGuard = {
                active: true,
                boostW: clamp(Math.round(exportGuardErrorW), 0, EXPORT_GUARD_MAX_BOOST_W),
                since: now.toISOString(),
                lastAdjustTs: nowTs
            };
        }
        else if (exportGuard.active && nowTs - exportGuard.lastAdjustTs >= EXPORT_GUARD_UPDATE_INTERVAL_MS) {
            const offTarget = exportGuardErrorW > 0 || gridPowerSignedW > exportGuardTargetW + EXPORT_GUARD_RELEASE_DEADBAND_W;

            if (offTarget) {
                const stepW = clamp(exportGuardErrorW * EXPORT_GUARD_GAIN, -EXPORT_GUARD_MAX_STEP_W, EXPORT_GUARD_MAX_STEP_W);
                exportGuard.boostW = clamp(Math.round(exportGuard.boostW + stepW), 0, EXPORT_GUARD_MAX_BOOST_W);
            }

            exportGuard.lastAdjustTs = nowTs;

            if (exportGuard.boostW <= 0) {
                exportGuard = { active: false, boostW: exportGuard.boostW, since: "", lastAdjustTs: 0 };
            }
        }
    }

    const exportGuardSetpointFloorW = exportGuard.active ? exportGuardTargetW : 0;
    const exportGuardChargeCurrent = exportGuard.active
        ? round1(clamp((storedPvChargerPowerW + exportGuard.boostW) / referenceVoltage, 0, C.MAX_CHARGE_CURRENT))
        : 0;

    // ==========================
    // FINAL OUTPUTS
    // ==========================
    const finalGridSetpoint = Math.max(cappedGridSetpoint, exportGuardSetpointFloorW);

    // A lowered setpoint lowers the charge current by the same ratio.
    const currentRatio = baseScheduleSetpoint > 0
        ? clamp(finalGridSetpoint / baseScheduleSetpoint, 0, 1)
        : 0;
    const forceChargeAvailableW = Math.max(0, Math.round(finalGridSetpoint - storedAcLoadPowerW));
    const forceChargeRatio = effectiveForceChargeGridW > 0
        ? clamp(forceChargeAvailableW / effectiveForceChargeGridW, 0, 1)
        : 0;
    const scheduledChargeCurrent = manualDischargeEnabled
        ? 0
        : round1(baseChargeCurrent * (forceChargeAllowed ? forceChargeRatio : currentRatio));
    // The export guard may only raise the DVCC limit, never lower a scheduled charge.
    const finalChargeCurrent = Math.max(scheduledChargeCurrent, exportGuardChargeCurrent);
    const currentChargingPowerW = Math.max(0, Math.round(Math.max(0, batteryVoltage) * finalChargeCurrent));


    // ==========================
    // STATUS
    // ==========================
    const limitFlags = [];

    if (voltageLimitActive && finalGridSetpoint <= voltageLimitedSetpoint) {
        limitFlags.push("HV");
    }

    if (solarForecast.valid && forecastRestoreAh > 0) {
        limitFlags.push(`SOL:${solarForecast.condition.toUpperCase()}`);
    }

    if (manualDischargeEnabled) {
        limitFlags.push(`MD:${C.MANUAL_DISCHARGE_MAX_CURRENT}A`);
    }
    else if (manualDischarge.active) {
        limitFlags.push(`MD-HOLD>${C.MANUAL_DISCHARGE_MAX_AC_LOAD_W}W`);
    }

    if (applyDayHighAcLoadReduction) {
        limitFlags.push(`AC-HIGH:-${C.DAY_HIGH_AC_LOAD_REDUCTION_W}W`);
    }

    if (gridSupportLowSunBlocked) {
        limitFlags.push(`GS-SUN<${gridSupportDisableNoSunBelowW}W`);
    }

    if (exportGuard.active) {
        limitFlags.push(`EXP:+${Math.round(exportGuard.boostW)}W@${Math.round(gridPowerSignedW)}W`);
    }

    if (adaptiveGridSupportActive) {
        limitFlags.push(`GS-A:${Math.round(adaptiveGridSupportW)}W`);
    }

    if (!manualDischargeEnabled) {
        if (forceChargeAllowed) {
            limitFlags.push(`FC:${effectiveForceChargeGridW}W${forceChargeLimiterEnabled ? "(LIM)" : ""}`);
        }
        else if (forceChargeEnabled && forceChargeGridW > 0 && forceChargeLimiterEnabled) {
            limitFlags.push(`FC-ARMED:${forceChargeGridW}W`);
        }
    }

    if (applyGridSupport && supportCap === cappedGridSetpoint) {
        limitFlags.push(`GS:${highVoltageGridSupportW}W(HV)`);
    }

    return {
        finalChargeCurrent, finalGridSetpoint, gridCurrentLimitA, boostActive, windowName,
        voltageLimitActive, manualDischarge, exportGuard, forceChargeLimiterActive,
        baseScheduleSetpoint, summerProfile, winterProfile, seasonProfile, tariffSeason, solarForecast,
        limitFlags, effectiveConsumedAhDeficit, gridRestoreAhNeeded, manualDischargeEnabled,
        gridSupportMode, gridSupportDisableNoSun, gridSupportDisableNoSunBelowW, gridSupportLowSunBlocked,
        adaptiveGridSupportActive, adaptiveGridSupportW, plannedGridSupportW, liveSolarAssistW,
        remainingForecastWh, remainingForecastAh, supportWindowRemainingHours, batteryRemainingAh,
        usableStoredSupportAh, predictedSupportAh, supportMinGridImportW, exportGuardEnabled,
        exportGuardTargetW, exportGuardSetpointFloorW, exportGuardChargeCurrent, forecastRestoreAh,
        remainingNightHours, remainingMorningHours, remainingMorningCapacityAh, requestedGridSetpoint,
        voltageLimitedSetpoint, baseChargeCurrent, currentChargingPowerW, forceChargeEnabled,
        forceChargeGridW, effectiveForceChargeGridW
    };
}
