# Victron Cerbo GX — D-Bus Notification Research
_Investigated: April 23, 2026 — firmware: Venus OS Large on Cerbo GX (einstein)_

---

## D-Bus services confirmed running

```
com.victronenergy.platform
com.victronenergy.hub4
com.victronenergy.system
com.victronenergy.vebus.ttyS4
com.victronenergy.battery.ttyACM0
com.victronenergy.settings
com.victronenergy.fronius
com.victronenergy.logger
com.victronenergy.vecan.vecan0
com.victronenergy.digitalinputs
com.victronenergy.modbusclient.tcp
com.victronenergy.modbustcp
com.victronenergy.ble
com.victronenergy.adc
debug.victronenergy.gui
```

---

## /Notifications paths on com.victronenergy.platform

```
/Notifications/0                       — existing notification (dict, read-only, device-created)
/Notifications/1                       — existing notification (dict, read-only, device-created)
/Notifications/AcknowledgeAll          — writable
/Notifications/Alarm                   — boolean aggregate (read-only result: False)
/Notifications/Alert                   — writable boolean, accepts SetValue int/string (retval=0)
/Notifications/NumberOfActiveAlarms
/Notifications/NumberOfActiveInformations
/Notifications/NumberOfActiveNotifications
/Notifications/NumberOfActiveWarnings
/Notifications/NumberOfNotifications
/Notifications/NumberOfUnAcknowledgedAlarms
/Notifications/NumberOfUnAcknowledgedInformations
/Notifications/NumberOfUnAcknowledgedWarnings
```

### /Notifications/Inject — DOES NOT EXIST
The path used by the Victron Node-RED `victron-output-custom` node configured with
`com.victronenergy.platform / /Notifications/Inject` does **not** exist on this firmware.
This is why the node showed "An unknown error occurred".

---

## Structure of an existing notification (/Notifications/0)

```python
{
  'Acknowledged': True,
  'Active': False,
  'AlarmValue': 2,
  'DateTime': 1776546506,          # Unix timestamp
  'Description': 'Low SOC',        # Human-readable text shown in GX
  'DeviceName': 'SerialBattery(LLT/JBD)',
  'Service': 'com.victronenergy.battery.ttyACM0',
  'Silenced': True,
  'Trigger': '/Alarms/LowSoc',     # The D-Bus path that triggered this
  'Type': 1,                        # 0=info, 1=warning, 2=alarm
  'Value': '40.79'
}
```

---

## How real notifications are created

1. A device service (e.g. `com.victronenergy.battery.ttyACM0`) exposes `/Alarms/<Name>` paths.
2. The platform service (`venus-platform`) monitors all registered D-Bus services.
3. When an `/Alarms/*` path becomes non-zero, `venus-platform` creates a new numbered
   entry under `/Notifications/<n>` automatically.
4. There is **no public text-injection API** — you cannot push arbitrary text notifications
   via D-Bus from Node-RED without registering a full custom D-Bus service.

---

## What /Notifications/Alert actually does

```bash
dbus -y com.victronenergy.platform /Notifications/Alert SetValue 1
# retval = 0  (accepted)
# Result: increments /Notifications/NumberOfActiveAlerts counter only
# Does NOT create a visible GX screen notification with a description
```

---

## Options to send custom notifications

| Method | Description | Complexity |
|---|---|---|
| **Log files** (implemented) | Write to `/data/grid-control-logs/grid-control-YYYY-MM-DD.log` | Done |
| **Custom D-Bus service** | Python daemon registers `com.victronenergy.gridcontrol`, exposes `/Alarms/GridSetpoint`. Platform picks it up and shows it on GX screen with description. | High — requires persistent daemon + sv/runit service |
| **MQTT to local broker** | `mqtt out` node → `localhost:1883` → topic `N/903245/gridcontrol/0/Alarms/GridSetpoint` → forwarded to VRM | Medium — `dbus-mqtt` is running |
| **Node-RED notification node** | Built-in `notification` node in Node-RED (if installed) | Not installed on this device |

---

## Recommended next step: MQTT route

`dbus-mqtt` is confirmed running (`com.victronenergy.logger` + `dbus-mqtt` service).
Local MQTT broker on Cerbo GX listens on **port 1883**.

VRM portal ID: `903245`

MQTT topic pattern for custom data:
```
W/903245/gridcontrol/0/CustomName
```

Node-RED flow addition needed:
- `mqtt-broker` config node: `localhost:1883`, no auth
- `mqtt out` node: topic `W/903245/gridcontrol/0/Alarms/GridSetpoint`, QoS 0, retain false
- Format: `msg.payload = JSON.stringify({ value: <number_or_string> })`

---

## Implementation Tasks

### Option A — MQTT (recommended, medium effort)

- [ ] **A1. Verify local MQTT broker is accessible**
  - SSH: `mosquitto_pub -h localhost -p 1883 -t "test/ping" -m "hello" && echo OK`
  - If fails: check `svstat /service/dbus-mqtt`

- [ ] **A2. Discover correct MQTT topic prefix**
  - SSH: `mosquitto_sub -h localhost -p 1883 -t "N/903245/#" -v 2>/dev/null | head -n 20`
  - Confirm VRM portal ID is `903245` (already seen in VRM proxy URL)

- [ ] **A3. Add `mqtt-broker` config node to flows.json**
  - id: `mqtt-broker-local-01`
  - host: `localhost`, port: `1883`, no credentials, no TLS

- [ ] **A4. Add notification formatter function node**
  - id: `notif-mqtt-fmt-01`
  - Receives controller output 3 (notification msg)
  - Builds: `msg.topic = "W/903245/gridcontrol/0/GridSetpoint"`
  - Builds: `msg.payload = JSON.stringify({ value: msg.notification.message })`

- [ ] **A5. Add `mqtt out` node**
  - id: `notif-mqtt-out-01`
  - broker: `mqtt-broker-local-01`
  - topic: from `msg.topic`
  - QoS: 0, retain: false

- [ ] **A6. Wire controller output 3 → notif-mqtt-fmt-01 → notif-mqtt-out-01**
  - Also keep existing wire to `notif-log-fmt-01`
  - wires[3] = `["notif-log-fmt-01", "notif-mqtt-fmt-01"]`

- [ ] **A7. Bump tab version to d#14, sync day-night.txt → flows.json**

- [ ] **A8. Test: deploy and check VRM portal custom widget**
  - VRM → Advanced → Custom widgets → look for `gridcontrol` data

---

### Option B — Custom D-Bus service (full GX screen notification, high effort)

- [ ] **B1. Write Python daemon**
  - Registers `com.victronenergy.gridcontrol` on D-Bus
  - Exposes `/Alarms/GridSetpoint` path (type: int, 0=ok, 1=warning, 2=alarm)
  - Exposes `/CustomName` = `"Grid Controller"`
  - Exposes `/DeviceInstance` = `100`
  - Uses `vedbus.py` from `/opt/victronenergy/dbus-systemcalc-py/ext/velib_python/`

- [ ] **B2. Create runit service**
  - Write `/data/etc/services/gridcontrol-dbus/run` shell script
  - `chmod +x run`
  - `ln -s /data/etc/services/gridcontrol-dbus /service/`

- [ ] **B3. Connect Node-RED to daemon via MQTT or file**
  - Daemon watches a file `/data/grid-control-logs/alarm-state.json`
  - Node-RED writes `{"active": true, "message": "..."}` to that file on setpoint change
  - Daemon reads file and updates `/Alarms/GridSetpoint` on D-Bus
  - Platform service sees the alarm and creates a `/Notifications/<n>` entry with description

- [ ] **B4. Test GX screen shows notification bell with description text**

---

### Prerequisite checks (run before starting either option)

```bash
# Check MQTT broker is running
svstat /service/dbus-mqtt

# Check mosquitto tools are available
which mosquitto_pub mosquitto_sub

# Check velib_python is accessible
ls /opt/victronenergy/dbus-systemcalc-py/ext/velib_python/vedbus.py
```
