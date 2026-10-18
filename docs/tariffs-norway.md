[Home](../README.md) · [Overview](overview.md) · [Control logic](control-logic.md) · **Tariffs** · [Dashboard](dashboard.md) · [Device & driver](device-driver.md) · [Backup](backup-restore.md) · [Agent (MCP)](agent-mcp.md) · [Development](development.md) · [Limitations](limitations.md)

# Grid tariffs in Norway

> Bill structure, nettleie, kapasitetsledd, why hourly peaks matter

**On this page:**

- [Pricing model in Norway](#pricing-model-in-norway)
- [Typical electricity bill structure in Norway](#typical-electricity-bill-structure-in-norway)
  - [A. Power supplier cost](#a-power-supplier-cost)
  - [B. Network tariff (nettleie)](#b-network-tariff-nettleie)
- [Why hourly power matters](#why-hourly-power-matters)
- [Project assumption: Elvenett-style capacity logic](#project-assumption-elvenett-style-capacity-logic)
- [Capacity-step risk](#capacity-step-risk)
- [Hourly visibility model used by this controller](#hourly-visibility-model-used-by-this-controller)
- [Practical Norwegian interpretation](#practical-norwegian-interpretation)

## Pricing model in Norway

This section explains the pricing model relevant to why this controller exists.

Exact tariffs vary by:

- network company
- electricity supplier
- municipality
- taxes and government changes over time

This README therefore focuses on the structure of Norwegian pricing and on the project assumptions used in the controller.

## Typical electricity bill structure in Norway

A Norwegian electricity bill usually has two major commercial parts:

### A. Power supplier cost

This is what you pay the electricity supplier for the energy itself.

Typical components:

- Nord Pool spot price by hour
- supplier markup
- fixed monthly fee, if applicable
- VAT, where applicable

This part is energy-based, so it depends on `kWh` consumed in each hour.

### B. Network tariff (`nettleie`)

This is what you pay the local grid company.

Typical components:

- energy charge (`øre/kWh`)
- capacity charge (`kapasitetsledd`)
- public fees and taxes
- fixed elements, depending on tariff design

For many households, the network tariff is strongly affected by the highest hourly peaks during the month.

## Why hourly power matters

In Norway, the network tariff for households increasingly depends on hourly peak behavior.

That means:

- a short period of high power can be more expensive than the same energy spread over time
- the bill is influenced not only by total `kWh`, but also by the shape of consumption
- battery charging is a common cause of artificial hourly peaks

This repository therefore aims to flatten imported power by controlling charging intensity.

## Project assumption: Elvenett-style capacity logic

This project was tuned around an Elvenett interpretation discussed during development:

- daytime practical raw target around `1.98 kW`
- night hours may be weighted lower for capacity purposes
- the user specifically optimized around a night factor of `0.7`

That implies the following reasoning:

- daytime raw `1.98 kW` stays close to the desired practical cap
- night raw import can be somewhat higher without causing the same effective capacity burden
- a practical night target of about `2.85 kW` is acceptable for this system design

Example project math:

- `2.85 kW raw * 0.7 = 1.995 kW effective`

This is why the repository uses in summer (tier 1):

- day base setpoint: `1950 W`
- night base setpoint: `2850 W`

and in winter (tier 2, `6.44 kW raw * 0.7 = 4.51 kW effective`):

- day base setpoint: `4950 W`
- night base setpoint: `6440 W`

## Capacity-step risk

A key operational idea is that the bill is often driven by a few bad hours, not by average behavior.

Risk pattern:

- battery charging starts too hard
- total house load is already elevated
- the hour ends with a high raw import peak
- the month is pushed into a higher capacity step

The controller reduces that risk by:

- lowering charging when the battery is already sufficiently charged
- displaying how much import has already been used earlier in the same hour
- allowing more relaxed behavior at night

## Hourly visibility model used by this controller

The controller keeps an hourly energy visibility approximation for status and tuning.

For each clock hour:

- `E_budget_Wh = target_power_W * 1h`
- `E_used_Wh` is accumulated from live GRID CT power
- `E_left_Wh = max(0, E_budget_Wh - E_used_Wh)`
- allowed average power for the rest of the hour is recalculated from the remaining time

Conceptually:

```text
E_budget_Wh = P_limit * 1h
E_left_Wh   = max(0, E_budget_Wh - E_used_Wh)
P_allow_W   = E_left_Wh / t_left_h
```

This is currently shown for operator awareness only. It does not directly tighten the controller outputs.

## Practical Norwegian interpretation

This project should be understood as a control strategy for Norwegian household electricity economics, not just a charging script.

It tries to optimize three things at once:

1. maintain usable battery state-of-charge
2. avoid unnecessary raw hourly peaks during the day
3. exploit more favorable night conditions when available

In practice, that means the system behaves like a soft peak-shaving battery charger.

---

← [Control logic](control-logic.md) | [Dashboard](dashboard.md) →
