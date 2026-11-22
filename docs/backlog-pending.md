# Pending tasks (not yet in BACKLOG.md; owner decides)

Proposals from investigations. They are not planned work. When the owner accepts one, it moves to `BACKLOG.md` and
is removed from here.

## 2026-11-22: DHW forced-cycle safety stop at 16:16 (GX d#210)

Alerts (Heat pump alerts, node 47):

- 16:14 `DHW controller: mode Silent — NOT confirmed, device reports smart` (×3, last 16:16)
- 16:16 `forced cycle safety stop pending: device unavailable or invalid cycle measurements; queued writes cancelled`
- 16:16 `mode Silent — verification superseded by forced-cycle stop`
- 16:16 `end of DHW (forced cycle lost valid cycle measurements or device availability): tank 47 → 49 °C after 29 min
  (26 min heating) → valve to heating, heating curve back (P23 37 / P24 7)`

The state afterwards: tank 49 °C, supply 37 / return 32 °C, outdoor 2 °C, compressor 69 Hz, valve on heating, bypass
OFF. The DHW controller showed HEATING (tank 49 ≥ 47; last cycle 13 min ago, min 1 h; defrost now or < 15 min ago).

**Summary:** the 16:16 stop was a telemetry safety stop, not a stop at the tank target. Under the current policy,
stopping at 49 °C was correct. The alert doesn't name the input that failed, so it is unknown whether this was a real
device outage or one bad reading. Defrost alone does not trigger this stop.

This was traced in the source only; the live GX and the telemetry at the moment of the stop were not checked. The 49
targeted DHW tests pass on d#212.

### HP-P1: three "Silent NOT confirmed" mails in one DHW cycle (small; part of HP-M1)

- **Cause:**
  - During DHW, the cold-limit, compressor-protection or near-supply-target logic can ask for DP 2 = mute again once
    the one-minute same-mode guard has passed.
  - Each SET checks the cached DP 2 only once, 15 s later. A `smart` reading proves only that the cache disagrees; it
    doesn't prove the pump rejected Silent, switched back, or got a competing write.
  - Node 47 counted three identical failures in one digest.
  - The "superseded" line is a separate result: the cancellation dropped the old run's unsent writes and marked its
    open check as superseded. It doesn't undo a SET that was already sent.
- **Evidence:** `lib/heat-pump/dhw-tick.js:26–30, 347–377`; `lib/heat-pump/dhw-helpers.js:94–101`;
  `40 Heat pump automations.js:318–355`; `47 Heat pump alerts.js:138–150`.
- **Task:** cover this sequence in HP-M1 instead of a separate implementation.
- **Tests:** replay three cached mismatches followed by a cancellation. Check that:
  - stale and fresh mismatches are told apart;
  - superseded checks don't count as failures;
  - the safety-stop alert still comes through.
- **Conflicts:**
  - HP-M1 covers confirmation and mail dedup, but deliberately keeps DHW and protection out of the retry backoff.
  - HP-M1's freshness changes touch node 34, so coordinate them with NR9 (node 34).
  - HP-M2 handles stale queued ownership, not why the device reports Smart.

### HP-P2: log the exact safety-stop trigger (small)

- **Cause:**
  - What tripped the stop is unknown. A forced run latches the stop on a single tick when either of these happens:
    - the HP, valve or bypass device is disconnected, or its data is older than 5 min;
    - a required reading is invalid: tank, supply/return, compressor Hz, fan, outdoor, current, discharge, the fault
      DP, P22–P24, or either relay state.
  - DP 2 is not on that list. A fan reading of 0 is valid, and normal defrost has its own DHW branch.
  - When a device is unavailable, the controller cancels the queued writes at once and waits for the device before it
    restores.
  - Both messages arriving at 16:16 fit either a bad reading while the devices stayed ready, or a short outage followed
    by recovery. The later "defrost now or < 15 min ago" line doesn't tell these apart.
- **Evidence:** `lib/heat-pump/dhw-tick.js:8–14, 58–79, 134–145, 305–324`;
  `40 Heat pump automations.js:151, 256–258`.
- **Task:** on the first bad tick, record:
  - the run ID and phase;
  - the failed device and its age or state;
  - the names of the invalid DPs;
  - the defrost and recovery flags.

  Keep the existing safety behaviour.
- **Tests:**
  - disconnect and reconnect;
  - stale data;
  - invalid fields;
  - a valid fan-zero defrost that takes the normal defrost path.
- **Conflicts:** no code conflict with HP-M1 or NR9 if the diagnostics stay in the DHW controller and use its existing
  state. Coordinate with both before adding per-DP telemetry to node 34.

### HP-P3: show "stopped" apart from "restore confirmed" (medium)

- **Cause:**
  - HEATING here means space heating, not tank heating.
  - The safety path queued valve-to-heating, Silent, and the saved 37/7 curve under a new run, then set HEATING without
    waiting for the read-back.
  - The later snapshot shows the valve back on heating, but it doesn't confirm the curve restore or the final DP 2.
  - The stop set `lastEnd`, not `lastDone`: 49 °C didn't meet the 50 °C target, but it was above the 47 °C restart
    threshold. Together with the one-hour interval and the defrost guard, that explains why DHW didn't restart.
- **Evidence:** `lib/heat-pump/dhw-tick.js:106–123, 134–145, 185–205, 325`; `34 Heat pump state.js:422`.
- **Task:** keep the safety stop, and show its reason and the restore status separately from HEATING.
- **Tests:**
  - a stop at 49/50 °C;
  - a delayed or failed restore;
  - a reconnect;
  - the defrost bypass is kept.
- **Conflicts:**
  - Reuse the HP-M1 confirmation.
  - Coordinate restore ownership with HP-M2.
  - Don't change node 34 at the same time as NR9.

**Don't relax the stop policy** unless HP-P2 shows the trigger was a harmless glitch and there is a safe way to handle
it.
