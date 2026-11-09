# DHW controller by outdoor curve

Status 2026-11-09: built in **d#130** (`40 Heat pump automations.js`, panel on the Automations page
`41`, event lane on the history day chart `38` / `39`) and deployed **Off**. One local controller
heats the DHW tank with the heat pump. While it is **On** it replaces the local B40 / B42 / B46 / B50
rules, their Smart / Powerful / Silent mode rules, *DF switch to heating*, *B recovery* and
*HP silent >0* (they are treated as Off; switching the controller Off brings them back). This
document holds the requirements, the review of the old behaviour, the design and the owner's
decisions.

**Built as designed, with these details:**
- Defaults as in section 4; *switch margin* 3 °C (the supply drops 1–2 °C while the compressor stands, so at the valve switch it is still ≥ the tank).
- All writes go through the same queue as the rules (1.5 s apart, each checked after 15 s). All events of one cycle share one run in the Automation log ("DHW controller").
- **Test** runs the state machine on the real readings but writes nothing: it shows when a cycle would start; the later states do not progress, because the devices do not follow.
- Switching the controller Off (or local control OFF) during a cycle: valve OFF, bypass OFF, P22 on, back to heating.
- Watchdog while On: valve ON outside a cycle for 1 min → valve OFF (replaces *B recovery*).
- Tests: 19 cases against a simple heat pump model (cycle order, switch at supply ≥ tank, set point ≤ return + gap, 1 °C steps, defrost during DHW, frost, heating lag, master OFF, Test, settings, watchdog).

## 1. Requirements (owner, 9 Nov 2026, restated)

| # | Requirement |
|---|---|
| R1 | Review what runs now for the DHW boiler and heating (below, section 2). |
| R2 | **One DHW controller** instead of the B\* rules: the tank target comes from a **curve by outdoor temperature**, like the heating curve. |
| R3 | The tank curve can be set on the dashboard (points outdoor → tank target, hysteresis). |
| R4 | The local B\* rules (B40 / B42 / B46 / B50 on, switch, off, preheat, mode rules) are set **Off** when the controller goes live. They are deleted later. |
| R5 | **Events on the charts:** DHW, heating, defrost (and preheat) shown on the Heat Pump charts. |
| R6 | **Defrost during DHW:** the pump goes to the heating side and must **not cool the tank**; afterwards it returns to DHW. |
| R7 | **Switch heating → DHW with the steps that work** (a direct valve switch does not work): preheat → lower the set point so the compressor stops → valve to the tank → set the DHW temperature. |
| R8 | **Switch only when the supply has reached the tank temperature** (so the tank is not cooled), and the return is not much colder. |
| R9 | **The controller picks the power itself** (Silent / Smart / Powerful): Silent by default, more only if the pump cannot raise the temperature. The separate mode rules go. |
| R10 | **Severe frost:** do not run DHW in severe frost. The tank's electric heater (top of the tank, always on its own thermostat) covers it. *(The original wording also mentions heating, see Q2.)* |
| R11 | **Protect the compressor:** avoid long runs at maximum frequency, especially in cold weather and with a cold tank. |
| R12 | **Smooth transitions** to a higher and to a lower temperature (set point ramps instead of jumps). |
| R13 | **Supply − return gap** during DHW at most 5–6 °C, settable on the dashboard. The supply must not run far ahead of the return. |
| R14 | Throttle with the **set point** (ramp) or the **compressor frequency** when the rise is too fast, for the compressor's sake. |
| R15 | **Efficiency:** in severe frost heat the tank with the heat pump only when it makes sense. The electric heater tops up the top of the tank anyway. |
| R16 | **Heating comes first in cold weather** (owner, 9 Nov: the house gets very cold): DHW must not take the heat pump away from heating when heating does not keep up. |

## 2. Review of the current DHW and heating behaviour (history 8 Nov 01:17 – 9 Nov 13:19)

Data: the GX recorder (30 s), 36 h, outdoor −5…+1 °C (sensor without defrost spikes).

**DHW cycles (6 switches, B46 and B50):**

| Switch | Preheat | At the switch: supply / return / tank | Compressor after the switch | DHW part | Tank | Mode |
|---|---|---|---|---|---|---|
| 8 Nov 03:42 | 4 min | 39 / 33 / 44 | 0 Hz for ~3 min, then 47 → 89 Hz | 32 min | 44 → 42 → 47 | Smart 89 Hz for 13 min, then Silent 69 Hz, then 35 Hz |
| 8 Nov 09:13 | 5 min | 39 / 33 / 44 | 0–18 Hz for ~3 min | 34 min | 44 → 41 → 46 | Smart 89 Hz 9 min, Silent |
| 8 Nov 17:36 | 3 min | 39 / 33 / 42 | 0 Hz 2 min | defrost at 17:52 during DHW | 42 → 33 (hot water used?) | Smart 89 Hz |
| 8 Nov 18:02 | (after the defrost) | 39 / 32 / 33 | 0 Hz 3 min | 49 min | 33 → 47 | Smart 89 Hz 16 min, Silent |
| 9 Nov 08:17 | 3 min | 39 / 33 / 44 | 0 Hz 3 min | 25 min | 44 → 43 → 46 | Smart 89 Hz 3 min, Silent |
| 9 Nov 11:48 | 19 min (false start, see migration log) | 46 / 39 / 46 | 0 Hz 3 min | 23 min | 46 → 45 → 50 | Silent 69 Hz |

Findings:

1. **The switch cools the tank.** Preheat ends after 3–5 min at a supply of 38–39 °C, while the tank is at 42–44 °C. Then the compressor stands for 2–3 min (set point 20) and the supply drops to the return (36–37 °C). The tank sensor falls by 1–3 °C before it rises again (R8). Only the 11:48 cycle, with a long preheat, switched at supply = tank.
2. **Preheat runs at maximum frequency.** Smart at 89 Hz with the bypass ON (small circuit), so the supply rises fast but the compressor runs flat out (R11).
3. **DHW starts at maximum.** Smart at 89 Hz for 3–16 min until *B46 mode smart-silent* (supply > 48) drops to Silent at 69 Hz. The supply − return gap was 5–7 °C (R13).
4. **End of DHW.** At the set point (46) the supply reaches 48–51 °C and the compressor modulates down to 34–36 Hz for 6–10 min before the tank passes the off threshold. That is slow, but not hard on the compressor.
5. **The return to heating is already smooth** (B46 off: 45 → 43 → 41 → 39 → 38 → 35, one step per minute).
6. **Defrost during DHW** (8 Nov 17:52): the supply fell to 20 °C and the return to 22 °C. *DF switch to heating* moved the valve to heating with the bypass ON, so the tank stopped losing heat (33 °C held). Then a new switch with preheat at 18:02. This works as R6 asks, but the tank had already dropped before.
7. **Heating:** Silent 95 % of the time, 60–69 Hz in 76 % of the running time, maximum 90 Hz only in Smart (DHW). 44 compressor starts and 44 defrosts in 36 h: almost every start follows a defrost (about one per 54 min at −1…−4 °C).
8. **The B rules are a step curve already:** B40 (outdoor −20…−11) tank 36 → 39, B42 (−10…−5) 41 → 42, B46 (−4…+1) 44 → 46, B50 (> +1) 47 → 49. Each step also has its own preheat / switch / off rules and mode rules: 19 rules for one job.
9. **Frequency settings of the pump:** DP 142 / 143 (min / max frequency) read 36 / 35 and DP 144 (DHW frequency compensation) −5. They probably only apply in the pump's own DHW work mode (`wth`), which is not used (the pump stays in heating mode and the external valve selects the tank). Their effect has to be tested before relying on them; the set point is the lever that is known to work.

## 3. Design

### 3.1 Tank target curve (R2, R3, R10, R15)

The target tank temperature comes from points (outdoor → tank °C), with linear steps between them, set on the dashboard. Proposed default (from the B rules):

| Outdoor °C | ≤ −20 | −15 | −10 | −5 | 0 | ≥ +2 |
|---|---|---|---|---|---|---|
| Tank target °C | off | 40 | 42 | 44 | 46 | 49 |

- Start when tank < target − **hysteresis** (default 3 °C), stop at tank ≥ target.
- **Frost limit** (default −20 °C, "off" in the table): below it the heat pump does not heat the tank. The electric heater does.
- Outdoor = DP 103 averaged over 10 min **outside defrosts** (the sensor reads 30–47 °C during and after a defrost).
- No start during a defrost or within 15 min after one, at most one DHW cycle per **min interval** (default 2 h; Q4), at most **max duration** (default 60 min) per cycle.

### 3.2 States

| State | What the controller does | Next |
|---|---|---|
| HEATING | Pump on its curve (P22 on, valve OFF, bypass OFF). | tank < target − hysteresis, start allowed → STOP |
| ~~PREHEAT~~ | **Removed in d#134** (owner): the start goes straight to STOP. Was: P22 off, bypass ON, set point ramped to tank + 4 °C until supply ≥ tank + margin. A cycle saved in this state by an older version goes on with STOP. | → STOP |
| STOP | P22 off, Silent, bypass OFF, set point 20 (compressor stops). | compressor 0 Hz for 20 s or 60 s → valve ON (tank), bypass OFF, set point = min(supply target, return + gap) → DHW (SWITCH is one step of the code) |
| SWITCH | Valve ON (tank), bypass OFF. | 10 s → DHW |
| DHW | Set point = min(supply target, return + gap). Supply target = tank target + 4 °C (max 55). Ramp at most +1 °C per minute. Silent; Smart only if the supply rises < 0.2 °C/min for 10 min while below the supply target; Powerful never by default (setting). | tank ≥ target → END; defrost sign 20 s → DEFROST_DHW; max duration → END |
| DEFROST_DHW | Valve OFF (heating side), bypass ON: the defrost takes its heat from the small circuit, not from the tank (R6). | defrost over (fan > 300 for 60 s) → STOP again (set point 20, then valve to the tank) |
| END | Valve OFF, bypass OFF, set point down 1 °C per minute to the heating curve value, Silent, P22 on. | → HEATING |

The heating defrost rules (DF exchange off / on 31) stay as they are. The controller has its own watchdog instead of B recovery: valve ON for 1 min outside a cycle → valve OFF.

**Without preheat (d#134, owner decision):** the valve switches to the tank while the supply is still at heating temperature (about the return, 30–38 °C) and below the tank. The tank sensor may drop by 1–3 °C at the start (point 1 of the review); the owner accepts this for a simpler, shorter cycle without the small-circuit run at high frequency (point 2).

### 3.3 Power and compressor protection (R9, R11, R13, R14)

- The main lever is the **set point**: the pump modulates its frequency to hold the supply at the set point. With set point = return + gap (default 5 °C), the supply cannot run far ahead of the return, and the frequency stays moderate.
- **Mode:** Silent by default (≤ ~70 Hz). Smart only when the supply does not rise (see DHW). Powerful only if enabled in the settings.
- Every set point change is a ramp (R12), up and down.
- Later, after a test: DP 142 / 143 / 144 as an extra frequency cap.

### 3.4 Events on the charts (R5)

From the recorder data, no new data needed: **DHW** = valve ON, **defrost** = fan 0 while the compressor runs > 30 Hz plus the bypass time after it at a heating set point, **preheat** = bypass ON with the valve OFF and the set point ≥ 40, **heating** = the rest while the compressor runs. Shown as a coloured lane between the two panels of the **day chart on the history page** (any day, also today), with counts in the legend; hover a band for its start and length. On 9 Nov it shows 16 defrosts, 2 preheats and 2 DHW cycles. The 24 h charts of the Heat Pump page (Node-RED ui_chart) are unchanged. The controller's state changes also go to the Automation log.

### 3.5 Dashboard settings (R3, R13)

On the **Heat Pump** tab, Boiler column (since d#138; before on the Automations tab): curve points, hysteresis, frost limit, gap supply − return, max duration, min interval, allow Powerful, Off / Test / On for the controller (the same Test mode as the rules: logs what it would do).

### 3.6 Rollout

1. Built and tested (d#130), deployed Off.
2. Controller **On** (the B\* rules are then Off by themselves, R4); watch the first cycles on the Automation log page and the event lane of the history page. Test mode only shows the start decision (section above).
3. Rollback: controller Off → nothing heats the tank by the heat pump (only the electric heater). Before d#134 the B\* rules ran again.
4. Done in d#134: the B\* rules, their mode rules, DF switch to heating, B recovery off and HP silent >0 are deleted from `40` (R4). The boiler curve is also drawn on the Heat Pump page, right of the heating curve.

### 3.7 Heating first in cold weather (R16)

- **Heating lag:** below the *cold limit* (default −10 °C outdoor) the controller does not start DHW while heating does not keep up: the 30-min average supply in heating is more than 2 °C below the heating curve target (P22 formula with P23 / P24).
- **Shorter DHW in the cold:** max DHW duration 60 min at ≥ −5 °C, falling linearly to 30 min at −15 °C. When it runs out, the cycle ends (the electric heater tops up).
- The tank curve is already lower in the cold (40 °C at −15 °C).

## 4. Owner decisions (9 Nov 2026)

- **Q1 tank curve:** as proposed: −15: 40, −10: 42, −5: 44, 0: 46, ≥ +2: 49; hysteresis 3 °C.
- **Q2 severe frost:** below −20 °C no DHW by the heat pump; heating runs as usual (no extra limit on heating).
- **Q3 gap supply − return:** 5 °C.
- **Q4 interval:** at most one DHW cycle per 2 h, at any time of day; in severe frost heating must keep working (R16, section 3.7).
- **Q5 tank volume / electric heater:** not known yet (only needed for an efficiency estimate).
