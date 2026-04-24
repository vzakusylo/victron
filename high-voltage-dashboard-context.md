# High-Voltage Protection Dashboard Context

## Purpose

This file is a focused implementation handoff for adding a new Node-RED Dashboard tab that configures high-voltage protection settings, persists them to a file, and reloads them on startup and dashboard connect.

It is intended for future implementation work in:

- `day-night.txt`
- `flows.json`
- Node-RED Dashboard nodes
- file-backed runtime configuration

This file does not implement the feature. It captures the current state, the required corrections, the proposed UI, the runtime data flow, and the implementation task list.

---

## 1. Feature Goal

Add a new dashboard tab that lets the user configure the high-voltage protection thresholds used by the controller:

- `HIGH_VOLTAGE_LIMIT_START`
- `HIGH_VOLTAGE_LIMIT_RELEASE`
- `HIGH_VOLTAGE_LIMIT_FULL`

The dashboard must:

- show the current saved settings
- allow the user to modify them with UI controls
- save them to a persistent file
- reload them from that file on startup
- reload them when the dashboard connects or refreshes
- make the controller use the persisted values instead of fixed hard-coded constants

---

## 2. Current State

### 2.1 Current high-voltage logic

The controller currently uses hard-coded constants in the main function source.

Current values in `day-night.txt`:

- `HIGH_VOLTAGE_LIMIT_START = 55.4`
- `HIGH_VOLTAGE_LIMIT_RELEASE = 55.2`
- `HIGH_VOLTAGE_LIMIT_FULL = 55.6`

These values currently control the grid-setpoint limiter behavior:

- limiter starts above `55.4 V`
- limiter releases at `55.2 V` or lower
- taper reaches the minimum grid setpoint by `55.6 V`

The relevant logic is in the high-voltage limiter section of the controller.

### 2.2 Current morning-solar rule

The controller now also contains a separate morning rule:

- `morningSolarChargeHold = solarForecast.valid && forecastRestoreAh > 0 && batteryVoltage > 54.5`

That rule is not the same thing as the high-voltage protection thresholds.

Important design distinction:

- the dashboard requested here is for high-voltage protection settings
- the morning solar hold threshold is currently a separate operational rule

Recommendation:

- do not mix the morning solar hold threshold into the first version of this dashboard
- keep it as a separate future setting unless the user explicitly wants a fourth configurable value

### 2.3 Current dashboard structure

The current `flows.json` already contains dashboard tabs:

- `Energy`
- `Energy Detail`
- `Analytics`

There are already `ui_tab`, `ui_group`, `ui_template`, and dashboard refresh/connect patterns in the flow.

This means the new feature should extend the existing dashboard rather than create a parallel design style.

### 2.4 Current file-write patterns in the flow

The current flow already writes files under:

- `/data/home/nodered/grid-control-logs/...`

It uses Node-RED `file` nodes with:

- `msg.filename`
- `createDir: true`
- `encoding: utf8`

This is a good existing pattern to reuse for configuration persistence.

### 2.5 Current mismatch risk

The repository keeps two controller representations:

- `day-night.txt` as the readable controller source
- `flows.json` as the deployed Node-RED export

The project has already experienced drift between these two files.

This feature must be implemented in a way that minimizes future drift. Runtime settings should come from a dedicated config file, not from repeatedly editing threshold constants in two different code copies.

---

## 3. Main Correction Required

The current controller treats high-voltage settings as code constants.

That is the root design problem for dashboard configurability.

To support a dashboard settings tab correctly, the high-voltage thresholds must move from:

- hard-coded source constants

to:

- runtime-loaded configuration values with fallback defaults

### Required correction

The controller should:

1. define code defaults for safety
2. load persisted settings from a JSON file into flow context
3. validate them before use
4. use runtime values from flow context in the limiter logic
5. fall back to defaults if the file is missing or invalid

This is a safer and more maintainable architecture than trying to edit code constants from the dashboard.

---

## 4. Recommended Runtime Configuration Design

### 4.1 File path

Recommended config path:

- `/data/home/nodered/grid-control-config/high-voltage-settings.json`

Reasons:

- separate from logs
- clearly owned by Node-RED
- stable and explicit
- easy to back up and inspect

### 4.2 File format

Recommended JSON structure:

```json
{
  "start": 55.4,
  "release": 55.2,
  "full": 55.6,
  "updatedAt": "2026-04-24T12:00:00.000Z",
  "source": "dashboard"
}
```

Recommended behavior:

- only `start`, `release`, and `full` are used by the controller
- `updatedAt` and `source` are for observability and debugging

### 4.3 Flow context object

Recommended in-memory structure:

```js
flow.set("highVoltageSettings", {
    start: 55.4,
    release: 55.2,
    full: 55.6,
    updatedAt: "...",
    source: "file"
});
```

### 4.4 Fallback defaults

The controller should still contain fallback defaults in code.

Recommended fallback object:

```js
const DEFAULT_HIGH_VOLTAGE_SETTINGS = {
    start: 55.4,
    release: 55.2,
    full: 55.6
};
```

The live limiter should then read something like:

```js
const hvSettings = flow.get("highVoltageSettings") || DEFAULT_HIGH_VOLTAGE_SETTINGS;
```

This keeps the controller safe if the file fails to load.

---

## 5. Startup and Load Behavior

### 5.1 On Node-RED startup or deploy

Add a startup path:

1. `inject` node configured with `once: true`
2. `file in` node reading the JSON file
3. function node to parse and validate settings
4. function node to store validated settings into `flow.highVoltageSettings`
5. optional status notification

### 5.2 If the file does not exist

The startup flow should:

- use fallback defaults
- store them in flow context
- optionally create the JSON file automatically

Recommended behavior for first version:

- load defaults into flow context
- write the default file once if missing

This avoids a state where the dashboard shows nothing.

### 5.3 On dashboard connect

When the dashboard opens, current saved values must populate the UI controls.

Use one of these patterns:

- `ui_control` connect event
- a refresh inject wired to the dashboard state builder

Recommended behavior:

- read `flow.highVoltageSettings`
- emit the current values to the widgets
- display source and last updated time

---

## 6. Save Behavior

When the user changes settings and presses save:

1. collect the UI values
2. validate them
3. write them into `flow.highVoltageSettings`
4. serialize them as JSON
5. write the JSON file
6. emit a notification or status message
7. optionally push the saved values back into the UI

Recommended save semantics:

- do not auto-save on every slider move
- require an explicit `Save` button

Reason:

- prevents accidental writes while dragging
- makes validation and confirmation easier
- reduces unnecessary file churn

---

## 7. Validation Rules

These rules should be enforced before saving and before using file data.

### Required validation

1. all values must be finite numbers
2. `full > start`
3. `start >= release`
4. values must remain inside a safe range

Recommended safe range:

- minimum `50.0`
- maximum `60.0`

### Recommended user-facing validation messages

- `Full voltage must be greater than start voltage`
- `Release voltage must not be higher than start voltage`
- `Value outside allowed range`
- `Invalid config file, defaults loaded`

### Invalid file behavior

If the file is invalid:

- do not apply invalid values
- use defaults
- show source as `fallback`
- raise a visible status message

---

## 8. Proposed Dashboard UI

### 8.1 New tab name

Recommended new tab:

- `Protection`

Alternative:

- `Battery Protection`

`Protection` is shorter and fits well with current tab naming.

### 8.2 Groups

Recommended groups:

1. `High Voltage Protection`
2. `Actions`
3. `Status`

### 8.3 Controls

Recommended controls for first version:

1. slider for `Start Voltage`
2. slider for `Release Voltage`
3. slider for `Full Limit Voltage`
4. live numeric text beside each slider
5. `Save` button
6. `Reload from File` button
7. `Reset to Defaults` button
8. status text card

### 8.4 Recommended slider ranges

#### Start Voltage

- range: `53.0` to `56.5`
- step: `0.1`

#### Release Voltage

- range: `52.5` to `56.0`
- step: `0.1`

#### Full Limit Voltage

- range: `53.5` to `57.0`
- step: `0.1`

These ranges are narrow enough to discourage bad input but broad enough for tuning.

### 8.5 Recommended status card fields

Display:

- active start voltage
- active release voltage
- active full voltage
- source: `file`, `fallback`, or `dashboard`
- last saved timestamp
- validation result
- config file path

---

## 9. Proposed UX Behavior

### 9.1 On first open

The tab should show:

- the saved file values if present
- otherwise the fallback defaults

### 9.2 While adjusting sliders

The user should see live values, but the controller should not change yet.

### 9.3 On save

The user should see:

- `Settings saved`
- timestamp
- maybe a short notification message

### 9.4 On invalid input

The save should be blocked.

The UI should keep the entered values visible, plus an error message.

### 9.5 On reload from file

The widgets should snap back to the persisted values.

### 9.6 On reset to defaults

The UI should restore default values locally.

Recommended behavior:

- reset does not persist automatically
- user must press `Save`

---

## 10. Controller Changes Required

The main controller must be refactored so the limiter does not depend on the hard-coded constants directly.

### Current limiter logic shape

The limiter currently references:

- `HIGH_VOLTAGE_LIMIT_START`
- `HIGH_VOLTAGE_LIMIT_RELEASE`
- `HIGH_VOLTAGE_LIMIT_FULL`

### Required refactor

Replace that direct dependency with runtime settings:

```js
const hvSettings = flow.get("highVoltageSettings") || DEFAULT_HIGH_VOLTAGE_SETTINGS;
const highVoltageLimitStart = Number(hvSettings.start);
const highVoltageLimitRelease = Number(hvSettings.release);
const highVoltageLimitFull = Number(hvSettings.full);
```

Then use those runtime values throughout the limiter and trace output.

### Also update trace payload

The `controller-trace` payload should include the active high-voltage settings so diagnostics show which values are live.

Recommended extra trace fields:

```js
highVoltageSettings: {
    start: highVoltageLimitStart,
    release: highVoltageLimitRelease,
    full: highVoltageLimitFull,
    source: hvSettings.source || "unknown"
}
```

---

## 11. Proposed Node-RED Flow Pieces

This is the recommended building-block list, not exact JSON yet.

### A. Startup load flow

- inject once on start
- function `Build HV config filename`
- file in `Read HV config`
- function `Parse and validate HV config`
- function `Store HV settings`
- optional debug/status output

### B. Dashboard input flow

- new `ui_tab`
- new `ui_group`
- three `ui_slider` nodes
- three `ui_text` or `ui_template` value displays
- `ui_button` save
- `ui_button` reload
- `ui_button` reset

### C. Save flow

- function `Collect and validate dashboard HV settings`
- function `Serialize HV config JSON`
- file node `Write HV config`
- function `Store HV settings in flow`
- notification/status output

### D. Dashboard state refresh flow

- `ui_control` connect event or inject refresh
- function `Build HV dashboard state`
- outputs to sliders/text widgets

---

## 12. Detailed Task List

### Phase 1 - File-backed runtime settings

1. Add a config file path constant for high-voltage settings.
2. Add startup flow nodes to read the JSON file.
3. Add parser/validator logic for persisted settings.
4. Store validated settings in `flow.highVoltageSettings`.
5. Auto-fallback to defaults when file is missing or invalid.
6. Optionally write the default file when no file exists.

### Phase 2 - Controller refactor

7. Refactor `day-night.txt` to use runtime high-voltage settings instead of fixed constants.
8. Mirror the same change into the embedded function in `flows.json`.
9. Update trace payload to expose active settings and source.
10. Keep fallback defaults in code for safe startup behavior.

### Phase 3 - Dashboard UI

11. Add a new dashboard tab named `Protection`.
12. Add groups for settings, actions, and status.
13. Add three sliders with live displayed numeric values.
14. Add save, reload, and reset buttons.
15. Add a status panel showing source, last saved time, and active values.

### Phase 4 - Save and reload flows

16. Build save validation logic.
17. Serialize settings to JSON.
18. Write settings to `/data/home/nodered/grid-control-config/high-voltage-settings.json`.
19. Reload and repopulate dashboard values on connect.
20. Show save success or error notifications.

### Phase 5 - Validation and tests

21. Test startup with no config file.
22. Test startup with valid config file.
23. Test startup with corrupted config file.
24. Test save and immediate controller use of new values.
25. Test browser reconnect and slider repopulation.
26. Test invalid ordering such as `release > start`.

---

## 13. Risks and Edge Cases

### Risk 1 - Drift between code and deployed flow

Any controller logic change must be applied to both `day-night.txt` and `flows.json`.

Mitigation:

- treat `day-night.txt` as the readable source while editing
- immediately mirror the exact logic into `flows.json`
- validate after each change

### Risk 2 - Corrupted or missing config file

If the JSON file is malformed, the controller must not break.

Mitigation:

- strict validation
- safe defaults
- visible fallback status

### Risk 3 - Slider-only input can be imprecise

Sliders are good operationally but can be awkward for exact values.

Mitigation:

- keep `0.1 V` step size
- show the exact numeric value beside each slider

Optional future enhancement:

- add numeric input fields next to sliders

### Risk 4 - Confusing high-voltage settings with morning solar hold

These are separate behaviors.

Mitigation:

- keep the first version limited to the three high-voltage thresholds
- consider a separate dashboard section later for morning charging rules

### Risk 5 - Invalid threshold ordering causing unstable limiter behavior

Mitigation:

- block save if `start < release`
- block save if `full <= start`

---

## 14. Recommended First Implementation Scope

The safest first scope is:

- add one new dashboard tab
- configure only `start`, `release`, and `full`
- persist to one JSON file
- load on startup
- repopulate on dashboard connect
- keep the morning solar hold rule unchanged

This keeps the work bounded and avoids mixing multiple policy settings into one first pass.

---

## 15. Recommended Future Enhancements

After the first version is stable, consider:

1. adding numeric input boxes beside sliders
2. adding a fourth setting for the morning solar hold threshold
3. adding a small preview card showing when the limiter would become active
4. logging threshold changes to a dedicated config-change log
5. exposing active high-voltage settings in the analytics dashboard diagnostics panel

---

## 16. Implementation Notes for the Next Coding Session

When implementing this feature, start in this order:

1. add file-backed startup load flow
2. refactor controller to use runtime settings
3. add the new dashboard tab and controls
4. add save/reload/reset flows
5. validate startup, save, and reconnect behavior

Do not start with the dashboard widgets first. Without runtime file-backed settings, the UI would only edit temporary values and would not solve persistence correctly.