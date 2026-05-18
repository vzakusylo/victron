# Cerbo GX + dbus-serialbattery + JBD/LLT BMS (USB UART) — Summary for next chat

## 1) Current hardware / connection
- Device: **Cerbo GX**
- Driver: **dbus-serialbattery v2.0.20250729**
- Venus OS seen in logs: **v3.67 (normal)**
- Current working BMS connection: **JBD/LLT over USB-UART cable**
- Active serial device/log/service uses: **ttyACM0**
  - Log path: `/data/log/dbus-serialbattery.ttyACM0/current`
  - Correct live tail command:
    ```bash
    tail -F /data/log/dbus-serialbattery.ttyACM0/current | tai64nlocal
    ```
- Bluetooth was used before for JK BMS, but current active setup is **USB serial JBD/LLT**, not Bluetooth.

## 2) Battery details
- Battery chemistry currently configured: **NMC**
- Battery pack: **7 Nissan Leaf modules in series = 14S pack (~48V class)**
- Recommended chemistry for this pack: **14S NMC / Li-ion**, not LFP
- JBD app showed good balance at one point:
  - Pack voltage around **54.19 V**
  - Cell average around **3.872 V**
  - Cell delta around **0.006 V**
- Capacity context:
  - 7 Leaf modules in series keep the **same Ah as one module** (Ah do not add in series)
  - Working/identified battery serial in driver log looked like: **`32_55.0Ah`**
  - 55 Ah was treated as a realistic capacity target for the pack

## 3) Important current config status
- `config.ini` path:
  ```bash
  /data/apps/dbus-serialbattery/config.ini
  ```
- Important reference file:
  ```bash
  /data/apps/dbus-serialbattery/config.default.ini
  ```
- The config must begin with:
  ```ini
  [DEFAULT]
  ```
- Current active values (based on latest working log and discussed config):
  ```ini
  [DEFAULT]
  SWITCH_TO_BULK_SOC_THRESHOLD = 40

  MAX_BATTERY_CHARGE_CURRENT = 60.0
  MAX_BATTERY_DISCHARGE_CURRENT = 60.0

  MAX_CELL_VOLTAGE = 4.10
  MIN_CELL_VOLTAGE = 3.25
  FLOAT_CELL_VOLTAGE = 3.85

  CCCM_CV_ENABLE = True
  DCCM_CV_ENABLE = True
  CELL_VOLTAGES_WHILE_CHARGING = 4.10, 4.05, 4.00, 3.90
  MAX_CHARGE_CURRENT_CV_FRACTION = 0, 0.05, 0.5, 1
  CELL_VOLTAGES_WHILE_DISCHARGING = 3.25, 3.30, 3.35, 3.45
  MAX_DISCHARGE_CURRENT_CV_FRACTION = 0, 0.1, 0.5, 1

  BATTERY_CELL_DATA_FORMAT = 1
  GUI_PARAMETERS_SHOW_ADDITIONAL_INFO = True

  SOC_CALCULATION = False
  ```
- Bluetooth lines should remain commented out while using USB UART.

## 4) Important config mistakes already found and fixed
### Duplicate config option error
- The driver previously failed because `SOC_CALCULATION` existed **more than once** in `config.ini`.
- Error seen:
  ```text
  configparser.DuplicateOptionError: While reading from '/data/apps/dbus-serialbattery/config.ini' [line 34]: option 'soc_calculation' in section 'DEFAULT' already exists
  ```
- Fix: keep only **one** `SOC_CALCULATION` line in `[DEFAULT]`.
- Suggested command to find duplicates:
  ```bash
  grep -ni '^SOC_CALCULATION' /data/apps/dbus-serialbattery/config.ini
  ```

### Wrong attempt to treat log file as command
- Trying to execute `/data/log/dbus-serialbattery.ttyACM0/current` gave **Permission denied** because it is a log file, not a command.
- Correct way is to **read** it via `tail`, `cat`, etc.

## 5) Latest confirmed healthy driver log indicators
Latest healthy startup showed lines like:
```text
INFO:SerialBattery:> CHARGE MODE: Linear
INFO:SerialBattery:> MIN CELL VOLTAGE: 3.250 V | MAX CELL VOLTAGE: 4.100 V | FLOAT CELL VOLTAGE: 3.850 V
INFO:SerialBattery:> MAX BATTERY CHARGE CURRENT: 60.0 A | MAX BATTERY DISCHARGE CURRENT: 60.0 A
INFO:SerialBattery:> CCCM SOC:   False | DCCM SOC:      False
INFO:SerialBattery:> CHARGE FET: True  | DISCHARGE FET: True | BALANCE FET: True
INFO:SerialBattery:Serial Number/Unique Identifier: 32_55.0Ah
```
This means:
- config is loading correctly
- BMS is connected over USB serial
- charge/discharge/balance FETs are enabled
- the earlier duplicate-option config crash is resolved

## 6) ESS / SOC context
- System has **13 batteries in parallel**, and one battery was being used by Victron for ESS/BMS integration.
- SmartShunt showed a very different SOC than one individual LLT/JBD battery.
- Important conclusion from prior troubleshooting:
  - **Do not trust SOC from a single JBD/LLT battery as the SOC of the whole parallel ESS system**.
  - SmartShunt should be preferred as the system-level monitor if it is the intended ESS monitor.
- Because of that, `SOC_CALCULATION = False` for this one JBD battery was recommended to avoid confusion.

## 7) Earlier Bluetooth history (only if needed for context)
- Earlier there was extensive troubleshooting of a **JK BMS over BLE** using MAC `28:D4:1E:26:05:72`.
- That BLE setup had repeated failures like:
  - `BLE client not found`
  - `Battery does not respond, init/reset values`
  - Bluetooth connection interrupted / stale data
- It was later determined that the active practical setup switched to **USB JBD/LLT**, so BLE is historical context only unless explicitly revisited.

## 8) Commands that are useful in next chat
### Open config
```bash
nano /data/apps/dbus-serialbattery/config.ini
```

### Remove possible Windows CRLF line endings
```bash
sed -i 's/$//' /data/apps/dbus-serialbattery/config.ini
```

### Restart driver
```bash
/data/apps/dbus-serialbattery/restart.sh
```

### Follow active serialbattery log (USB UART on ttyACM0)
```bash
tail -F /data/log/dbus-serialbattery.ttyACM0/current | tai64nlocal
```

### Check service state
```bash
svstat /service/dbus-serialbattery.*
```

### Show active serial ports
```bash
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA0 2>/dev/null
```

### Show which serialbattery log folders exist
```bash
ls -la /data/log | grep -i serialbattery
```

## 9) Recommended next-step topics for a future chat
If continuing later, useful topics would be:
1. Validate the final `config.ini` against actual JBD app settings
2. Decide the best **float voltage** for Leaf NMC (3.85 V/cell works, but 3.80 V/cell may be gentler for longevity)
3. Verify whether `MAX_BATTERY_CHARGE_CURRENT = 60 A` matches the actual JBD hardware and wiring limits
4. Decide whether to keep SmartShunt as the ESS/system SOC source and JBD only for protection/telemetry
5. If needed, build a watchdog specifically for the **USB serial** JBD service instead of the old BLE watchdog

## 10) Concise one-paragraph handoff summary
Current working setup is **Cerbo GX + dbus-serialbattery v2.0.20250729 + JBD/LLT BMS over USB-UART on ttyACM0**. The active log file is `/data/log/dbus-serialbattery.ttyACM0/current`. The battery is a **14S NMC pack made from 7 Nissan Leaf modules in series**, with a practical capacity assumption around **55 Ah**. The current config uses **MAX_CELL_VOLTAGE=4.10**, **MIN_CELL_VOLTAGE=3.25**, **FLOAT_CELL_VOLTAGE=3.85**, **charge/discharge limits 60 A / 60 A**, and **SOC_CALCULATION=False** so that Victron/ESS can rely on **SmartShunt** for system SOC instead of one individual JBD battery in a multi-battery parallel system. A previous config issue was caused by a duplicate `SOC_CALCULATION` line, but that was fixed; the driver now starts and loads the config successfully.
