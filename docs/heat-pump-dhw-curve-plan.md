# Plan: DHW by the heat pump's own curve (two curve settings)

Status 2026-11-10: **built in d#142** (deployed 13:01, controller On). Owner decisions (10 Nov): option B, P23 ramp kept (gap ≤ 5 °C), and extra compressor protection in frost (section 2.6).

**Pump test before the build (10 Nov 12:43–12:54, heating, outdoor −1 °C):** P23 38 → 0 with P22 on: the compressor went 61 → 46 → 0 Hz within ~50 s and stayed off (supply 37 → 31 °C). P23 back to 38: restart after ~50 s, soft start to 69 Hz in ~2 min. **DP 125 did not change (36 °C all the time):** with P22 on the pump does not report the curve's set point, so the page and the controller compute it from the formula.

**As built, differences to the plan:** STOP waits for 0 Hz for 20 s or at most 90 s; the protection end (P4) also fires when the 3rd step is followed by 3 more hot minutes; outside a cycle the controller stores the pump's P23 / P24 as the heating curve whenever they are not the stop / boiler values (so the P23 slider keeps working), and writes them back when the pump shows P23 0, the boiler P24 or P22 off. Model tests: 26 checks (cycle, no P22 off, no DP 125 writes, P23 ramp ≤ 1 per minute within the gap, heating curve back at the end and after a restart mid-cycle, defrost in DHW waits for the outdoor sensor, DF rules only outside a cycle, frost / cold / protection, Test, settings, interval across a restart). A cycle needs about 18 writes. Owner request (10 Nov): use only the heat pump's built-in
weather curve (P22 / P23 / P24) and set its values for the boiler — one curve setting for heating,
one for the boiler; pick the boiler values; simplify the boiler automation to use the curve; keep
the switch to heating during a defrost in DHW; keep the bypass ON during a defrost in heating.

How it works now (summary for the owner): [heat-pump-boiler.md](heat-pump-boiler.md).

Related: [heat-pump-dhw-controller.md](heat-pump-dhw-controller.md) (current controller, R1–R16),
[heat-pump.md](heat-pump.md) (devices, DP map), [heat-pump-work-log.md](heat-pump-work-log.md).

## 1. Current implementation (d#141, live on the GX)

### 1.1 Devices and DPs used

| Device | DP | Use |
|---|---|---|
| Heat pump | 102 supply, 101 return, 103 outdoor, 108 tank, 115 Hz, 116 fan | readings |
| Heat pump | 125 heating set point (15–55 °C) | written by the DHW controller (stop, ramp) |
| Heat pump | 132 P22 curve on / off | OFF during a DHW cycle, ON after it |
| Heat pump | 133 P23 ambient point (0–40), 134 P24 coefficient (1–30) | heating curve, only the P23 slider writes them |
| Heat pump | 2 mode (Silent / Smart / Powerful) | Silent; Smart if the supply does not rise |
| Valve relay | 1 (ON = tank) | DHW / heating |
| Bypass relay | 1 (ON = exchanger bypassed) | defrost |

Built-in curve (P22 on): **set = 20 + P24 / 10 × (P23 − outdoor)**, limited to 20…60 °C. Heating
now: P23 = 38, P24 = 4 → 36 °C at −1 °C.

### 1.2 Local automations

| Rule / part | When | What |
|---|---|---|
| `df_exchange_off` (DF exchange off) | defrost sign (fan 0, > 30 Hz), bypass OFF, supply < 27, outdoor < 14 | bypass ON, defrost flag ON |
| `df_exchange_on` (DF exchange on 31) | bypass ON, fan > 300, supply > 27, set < 45, P22 on | bypass OFF, 7 min, flag OFF |
| `hp_er03_restart` (Off) | fault Er03 with valve ON | valve OFF, pump restart, heating curve back |
| DHW controller | state machine, see 1.3 | heats the tank |

### 1.3 DHW controller (state machine in `40`)

| State | What it does | Next |
|---|---|---|
| HEATING | pump on its curve | tank < target − 3, no defrost for 15 min, ≥ 2 h since the last cycle, outdoor ≥ −20, heating not lagging in frost → STOP |
| STOP | **P22 OFF**, Silent, bypass OFF, **set 20** → compressor stops | 0 Hz for 20 s or 60 s → DHW |
| DHW | valve ON; **set ramped +1 °C/min**, kept ≤ return + 5 and ≤ tank target + 4 (max 55); Smart if the supply rose < 2 °C in 10 min; Silent near the target | tank ≥ target, max duration (60 min, 30 min at ≤ −15) → RAMPDOWN; defrost → DEFROST_DHW |
| DEFROST_DHW | valve OFF (heating side), bypass ON | fan > 300 for 60 s → STOP |
| RAMPDOWN | valve OFF, bypass OFF, Silent, **set −1 °C/min** down to the heating curve value | → **P22 ON** → HEATING |

Tank target curve (outdoor → tank): −15 → 40, −10 → 42, −5 → 44, 0 → 46, ≥ +2 → 49; off below −20.

### 1.4 How it runs (cycles 9–10 Nov)

| Start | Tank | DHW part | Ramp-down |
|---|---|---|---|
| 9 Nov 21:13 | 41 → 46 °C | 30 min, set 43 → 49 | 21:43 → 22:16 (stalled 20 min by the d#135 bug) |
| 10 Nov 10:28 | 42 → 46 °C | 30 min | 10:58 → 11:12 (14 min) |

Weak points:
1. **P22 is OFF and the set point is high during every cycle.** If Node-RED stops or the node restarts
   mid-cycle, the pump stays at e.g. set 49 °C with no curve. This happened on 9 Nov (21:43–22:03, set 49 °C, P22 off, d#135 bug).
2. The controller writes the set point about 20–30 times per cycle (ramp up and down), each a
   device write with a check.
3. Two sources of truth for the supply: the curve in heating, the controller in DHW.

## 2. Planned implementation

### 2.1 Principle

**P22 stays ON all the time.** The pump always follows its own curve. The controller only switches
the curve's values:

| Curve setting | P24 | P23 | Used |
|---|---|---|---|
| **Heating** | the owner's value (now 4) | the owner's value (now 38, P23 slider) | outside DHW cycles |
| **Boiler** | fixed (see 2.2) | from the boiler curve (see 2.2) | during the DHW part of a cycle |
| **Stop** | unchanged | 0 | ~1 min before each valve switch (curve → 20 °C → compressor stops) |

If anything stops mid-cycle, the pump still runs on a curve. On every start of `40`, and as a
watchdog outside a cycle, the heating values are written back when the pump shows other values.

### 2.2 Boiler curve values

**Constraint:** P24 is 1…30, so the built-in curve always **falls** when it gets warmer outdoors. The
tank target should do the opposite: **rise** when it is warmer, because the pump is more efficient
then and heating needs less. One fixed P23 / P24 pair therefore cannot follow the tank curve.

Wanted DHW supply = tank target + 4 °C. Today's cycles needed about 49 °C supply for 46 °C in the tank.

| Outdoor °C | −15 | −10 | −5 | 0 | +2 | +5 | +10 |
|---|---|---|---|---|---|---|---|
| Tank target (current curve) | 40 | 42 | 44 | 46 | 49 | 49 | 49 |
| **Wanted supply** | 44 | 46 | 48 | 50 | 53 | 53 | 53 |
| A: fixed P23 40 / P24 7 → supply | 55 * | 55 | 51.5 | 48 | 46.6 | 44.5 | 41 |
| B: P24 12, P23 per cycle → P23 | 5 | 12 | 18 | 25 | 30 | 33 | 38 |
| B: → supply | 44 | 46.4 | 47.6 | 50 | 53.6 | 53.6 | 53.6 |

\* the curve gives 58.5; the pump limits the heating set point to 55 °C (DP 125 range).

**Option A — two fixed pairs (exactly as asked, simplest).** Heating 38 / 4, boiler **40 / 7**.
Good at 0…+2 °C. In frost the supply goes to 55 °C (hard for the compressor, low COP, and it
contradicts R11 / R15 / R16); in mild weather it reaches only 41–45 °C, so the tank target is not
reached and the cycle ends by max duration. The tank target table would have to be replaced by
"tank target = boiler curve − 4", which means a hotter tank in frost.

**Option B — fixed P24, P23 from the boiler curve (recommended).** Boiler P24 = **12** (1.2 °C per
°C). At the cycle start the controller computes **P23 = outdoor + (wanted supply − 20) / 1.2**
(integer, 0…40) from the 10-min outdoor average, and writes it again only if the average moves by
≥ 2 °C. The pump's curve then gives the wanted supply at the current outdoor temperature, and the
tank target curve (owner's table) stays as it is. Still only two values written per cycle start.

Both: the heating values are read from the pump before the cycle and stored in the settings file,
so the P23 slider stays the owner's heating control.

### 2.3 Simplified DHW cycle

| State | Writes | Next |
|---|---|---|
| HEATING | — (watchdog: heating P23 / P24 back if the pump shows others; valve OFF if ON outside a cycle) | start conditions unchanged → STOP |
| STOP | P23 = 0 (curve → 20 °C), Silent, bypass OFF | 0 Hz for 20 s or 90 s → DHW |
| DHW | valve ON, P24 = boiler, P23 = boiler (option B: computed) | tank ≥ target or max duration → END; defrost → DEFROST_DHW |
| DEFROST_DHW | valve OFF (heating side), bypass ON — **kept as now** | fan > 300 for 60 s **and** outdoor sensor back (< 14 °C, no spike) → STOP |
| END | valve OFF, bypass OFF, P24 / P23 = heating | → HEATING |

Removed: P22 OFF / ON, all DP 125 writes, the +1 °C/min ramp up, RAMPDOWN (the curve takes the set
point back at once; the compressor modulates down by itself). About 6–8 writes per cycle instead of
20–30.

Kept: start conditions (curve, hysteresis, frost limit −20, 2 h interval, heating first in frost,
no start 15 min after a defrost), max duration, Silent by default with Smart only when the supply
does not rise, the valve watchdog, Off / Test / On, the log.

**Choice for the owner — supply − return gap (R13).** Without the ramp the pump jumps to the boiler
set point and the gap can reach 7–8 °C for a few minutes (seen on 8 Nov with the cloud rules).
Option: keep the gap by raising P23 in steps (1 per minute = 1.2 °C per minute with P24 12) until it
reaches the boiler value, while supply − return ≤ gap. That is 5–15 extra writes per cycle, but
still no P22 OFF.

### 2.4 Defrost

| Mode | What happens | Implemented by |
|---|---|---|
| **DHW** (valve ON) | valve to heating, bypass ON, the tank is not cooled; after the defrost: stop → valve to the tank again | DHW controller (DEFROST_DHW → STOP), as now |
| **Heating** (valve OFF) | **bypass ON** during the defrost, OFF when the fan runs again | `df_exchange_off` / `df_exchange_on`, as now |

Change: the two DF rules run only while the DHW controller is in HEATING, so they never act on the
bypass during a DHW cycle (today the conditions mostly keep them apart: set < 45 and P22 on).
Their conditions stay; `df_exchange_on` keeps "P22 on", which is always true in the new design.

Note: during and for several minutes after a defrost the outdoor sensor reads 30–47 °C. With P22 on,
the curve then gives a low set point (in heating too, as today). That is why DEFROST_DHW waits for
the sensor before the valve goes back to the tank.

### 2.5 Page and settings

- Heat Pump page, heating column: heating curve and P23 slider as now. While a DHW cycle runs, `37`
  refuses a P23 change ("DHW cycle running") — the heating value is restored at the end anyway.
- Boiler column: the boiler curve chart shows the wanted supply line (tank target + 4) and the pump
  curve that the boiler values give; settings: tank target points, hysteresis, frost limit, boiler
  P24 (option B) or boiler P23 / P24 (option A), gap ramp on / off, max duration, interval.
- Settings file `heat-pump-automations.json`: `dhw.boilerP24`, `dhw.boilerP23` (A), `dhw.heatP23` /
  `dhw.heatP24` (stored heating values), `dhw.gapRamp`.

### 2.6 Compressor protection in frost (owner, 10 Nov)

Owner: in frost the compressor must not run at its maximum; it had a hard time, it has to be kept
and spared. Facts: nameplate max 9.67 A / 2.13 kW, frequency up to 90 Hz; Silent holds about
69–70 Hz, Smart goes to 89–90 Hz. Measured since 8 Nov (55 h): 45 h at 40–70 Hz, 7.2 h at 70–90 Hz,
0.1 h at ≥ 90 Hz, discharge never > 95 °C; 71 starts, 70 defrosts.

Rules during a DHW cycle (all logged, all settable on the page):

| # | Check | Action |
|---|---|---|
| P1 | outdoor (10-min average) ≤ cold limit (default −10 °C) | **Silent only**: no Smart, no Powerful in DHW |
| P2 | outdoor ≤ cold limit | boiler supply capped at **46 °C** (P23 computed for at most 46), so the tank target there is at most 42 °C; the electric heater tops up the top of the tank |
| P3 | compressor ≥ **80 Hz** for 3 min, or current ≥ **85 %** of 9.67 A (8.2 A) for 3 min, or discharge (DP 104) ≥ **90 °C** | **P23 − 2** (≈ −2.4 °C supply) and Silent; again every 3 min while it holds |
| P4 | P3 held for 10 min, or 3 steps of P3 in one cycle | **end the cycle** (tank left to the electric heater), log "compressor protection" |
| P5 | outdoor ≤ cold limit | max duration 30 min (now 30 min only at ≤ −15) and min interval **3 h** (now 2 h) |
| P6 | outdoor ≤ frost limit (−20 °C) | no DHW by the heat pump (as now) |
| P7 | heating lags its curve by > 2 °C at ≤ cold limit | no DHW start (as now, R16) |

The compressor resource counters (`45`) already count hours by frequency band and with a hot
discharge; the work log will compare them before and after.

Not used: DP 142 / 143 (pump frequency limits) — they probably act only in the pump's own DHW work
mode; testing them is a separate step.

## 3. Steps

1. **Pump test (manual, 15 min, controller On):** write P23 = 0 with P22 on in heating — check that
   DP 125 follows within seconds and the compressor stops; write P23 back. Then, at the next DHW
   cycle start, compare the pump's DP 125 with the curve formula for P24 = 12.
2. Build in `40`: new curve steps, STOP / DHW / DEFROST_DHW / END, heating values stored and
   restored, watchdog, DF rules guarded by HEATING. Remove RAMPDOWN and the P22 / DP 125 writes.
3. `34` / `35`: boiler curve chart and settings; `37`: refuse P23 while a cycle runs.
4. Tests against the heat pump model (as for d#130): cycle order, stop by P23 0, P23 ramp with the
   gap, heating values restored after a node restart mid-cycle, defrost in DHW and in heating,
   frost / lag guards, compressor protection P1–P5.
5. Deploy with the controller in **Test**, check one would-be cycle in the log, then **On**; watch the
   first two cycles (tank rise, supply − return, Hz, ramp-down gone) on the history page.
6. Docs: heat-pump-dhw-controller.md section 3, heat-pump.md, work log.

Rollback: controller Off → heating values written back, P22 on (as now).

## 4. Decisions (owner, 10 Nov)

1. **Option B**: boiler P24 = 12, P23 from the boiler curve at the cycle start.
2. **Gap ramp kept**: P23 rises 1 per minute while supply − return ≤ 5 °C.
3. **Compressor protection in frost** as in section 2.6.
