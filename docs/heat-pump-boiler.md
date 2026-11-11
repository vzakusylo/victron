# Boiler (DHW tank) control: what was done and how it works now

Status 2026-11-11, flow **d#144** on the Cerbo GX. The DHW tank is heated by one local controller,
the **DHW controller** in `40 Heat pump automations.js`. It runs the heat pump on the pump's own
weather curve and only switches the curve's values. Smart Life does not run any heat pump scene
any more, apart from two scenes whose conditions can never be true (left on in the app, not on the
GX).

Related documents: [heat-pump-dhw-curve-plan.md](heat-pump-dhw-curve-plan.md) (design and owner
decisions for d#142), [heat-pump-dhw-controller.md](heat-pump-dhw-controller.md) (requirements
R1–R16, review of the old cloud behaviour, the d#130 design),
[heat-pump-work-log.md](heat-pump-work-log.md) (every step with the owner's requests),
[heat-pump.md](heat-pump.md) (devices, DP map, pages).

## 1. What was done

| When | Version | Change |
|---|---|---|
| until 9 Nov | — | DHW by **19 Smart Life cloud scenes** (B40 / B42 / B46 / B50: preheat, switch, off, plus mode rules), one step per outdoor band; a cloud-only "Voksen heating" device as defrost flag. |
| 8–9 Nov | d#123–d#129 | The same scenes as **local rules** in Node-RED (Off / Test / On per rule, internal defrost flag, Automation log by day); scenes switched off in Smart Life group by group. |
| 9 Nov | d#130–d#131 | **DHW controller**: one state machine with an editable tank target curve by outdoor temperature, preheat with the bypass, staged switch, set point ramp ≤ return + gap, Silent / Smart automatically, frost and "heating first" limits. The B\* rules were treated as Off. |
| 9 Nov | d#134 | **No preheat** (owner): set point 20 → compressor stops → valve to the tank → heat. The 23 replaced B\* / mode / recovery rules **deleted**. Boiler curve drawn next to the heating curve. |
| 9 Nov | d#135, d#137, d#138 | Battery sensors read locally; two bugs of d#135 fixed (node id clash with the Automation log; Tuya `data.t` in seconds made the devices look stale and stalled a ramp-down at set 49 °C with P22 off for 20 min). |
| 9 Nov | d#138–d#139 | DHW controller panel moved to the **Heat Pump** page (Boiler column), removed from the Automations page. |
| 9 Nov | d#140 | The two never-true HP mode rules deleted. Local rules left: DF exchange off / on, HP Er03 restart. |
| 11 Nov | d#144 | Er03 (no water flow) ~40 s after the valve switch stopped 4 cycles (tank 42 → 33 °C): 90 s valve travel with P23 0 before the boiler curve, Er03 ends the cycle at once, retry after 15 min, max duration counts heating time only. |
| 10 Nov | d#143 | First live cycle on the curve (14:16): the compressor stayed off for 9 min after the valve switch, because the P23 start was counted from the heating return (33 °C) while the loop already held tank water (40–42 °C) — the curve was below the water. The start and the ramp limit now use the warmest of return / supply / tank. |
| 10 Nov | d#142 | **DHW on the pump's own curve** (owner: use only the heating curve, two settings — heating and boiler). P22 always on; stop by P23 0; boiler P24 12 with a P23 computed per cycle; P23 ramp within the supply − return gap; heating curve written back at the end; **compressor protection** in the cold and on high frequency / current / discharge. Tested on the pump (P23 0 stops the compressor) and on a model (26 checks). |

## 2. How it changed

| | Cloud scenes (until 9 Nov) | DHW controller d#130–d#141 | **Now (d#142)** |
|---|---|---|---|
| Rules for DHW | 19 scenes + flag device | 1 controller | 1 controller |
| Tank target | 4 steps by outdoor band | curve, editable | curve, editable (same) |
| Preheat | bypass ON, Smart at 89 Hz | until d#134; then none | none |
| Compressor stop before the valve | set point 20, P22 off | set point 20, P22 off | **P23 0, P22 stays on** |
| Supply during DHW | fixed set point 40–50 | DP 125 ramped +1 °C/min, ≤ return + 5 | **pump curve** with boiler values, P23 +1/min within the gap |
| End of DHW | set point down in steps, P22 on | DP 125 −1 °C/min (≈ 14 min), P22 on | **heating curve back in one step** |
| If Node-RED stops mid-cycle | — (cloud) | P22 off, high set point stays | the pump keeps running on a curve; heating values restored on the next start |
| Writes per cycle | 10–20 cloud actions | 20–30 | about 18 |
| Power | Smart, up to 89–90 Hz | Silent, Smart if the supply does not rise | same, **Silent only in the cold**, protection steps |
| Defrost in DHW | DF switch to heating | valve to heating, bypass ON | same, **back to the tank only after the outdoor sensor is back** |
| Defrost in heating | DF exchange off / on | same | same, **only outside a DHW cycle** |

## 3. How it works now

### 3.1 Devices and data points

| Device | DP | Used for |
|---|---|---|
| Heat pump (Tuya, local, 192.168.1.31) | 101 return, 102 supply, 103 outdoor, 104 discharge, 108 tank, 112 current, 115 Hz, 116 fan | readings (every poll / push) |
| Heat pump | 132 P22 curve on / off | kept **on**; written only if it is found off |
| Heat pump | 133 P23 ambient point (0–40), 134 P24 coefficient (1–30) | **the only values the controller writes for the supply** |
| Heat pump | 2 mode | Silent / Smart (Powerful only if allowed) |
| Valve relay (192.168.1.53, Tuya 3.5) | 1: ON = tank, OFF = heating | DHW / heating |
| Bypass relay (192.168.1.139) | 1: ON = exchanger bypassed | defrost |

The pump's curve: **supply set point = 20 + P24 / 10 × (P23 − outdoor)**, limited to 20…60 °C
(the pump limits heating to 55 °C). With P22 on the pump does **not** report this value in DP 125
(it stays at the last manual set point, 36 °C), so the page and the controller compute it.

### 3.2 The curve settings

| Setting | P23 | P24 | When |
|---|---|---|---|
| **Heating** | 38 (owner, P23 slider) | 4 | outside DHW cycles — stored in the settings file (`heatCurve`) |
| **Stop** | 0 | unchanged | ~20–90 s before every valve switch to the tank: curve → 20 °C, compressor stops |
| **Boiler** | computed (below) | 12 | during the DHW part of a cycle |

Heating curve now (P23 38 / P24 4):

| Outdoor °C | −15 | −10 | −5 | 0 | +5 | +10 |
|---|---|---|---|---|---|---|
| Heating supply °C | 41.2 | 39.2 | 37.2 | 35.2 | 33.2 | 31.2 |

**Boiler curve.** P24 is at least 1, so the pump's curve always falls when it gets warmer outdoors,
while the tank target rises (the pump is more efficient in mild weather). So P24 is fixed at 12
(1.2 °C per °C) and **P23 is computed** from the wanted supply at the 10-minute outdoor average:
**P23 = outdoor + (wanted supply − 20) / 1.2**, rounded, 0…40. The wanted supply is
**tank target + 4 °C**, at most 55 °C, and at most **46 °C at ≤ −10 °C** (compressor protection).

| Outdoor °C | −15 | −10 | −5 | −1 (now) | 0 | +2 | +5 | +10 |
|---|---|---|---|---|---|---|---|---|
| Tank target °C | 40 | 42 | 44 | 45.5 | 46 | 49 | 49 | 49 |
| Wanted supply °C | 44 | 46 | 48 | 49.5 | 50 | 53 | 53 | 53 |
| Boiler P23 | 5 | 12 | 18 | 24 | 25 | 30 | 33 | 38 |
| Curve supply °C | 44.0 | 46.4 | 47.6 | 50.0 | 50.0 | 53.6 | 53.6 | 53.6 |

Below −20 °C (frost limit) the heat pump does not heat the tank; the electric heater at the top of
the tank does.

### 3.3 When a cycle starts

All of these on 3 ticks in a row (the controller ticks every 10 s):

- tank < target − 3 °C (target from the curve at the 10-min outdoor average without defrosts);
- outdoor ≥ −20 °C;
- the last cycle ended ≥ 2 h ago (≥ 3 h at ≤ −10 °C); the time is kept in the settings file;
- no defrost now and none in the last 15 min, defrost flag OFF;
- valve OFF, heat pump on;
- the heating curve is stored;
- at ≤ −10 °C: heating does not lag its curve by more than 2 °C (30-min average) — heating first.

### 3.4 The cycle step by step

| Step | What the controller writes | Typical time |
|---|---|---|
| **Start** | Silent; bypass OFF if ON; **P23 0** (P22 on if it was off) | — |
| **STOP** | waits for 0 Hz for 20 s (or at most 90 s) | ~1 min (test: 61 → 0 Hz in ~50 s) |
| **VALVE** (d#144) | valve ON, bypass OFF; the curve **stays at P23 0 for 90 s** while the valve moves (demand during the move caused Er03 on 11 Nov) | 90 s |
| **Valve to the tank** | valve ON; **P24 12**; **P23 start** = the lower of the boiler P23 and the P23 for "water + 5 °C" (water = the warmest of return, supply and tank: after the switch the loop holds tank water) | — |
| **DHW** | P23 **+1 per minute** (≈ +1.2 °C supply) up to the boiler P23, but only while the curve supply stays ≤ the warmer of return / tank + 5; P23 down again if they fall | 20–40 min |
| **End** | when the tank reaches the target, or after 60 min **of heating** (30 min at ≤ −10 °C; defrosts do not count, hard cap 90 min), or on **Er03** / if the valve was switched by someone else (then a **retry after 15 min**, at most 2 in a row): valve OFF, bypass OFF, Silent, **P24 / P23 of the heating curve** | one step |

After the end the pump simply follows the heating curve again; the compressor modulates down by
itself (no set point ramp-down any more).

### 3.5 Power and compressor protection

- **Silent** by default (about 69–70 Hz of 90).
- **Smart** only above −10 °C, only if the supply rose < 2 °C in 10 min while it is > 3 °C below the
  wanted supply, and only if no protection step happened in the cycle. Back to Silent near the
  wanted supply. **Powerful** only if allowed in the settings (off).
- **At ≤ −10 °C:** Silent only, wanted supply ≤ 46 °C, cycle ≤ 30 min, at most one cycle per 3 h.
- **Protection during DHW:** compressor ≥ 80 Hz, or current ≥ 85 % of 9.67 A (8.2 A), or
  discharge ≥ 90 °C, held for 3 min → **P23 − 2** (≈ −2.4 °C supply) and Silent; again every 3 min
  while it holds. Held 10 min, or hot again for 3 min after 3 steps → **end of the cycle**, the
  electric heater takes over. Every step is in the Automation log ("compressor protection: …").

For comparison, the compressor since 8 Nov (55 h measured): 45 h at 40–70 Hz, 7.2 h at 70–90 Hz,
0.1 h at ≥ 90 Hz, discharge never above 95 °C (Compressor resource card, `45`).

### 3.6 Defrost

| Mode | What happens | By |
|---|---|---|
| **During DHW** (valve ON) | defrost sign (fan 0, > 30 Hz) on 2 ticks → valve OFF (heating side) and bypass ON, so the defrost does not take its heat from the tank. When the fan has run > 300 rpm for 60 s **and** the outdoor sensor is back (within 3 °C of the average; it reads 30–47 °C after a defrost) → P23 0 → stop → valve to the tank → boiler curve again. | DHW controller |
| **During heating** (valve OFF) | bypass ON at the defrost (fan 0, > 30 Hz, supply < 27 °C, outdoor < 14 °C), defrost flag ON; bypass OFF when the fan runs again (> 300 rpm, supply > 27 °C), flag OFF 7 min later (at the latest after 10 min) | rules *DF exchange off* / *DF exchange on 31*, only while no DHW cycle runs |

### 3.7 Safety

- **Node-RED stops or the node restarts mid-cycle:** P22 was never turned off, so the pump keeps
  heating on a curve. On the next start the context is empty; the controller starts in HEATING,
  sees P23 0 or P24 12 on the pump and writes the stored heating curve back (and the valve
  watchdog turns the valve OFF after 1 min). Tested on the model.
- **Controller Off / Test or local control OFF during a cycle:** valve OFF, bypass OFF, heating
  curve back at once.
- **Valve watchdog:** valve ON outside a cycle for 1 min → valve OFF.
- **Heating curve kept current:** outside a cycle the controller stores the pump's P23 / P24 as the
  heating curve whenever they are not the stop / boiler values — so a change with the P23 slider
  is kept. During a cycle the slider is locked ("DHW cycle running").
- Every write goes through one queue (1.5 s apart) and is checked 15 s later (*confirmed* /
  *NOT confirmed* in the log).

### 3.8 Other local automations

| Rule | Mode | What |
|---|---|---|
| DF exchange off | On | bypass ON at a defrost during heating (only outside a DHW cycle) |
| DF exchange on 31 | On | bypass OFF after the defrost, flag OFF 7 min later (only outside a DHW cycle) |
| HP Er03 restart | On | water-flow fault with the valve ON: valve OFF, pump off 1 min, on, bypass OFF, P22 on; the DHW controller ends its cycle and writes the heating curve back |

### 3.9 Settings (Heat Pump page → Boiler column, saved in `grid-control-config/heat-pump-automations.json`)

| Setting | Now | Range | Meaning |
|---|---|---|---|
| Tank curve | −15 → 40, −10 → 42, −5 → 44, 0 → 46, +2 → 49 | 2–8 points, 30–55 °C | tank target by outdoor |
| start below target − | 3 °C | 1–10 | hysteresis |
| supply = target + | 4 °C | 1–10 | wanted DHW supply |
| boiler P24 | 12 | 5–30 | slope of the boiler curve |
| ramp P23 +1/min, gap | on, 5 °C | 3–10 | supply − return limit while ramping |
| max supply | 55 °C | 45–55 | cap of the wanted supply |
| frost limit | −20 °C | −30…10 | no DHW by the heat pump below |
| cold limit | −10 °C | −25…5 | Silent only, supply ≤ cold cap, cold interval, heating first |
| cold cap | 46 °C | 40–55 | wanted supply cap in the cold |
| min interval / cold | 2 h / 3 h | 0–12 | between cycles |
| max duration / cold | 60 / 30 min | 15–180 / 10–180 | per cycle |
| protection | 80 Hz, 85 % of 9.67 A, discharge 90 °C | 50–90, 50–100, 70–110 | for 3 min → P23 − 2 |
| allow Powerful | off | — | |
| heating curve (stored) | P23 38 / P24 4 | — | written back after every cycle |

### 3.10 Where to see it

- **Heat Pump page, Boiler column:** tank, target, *start below*, valve, controller state and the
  reason it waits; Off / Test / On; during a cycle "boiler curve now: P24 12 / P23 x → goal y,
  curve supply ≈ z °C, wanted w °C" and protection steps; the boiler chart (tank target, start
  line, wanted supply, frost zone, target / tank / supply now); the settings.
- **Heat Pump page, Heating column:** the heating curve with the P23 slider; during a cycle a note
  that the pump runs on the boiler curve, the chart shows the stored heating curve, the slider is
  locked.
- **History by day:** event lane (heating / DHW / defrost), temperatures, power and compressor
  current with values on hover. **While a cycle runs** (d#143), today's chart shows a dashed tank
  target line from the cycle start and a dashed projection from the tank now to the target at the
  **expected end** ("46 °C ≈ 15:03"), with the tank rise; today's chart refreshes every minute.
  The expected end comes from the least-squares tank rise of the last 6 min, at the latest the
  max duration. The Boiler column shows the same ("heading to 46 °C, expected end ≈ 15:03").
- **Automation log:** one entry per cycle ("DHW controller") with every write and its check.

### 3.11 Rollback

- Stop DHW by the heat pump: DHW controller **Off** (the heating curve goes back if a cycle runs).
- Back to the version before d#142: redeploy from `/data/home/nodered/.node-red/backup-20261110-pre-d142`
  (in git: commit `64cf04a`, d#141); then P22 is switched off during cycles again.

## 4. Open points

- **First live cycle on the curve: 10 Nov 14:16–14:43**, tank 40 → 46 °C in 26 min, all writes
  confirmed, heating curve 38 / 4 back. The compressor stood 9 min after the valve switch (start P23
  too low, fixed in d#143); the next cycle shows whether it now starts at once.
- DP 142 / 143 (pump frequency limits) are not used; they probably act only in the pump's own DHW
  work mode.
- The accumulator tank sensor has not sent a local reading yet (it reports only on a change); the
  cloud is its fallback.
