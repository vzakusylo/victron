# Accumulator tank sensor: diagnosis and recovery

Date: 2026-11-14. Documentation-only handoff for [PR #28](https://github.com/vzakusylo/victron/pull/28).

## Outcome

**Accumulator tank temp resumed local reporting after the owner replaced its battery.**
No code, GX configuration, local keys, router settings or Node-RED flows were changed
by this investigation. The only repository change for this handoff is this document.

| Identity | Value |
|---|---|
| Smart Life name | Accumulator tank temp |
| Role | `acc` |
| Tuya device ID | `bfe0dd97b76a98f454a8bt` |
| MAC | `d8:d6:68:60:91:4c` |
| IP in the recovered reading | `192.168.1.49` (observed, not a reserved address) |
| Protocol in the recovered reading | `3.4` |

## Read-only diagnosis before battery replacement

- Existing project history recorded the sensor as offline in the Tuya cloud since
  **2026-11-10 12:11 UTC**. The cloud continued returning its old **25.5 C** value.
  Cloud fallback was intentionally disabled in d#151 to stop presenting that value
  as fresh data; this session did not disable or re-enable it.
- SSH checks on the GX confirmed that `acc` remained configured in the local sensor
  reader. Configuration presence and key length were checked without printing keys.
- `tuya-local-sensors-last.json` had no entry for this device, while other battery
  sensors, including `plate`, had recent readings.
- The local reader process was running and UDP port 6667 was bound. The live flow
  checked during this diagnosis was **d#179**, with the local sensor wiring intact
  and `CLOUD_ENABLED = false` in `44 Heat pump cloud sensors.js`.
- The MAC was absent from the GX ARP table and ASUS DHCP leases. That alone does
  not prove a power failure: sleeping sensors can be absent from network tables.
  Power and Wi-Fi remained possible causes pending a physical check.

## Owner action and confirmed recovery

The owner subsequently reported replacing the battery. A read-only check at
**2026-11-14 16:05:54 UTC (17:05:54 Europe/Oslo)** found this local cached reading:

| Field | Value |
|---|---|
| Original reading time | **2026-11-14 16:04:13 UTC (17:04:13 Europe/Oslo)** |
| Age at the check | **101 seconds** |
| Temperature | **25.9 C** |
| Humidity | **32 %** |
| Battery state | **`high`** |
| Raw DPs | `{"1":259,"2":32,"3":"high"}` |

This confirms a new local reading, not reuse of the old cloud value. Recovery
after battery replacement supports a battery/power cause; battery voltage was
not measured and no independent hardware fault diagnosis was performed.

## Handoff and coordination

- `Motion sensor local`, `GitHub secrets setup` and `SSH Linux` were consulted.
  There were no conflicting GX changes from this investigation.
- The PR #28 owner agreed to a handoff-only commit on the existing PR branch.
  Merge, flow sync, secret reload, deploy and service restart are not required.
- Do not overwrite the live GX flow with an older tracked export. d#179 was the
  version observed during the initial check, not a claim about future live versions.
- Earlier stale `acc` values must not be treated as shower events or fresh
  temperature measurements in the separate PIR/DHW investigation.

If the sensor disappears again, inspect only its entry in
`/data/home/nodered/grid-control-config/tuya-local-sensors-last.json` and compare
the original `t` (Unix milliseconds) with the current time. A cached value is not
fresh just because it is printed again when the reader restarts. Check battery
contacts and Wi-Fi before re-pairing; re-pairing can change the local key.

Related sources: [local sensor reader](../tools/tuya-local-sensors.js),
[local sensor node](../46%20Heat%20pump%20local%20sensors.js),
[cloud sensor node](../44%20Heat%20pump%20cloud%20sensors.js),
[heat pump documentation](heat-pump.md), [work log](heat-pump-work-log.md).
