# Dashboard Context and Implementation Plan

## Purpose

This file captures, in detailed English, what the reference dashboard screen is showing and how a similar dashboard can be implemented in this Victron Cerbo GX / Node-RED project.

It is intended as a future-programming context file for VS Code work on:

- Node-RED Dashboard design
- forecast vs actual energy analytics
- per-hour grid / AC / solar statistics
- daily KPI cards and routing breakdowns
- battery and grid energy movement visualizations

---

## 1. What Is Visible on the Reference Screen

The screen is a Node-RED Dashboard style energy-analysis page.

The title bar reads:

- `FC, Verbrauch & Solar`

This is German and roughly means:

- `Forecast, Consumption & Solar`

The dashboard is organized as a daily energy analytics page with:

- one KPI-heavy statistics panel on the left
- multiple forecast-vs-real charts on the right
- separate visualizations for solar, consumption, surplus, and battery-energy routing

The purpose of the screen is not just to show current values. It is a validation and analysis dashboard that compares:

- forecasted values versus actual values
- total daily energy versus time-distributed energy
- solar production versus site consumption
- routing of energy between PV, battery, grid, and load

---

## 2. Translation of the Main Labels

The screen contains several German labels. Their English meanings are:

- `Tagesstatistik` = Daily statistics
- `Visualisierung Forcast` = Forecast visualization
- `Prognose/Real` = Forecast / Actual
- `Solar FC / Real` = Solar forecast / actual
- `Verbrauch FC / Real` = Consumption forecast / actual
- `Überschuss FC / Real` = Surplus forecast / actual
- `Akkubewegungen in kWh` = Battery movements in kWh
- `Solarertrag` = Solar yield / solar production
- `Verbrauch` = Consumption
- `Solarüberschuss` = Solar surplus / excess solar
- `Direktverbrauch` = Direct self-consumption
- `zu Akku` = To battery
- `zu Grid` = To grid
- `heute` = Today

`FC` should be interpreted as `Forecast`.

---

## 3. Structural Analysis of the Screen

The dashboard can be divided into six logical blocks.

### Block A — Left-side daily KPI panel

This is the most information-dense panel. It contains totals, progress bars, and routing breakdowns.

It is designed to answer:

- What was forecast for today?
- What has actually happened so far today?
- How was solar energy distributed?
- How much came from grid?
- What did it cost?

### Block B — Forecast battery-movement chart

This panel visualizes how forecasted energy is expected to move between:

- PV and battery
- battery and load
- grid and battery
- battery and grid

It is intended to show expected storage behavior over time.

### Block C — Combined forecast-vs-real chart for today

This panel overlays forecast and actual values for the current day.

It helps answer:

- Was the forecast shape correct?
- Was actual demand lower or higher than expected?
- Was solar delivered when expected?

### Block D — Solar-only forecast-vs-real chart

This isolates the solar component.

It helps distinguish:

- forecast total-energy accuracy
- forecast timing-shape accuracy

### Block E — Consumption-only forecast-vs-real chart

This isolates load behavior.

It helps verify whether consumption forecasting is too smooth, too high, or too low.

### Block F — Surplus-only forecast-vs-real chart

This shows how much excess solar was expected compared with what actually happened.

This is one of the most important operational charts because surplus is strongly influenced by both:

- solar forecast accuracy
- load forecast accuracy

---

## 4. Detailed Meaning of the Daily Statistics Panel

The left panel in the screenshot contains these values.

### `FC Solarertrag 44.58 kWh`

Meaning:

- Forecasted total solar energy for the day.

Interpretation:

- The forecast model expects about 44.58 kWh of PV production.

### `FC Verbrauch 152.34 kWh`

Meaning:

- Forecasted total energy consumption for the day.

Interpretation:

- Daily load is expected to be much larger than daily solar production.

### `FC Solarüberschuss 6.79 kWh`

Meaning:

- Forecasted solar surplus for the day.

Interpretation:

- The model expects only a small amount of true excess solar after local use and charging.

### `Solarertrag heute 38.10 kWh`

Meaning:

- Actual solar energy produced today so far.

Interpretation:

- Actual solar is already close to the forecast total.

### `Verbrauch heute 64.44 kWh`

Meaning:

- Actual site consumption today so far.

Interpretation:

- Actual demand is much lower than the forecasted daily total at the time of capture.

### `Solarüberschuss heute 32.30`

Meaning:

- Actual solar surplus today.

Interpretation:

- Actual surplus is far larger than forecast surplus, which implies that reality was more export-prone or less consumption-heavy than the forecast expected.

### `Solar Direktverbrauch 4.70`

Meaning:

- Solar energy consumed directly by loads without first going through storage.

### `Solar zu Akku 20.55`

Meaning:

- Solar energy routed into battery charging.

### `Solar zu Grid 12.85`

Meaning:

- Solar energy exported to grid.

### `Grid Direktverbrauch 59.34`

Meaning:

- Grid energy consumed directly by the loads.

### `Grid zu Akku 1.06`

Meaning:

- Grid energy used to charge the battery.

### `Tageskosten Einkauf&Akkuladen 0.22 CHF (0.2075 CHF/kWh)`

Meaning:

- Daily purchase cost for imported energy and battery charging.

Interpretation:

- The dashboard includes tariff/cost-aware reporting, not just power and energy quantities.

---

## 5. Internal Consistency That Can Be Inferred From the Screen

The screenshot values strongly suggest that the dashboard is calculating real energy-flow balances.

Example solar-side balance:

- Solar direct use = 4.70 kWh
- Solar to battery = 20.55 kWh
- Solar to grid = 12.85 kWh

Sum:

$$
4.70 + 20.55 + 12.85 = 38.10\ \text{kWh}
$$

That matches:

- `Solarertrag heute = 38.10 kWh`

This implies the dashboard is not just showing unrelated indicators. It is decomposing solar yield into destination categories.

It likely uses energy-balance logic such as:

- PV direct to load
- PV to battery
- PV export
- grid direct to load
- grid to battery
- battery to load
- possibly battery to grid

This is important because a similar dashboard in this repo will need explicit energy-routing calculations, not just raw power charts.

---

## 6. What the Charts Are Telling the Operator

### Battery movement chart

The `Akkubewegungen in kWh` chart appears to describe forecasted energy transfer between battery, PV, grid, and load.

Operational role:

- shows when storage is expected to charge or discharge
- reveals whether the battery is used mainly for self-consumption or for export shaping

### Combined forecast-vs-real chart

The `Prognose/Real heute` panel compares forecast and actual series together.

Operational role:

- validates the overall planning model
- shows whether total daily forecast is correct
- shows whether the hourly shape is wrong even if daily total is acceptable

### Solar-only chart

The `Solarertrag FC / Real` chart reveals if solar forecast timing differs from reality.

Operational role:

- useful for charge scheduling
- useful for deciding when forecast should reduce night or morning grid charging

### Consumption-only chart

The `Verbrauch FC / Real` chart isolates load forecast quality.

Operational role:

- shows whether the demand forecast is too flat, too high, or shifted in time

### Surplus-only chart

The `Überschuss FC / Real` chart shows the most economically relevant error.

Operational role:

- tells whether export/self-consumption assumptions were correct
- exposes combined forecast mismatch from both solar and load models

---

## 7. What This Reference Dashboard Would Mean for This Victron Project

The current repo already has a basic dashboard slice in `flows.json`.

Current dashboard scope already implemented:

- per-hour Grid `Wh`
- per-hour AC load `Wh`
- live current-hour Grid and AC partial totals
- table of hourly Grid / AC values
- simple duplicated dashboard tabs for overview and detail

Current flow data already available:

- `dailySummary`
  - stores completed hourly Grid `Wh` and AC `Wh`
- `dashboardLiveHour`
  - stores partial current-hour Grid `Wh`, AC `Wh`, Grid `W`, AC `W`
- `solarForecastToday`
  - adjusted solar forecast summary for today
- `solarForecastAdjusted`
  - richer solar forecast detail object
- `controller-trace`
  - live controller state with hourly budget values and forecast fields

Current flow data not yet implemented for a reference-style energy-routing dashboard:

- PV direct to load energy
- PV to battery energy
- PV to grid/export energy
- grid to load energy as a day-total series
- grid to battery energy as a day-total series
- battery to load energy
- battery to grid energy
- forecasted per-hour load series for the whole day
- forecasted per-hour solar series for the whole day in dashboard-ready form
- per-hour actual solar production series from Victron services
- daily cost model based on actual import windows and tariff rules

This means the current project can already support a simpler hourly Grid/AC dashboard, but it cannot yet reproduce the full reference screen.

---

## 8. Gap Analysis: Reference Screen vs Current Repo

### Already possible with current data

- hourly Grid bar chart
- hourly AC load bar chart
- live current-hour Grid/AC widgets
- daily hourly table
- simple solar forecast total KPI

### Partially possible with current data

- forecast vs actual comparison for solar totals
- controller diagnostics panel
- current-hour efficiency indicators

### Not possible yet without new data model work

- full left-side KPI card set from the screenshot
- battery movement chart in kWh
- PV routing breakdown
- full forecast vs actual charts for load, solar, and surplus across the day
- cost panel with tariff-aware daily economics

---

## 9. Recommended Dashboard Design for This Repo

To build a dashboard similar to the reference screen, but grounded in the actual data available in this repo, the dashboard should eventually have these sections.

### Section A — Daily KPI cards

Suggested cards:

- Forecast solar today (kWh)
- Actual solar today (kWh)
- Forecast load today (kWh)
- Actual load today (kWh)
- Grid import today (kWh)
- AC consumption today (kWh)
- Surplus today (kWh)
- Grid-charged battery today (kWh)
- Solar-charged battery today (kWh)
- Daily import cost

### Section B — Forecast vs actual charts

Suggested charts:

- Solar forecast vs actual
- Load forecast vs actual
- Surplus forecast vs actual
- Combined forecast vs actual

### Section C — Energy-routing charts

Suggested charts:

- PV to load / battery / grid
- Grid to load / battery
- Battery to load / grid

### Section D — Hourly operations table

Suggested columns:

- Hour
- Grid Wh
- AC Wh
- Solar Wh
- Battery charge Wh
- Battery discharge Wh
- Surplus Wh
- Forecast solar Wh
- Forecast load Wh
- State (`done` or `live`)

### Section E — Controller diagnostics

Suggested widgets:

- active window
- grid setpoint
- charge current limit
- battery consumed Ah deficit
- forecast solar Ah offset
- voltage-limit active flag

---

## 10. Detailed Implementation Tasks

The tasks below are organized in the order that will produce a usable dashboard fastest while keeping the data model coherent.

### Phase 1 — Stabilize the current hourly dashboard

- [ ] **D1. Verify the existing dashboard tab works on the Cerbo runtime**
  - Confirm the Dashboard package is installed and active.
  - Open `/ui` and verify the `Energy` and `Energy Detail` tabs render.
  - Confirm the chart, table, summary text, and live text all update.

- [ ] **D2. Confirm `dashboardLiveHour` refreshes continuously**
  - Watch `DBG controller trace`.
  - Confirm `hourBudget.usedWh`, `acLoadBudget.usedWh`, `storedGridPowerW`, and `storedAcLoadPowerW` change over time.
  - Confirm the live dashboard row changes without waiting for an hour rollover.

- [ ] **D3. Confirm `dailySummary` persists completed hours correctly**
  - Trigger at least one real hour rollover.
  - Verify the row moves from live to completed.
  - Verify no duplicate completed rows for the same hour.

- [ ] **D4. Improve dashboard labels from internal naming to user-facing wording**
  - Rename widgets to clear operator language.
  - Standardize on English or bilingual labels.
  - Remove debug-style wording from end-user widgets.

### Phase 2 — Build a richer daily energy model

- [ ] **D5. Define a daily analytics state object in flow context**
  - Create a new `flow.dailyEnergyModel` or similar.
  - Store a single structured object per day.
  - Include hourly buckets and daily totals.

- [ ] **D6. Extend hourly aggregation beyond Grid and AC**
  - Add hourly series for any available solar production source from Victron.
  - Add hourly series for battery charge/discharge if available from Victron services.
  - Store these alongside existing Grid and AC hourly buckets.

- [ ] **D7. Add solar actuals capture from Victron inputs**
  - Identify the correct D-Bus paths for PV production or inverter AC output.
  - Create source nodes for those paths.
  - Integrate them with the hourly aggregation pattern already used for Grid and AC.

- [ ] **D8. Add battery charge/discharge actuals capture**
  - Identify a robust battery power source or battery current/voltage pair.
  - Distinguish charging vs discharging.
  - Integrate positive and negative energy separately into hourly totals.

### Phase 3 — Add forecast series, not only forecast totals

- [ ] **D9. Create a normalized per-hour solar forecast series**
  - Reuse `solarForecastAdjusted`.
  - Convert it into hourly buckets for the current day.
  - Store a dashboard-ready series in flow context.

- [ ] **D10. Define a load forecast model**
  - Decide whether load forecast is:
    - static schedule-based,
    - rolling average,
    - manual target profile,
    - or imported from an external source.
  - Store it as a 24-hour series.

- [ ] **D11. Add forecast surplus calculation**
  - For each hour compute:

$$
\text{forecastSurplusWh} = \max(0, \text{forecastSolarWh} - \text{forecastLoadWh})
$$

  - Store daily total and per-hour values.

- [ ] **D12. Add actual surplus calculation**
  - For each hour compute actual surplus using measured series.
  - Keep the same bucket boundaries as forecast series so comparison charts line up.

### Phase 4 — Implement the reference-style KPI panel

- [ ] **D13. Create a dashboard data-preparation function for left-column KPI cards**
  - This function should emit all top-level KPIs in one structured message.
  - Include daily totals, forecasts, and routing categories.

- [ ] **D14. Decide widget strategy for KPI cards**
  - Option A: `ui_text` widgets plus custom HTML formatting.
  - Option B: `ui_template` for a full card-column layout.
  - Option C: progress bars if a stable dashboard widget exists on the device.

- [ ] **D15. Implement cards for the metrics already available**
  - Forecast solar today
  - Actual solar today
  - Actual Grid today
  - Actual AC today
  - Current live-hour Grid and AC

- [ ] **D16. Implement placeholder cards for metrics not yet computed**
  - PV direct use
  - PV to battery
  - PV to grid
  - grid to battery
  - battery to load
  - battery to grid
  - daily cost
  - Render them as `N/A` or `pending metric` until real calculations exist.

### Phase 5 — Implement the forecast-vs-real charts

- [ ] **D17. Create a unified chart-model builder node**
  - Build all dashboard chart payloads from one function.
  - Use one internal daily model to avoid divergent calculations.

- [ ] **D18. Implement `Solar FC / Real` chart**
  - Series 1: forecast solar by hour
  - Series 2: actual solar by hour

- [ ] **D19. Implement `Consumption FC / Real` chart**
  - Series 1: forecast load by hour
  - Series 2: actual load by hour

- [ ] **D20. Implement `Surplus FC / Real` chart**
  - Series 1: forecast surplus by hour
  - Series 2: actual surplus by hour

- [ ] **D21. Implement `Forecast / Real today` combined overlay chart**
  - Include all major forecast and actual series in a single comparison view.
  - Keep labels readable and limit series count if rendering becomes noisy.

### Phase 6 — Implement energy-routing analytics

- [ ] **D22. Define routing equations carefully**
  - Avoid double-counting.
  - Write down exact formulas for:
    - PV direct to load
    - PV to battery
    - PV to grid
    - grid direct to load
    - grid to battery
    - battery to load
    - battery to grid

- [ ] **D23. Choose data sources for routing calculations**
  - Verify which Victron measurements are available and trustworthy.
  - Prefer directly measured D-Bus paths over inferred values when possible.

- [ ] **D24. Create a daily routing accumulator**
  - Store both hourly and total routing values.
  - Reset daily at midnight.
  - Preserve enough data to rebuild charts after refresh.

- [ ] **D25. Implement the battery movement chart**
  - Reproduce the reference idea using hourly kWh series.
  - Include only series that are actually measurable and useful.

### Phase 7 — Add tariff and cost analytics

- [ ] **D26. Define the tariff model explicitly**
  - Clarify import tariff source and units.
  - Decide whether night reduction is shown as billing metric only or also as daily energy cost logic.

- [ ] **D27. Compute daily import cost from hourly buckets**
  - Multiply hourly import energy by the tariff valid in that hour.
  - Sum daily total.

- [ ] **D28. If relevant, separate cost of direct load import vs battery charging import**
  - Show grid direct consumption cost separately from grid-to-battery cost.

### Phase 8 — Make the dashboard robust and operator-friendly

- [ ] **D29. Ensure all dashboard widgets repopulate on refresh**
  - Keep using `ui_ui_control` connect events.
  - Rebuild all widgets from flow context on browser connect.

- [ ] **D30. Add explicit `data freshness` indicators**
  - Show last update time for:
    - solar forecast
    - hourly stats
    - controller trace
    - daily totals

- [ ] **D31. Add empty-state handling**
  - If there is no data yet today, show meaningful placeholders instead of blank widgets.

- [ ] **D32. Keep the overview tab compact and detail tab analytical**
  - `Energy` tab: operator summary
  - `Energy Detail` tab: full charts and tables

- [ ] **D33. Add documentation for every derived metric**
  - Update README or a dedicated dashboard doc.
  - Define each metric, formula, unit, and data source.

---

## 11. Suggested File and Node Organization

To keep future work maintainable, the dashboard should be implemented with a clear separation of concerns.

Recommended pattern:

- raw measurement inputs
- hourly aggregators
- daily model builder
- forecast model builder
- routing model builder
- dashboard view-model builder
- dashboard widgets

Suggested new context/state names:

- `flow.dailyEnergyModel`
- `flow.dailyRoutingModel`
- `flow.dashboardViewModel`
- `flow.hourlyForecastSolar`
- `flow.hourlyForecastLoad`
- `flow.hourlyActualSolar`
- `flow.hourlyActualLoad`

This is cleaner than encoding every dashboard calculation inside widget-specific function nodes.

---

## 12. Recommended First Practical Implementation Order

If only the highest-value next steps are chosen, the order should be:

1. Make the existing hourly Grid/AC dashboard stable.
2. Add hourly actual solar series.
3. Build hourly forecast solar series from `solarForecastAdjusted`.
4. Add a left KPI panel with the metrics already available.
5. Add `Solar FC / Real` chart.
6. Add `Consumption FC / Real` chart once a load forecast exists.
7. Add surplus and routing analytics only after the data model is trustworthy.

---

## 13. Important Implementation Warning

The reference screenshot is a much richer analytics dashboard than the current repo data model supports.

It should **not** be copied visually first and filled with invented numbers.

Correct approach:

- first define the energy model
- then define the formulas
- then store the derived values in flow context
- then render the widgets

If the UI is built before the calculations are stable, the dashboard will look complete but will be misleading.

---

## 14. Summary

The reference dashboard is best understood as a daily energy-analysis board that combines:

- forecast totals
- actual totals
- forecast vs actual time-series comparisons
- battery movement visualization
- solar/load/surplus comparison charts
- routing breakdowns between PV, battery, grid, and load
- cost reporting

The current Victron project already has enough data for a basic hourly Grid/AC dashboard, but it does not yet have enough routing and forecast-series data to fully reproduce the reference dashboard.

The task list in this file is therefore focused on building the underlying data model first, then using that model to implement a trustworthy dashboard.