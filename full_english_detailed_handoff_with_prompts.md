# Full English Handoff — Cerbo GX / dbus-serialbattery / JK BLE / JBD-LLT USB / Nissan Leaf 14S NMC

This file is a **maximum-detail English handoff** extracted from the conversation. It includes:
- a chronological list of the user's prompts translated into English,
- the technical conclusions reached during troubleshooting,
- key logs, commands, config decisions, mistakes, fixes, and next-step recommendations.

---

# 1) User prompts translated to English (chronological handoff)

Below is a chronological English rendering of the user’s prompts and requests from the conversation. The wording is normalized for clarity, but the intent is preserved.

1. **Find unique Bluetooth MACs** from a pasted Bluetooth scan log.
2. **I made 3 connections; filter the MACs that correlated to that.**
3. **To add settings, what are the required values?** Example block shown:
   ```ini
   device 28:D4:1E:26:05:72 {
       name "";
       auth enable;
       encrypt enable;
   }
   ```
4. **Using this instruction, add the files to be modified.**
5. **Validate this file** (config snippet shown with `[DEFAULT]`, `BLUETOOTH_BMS`, `BLUETOOTH_USE_USB=false`).
6. The user ran:
   ```bash
   /data/apps/dbus-serialbattery/enable.sh
   ```
   and pasted the output showing `Found 1 Bluetooth BMS in the config file!`.
7. **Try to pair first** these MACs:
   - `28:D4:1E:26:05:72`
   - `72:6E:EE:41:8F:36`
   - `7E:26:89:1A:74:92`
8. User pasted a new `bluetoothctl scan on` output and asked effectively: **which one is the BMS?**
9. **How to find the BMS?** (with a large `scan on` output)
10. **Update to use `28:D4:1E:26:05:72`.**
11. User got error:
    ```text
    ERROR: BMS MAC address for battery 0 with BMS type 28:D4:1E:26:05:72 is empty. Aborting installation.
    ```
12. **Do troubleshooting** (Russian: “сделай трабелшутинг”).
13. User provided grep-like result showing only:
    ```text
    BLUETOOTH_BMS = 28:D4:1E:26:05:72
    ```
14. User reran `enable.sh` and still got the same “MAC address ... is empty” error.
15. User downloaded and reran the upstream installer from GitHub for `dbus-serialbattery` and pasted the installation output.
16. User reran `enable.sh` after reinstall and still got:
    ```text
    ERROR: BMS MAC address for battery 0 with BMS type 28:D4:1E:26:05:72 is empty. Aborting installation.
    ```
17. **Pair Bluetooth command and check**.
18. User pasted `bluetoothctl` output showing `Device ... not available` for pair/trust/connect.
19. User pasted `bluetoothctl info 28:D4:1E:26:05:72`, showing name `51027BI3E001448`, `Paired: no`, `Trusted: yes`, `Connected: no`, UUIDs and manufacturer data.
20. User pasted a large `scan on` output where `28:D4:1E:26:05:72` was repeatedly visible with RSSI changes.
21. User pasted driver log showing:
    - init of `Jkbms_Ble` at `28:D4:1E:26:05:72`
    - `BLE client not found`
    - `Device info MISSING`
    - `Cell info MISSING`
    - `Settings MISSING`
22. User attempted:
    ```bash
    pair 28:D4:1E:26:05:72
    ```
    and got `AuthenticationCanceled` / `br-connection-canceled`.
23. User pasted another scan where `28:D4:1E:26:05:72` did **not** appear.
24. User pasted longer logs showing repeated BLE failure / no client found for the JK BLE device.
25. **Let's change to use `D8:D6:68:66:E8:71`.**
26. User pasted Bluetooth/Tuya-like output showing devices named `TY`, manufacturer key `0x07d0`, service `0000a201...`.
27. User pasted logs about **JK BMS SOC reset finished** and repeated float-threshold warnings:
    ```text
    Could not change to float voltage. Battery SoC (...) is lower than SWITCH_TO_BULK_SOC_THRESHOLD (...)
    ```
28. User pasted current config snippet containing:
    ```ini
    [DEFAULT]
    BLUETOOTH_BMS = Jkbms_Ble 28:D4:1E:26:05:72
    ```
29. **Write a service to check the log every 5 minutes; if it failed to connect to BMS, restart service.**
30. User pasted repeating SOC reset / float threshold warnings every 15 minutes.
31. **Update to restart on error** with logs showing Bluetooth interruption, battery does not respond, etc.
32. **Update script to restart if error occurs using `/data/apps/dbus-serialbattery/restart.sh`.**
33. **Update script to restart only when** the exact error appears:
    ```text
    >>> ERROR: Battery does not respond, init/reset values <<<
    ```
34. **How to change max charging current and values for float / absorb?**
    User also pasted logs around a Python `DBusError`, missing Device/Cell/Settings info, and then a successful reconnection showing:
    - `MAX BATTERY CHARGE CURRENT: 50.0 A` then `100.0 A (read from BMS)`
    - `MIN/MAX/FLOAT CELL VOLTAGE: 2.900 / 3.450 / 3.375`
35. **Give path to nano**.
36. User changed config to:
    ```ini
    [DEFAULT]
    BLUETOOTH_BMS = Jkbms_Ble 28:D4:1E:26:05:72
    SWITCH_TO_BULK_SOC_THRESHOLD = 80
    MAX_BATTERY_CHARGE_CURRENT = 1.0
    MAX_BATTERY_DISCHARGE_CURRENT = 60.0
    ```
37. **I connected the battery by USB LLT/JBD** and showed a `nano` screenshot of `config.ini` with NMC values and USB-oriented use.
38. **The battery shows 4% charge at 53.77 V; 13 batteries are connected in parallel and one battery is used by Victron for ESS.**
39. **JBD BMS — what to use for Nissan Leaf 7 modules connected in series, so 48V battery?**
40. **Like this** (user showed JBD app screenshot with chemistry set to NMC and Leaf-module values).
41. **Where is this file located? I have JBD BMS USB connected via UART cable to Cerbo GX.**
42. **Here is my current config** (user showed config image/screenshot).
43. User attempted to tail `ttyUSB*` logs, got “No such file or directory”.
44. User listed `/data/log` and discovered the active service is **`dbus-serialbattery.ttyACM0`**, not `ttyUSB*`.
45. User mistakenly tried to execute the log file directly, then correctly tailed:
    ```bash
    tail -F /data/log/dbus-serialbattery.ttyACM0/current | tai64nlocal
    ```
    and got:
    ```text
    configparser.DuplicateOptionError: ... option 'soc_calculation' in section 'DEFAULT' already exists
    ```
46. User then tailed the log again after fixing the duplicate, and saw healthy startup lines showing current limits, voltages, FET state, and serial `32_55.0Ah`.
47. **Extract all important info to a file to be used in another chat.**
48. **Extract the maximum detailed info; extract all prompts in English.**

---

# 2) Main technical storyline

## 2.1 Initial Bluetooth / JK BMS phase
The conversation started with Bluetooth scan logs. Several MAC addresses were detected, including:
- `28:D4:1E:26:05:72`
- `72:6E:EE:41:8F:36`
- `7E:26:89:1A:74:92`
- controller `28:F5:2B:39:C0:0C`

Through repeated scan review, the stable BMS candidate was identified as:
- **`28:D4:1E:26:05:72`**
- Device name seen: **`51027BI3E001448`**
- This matched JK/Seplos-style BLE behavior better than Apple-rotating MACs or Tuya devices.

Multiple other devices later seen in BLE scans were **not BMS**:
- Apple-like rotating devices (manufacturer key `0x004c`)
- Tuya/TY devices (`ManufacturerData.Key: 0x07d0`, service `0000a201...`)
- These were explicitly ruled out as valid `dbus-serialbattery` BMS sources.

## 2.2 Bluetooth pairing/connect reality
The JK BLE device was often visible in `scan on`, but pairing was unstable or unnecessary:
- `pair` often failed with:
  - `org.bluez.Error.AuthenticationCanceled`
  - `org.bluez.Error.Failed br-connection-canceled`
- The device frequently disappeared from advertising, causing:
  - `Device not available`
  - `BLE client not found`
- It was concluded that JK BLE often sleeps or is unstable, and that pairing is often unnecessary or unreliable for this class of BMS.

## 2.3 Bluetooth config format confusion
There was major troubleshooting around the format of `config.ini` for BLE.
At different times, the config used:
- unindexed single-line style such as:
  ```ini
  BLUETOOTH_BMS = 28:D4:1E:26:05:72
  ```
- indexed or typed style suggestions like:
  ```ini
  BMS_TYPE_0 = Jkbms_Ble
  BLUETOOTH_BMS_0 = 28:D4:1E:26:05:72
  ```
- newer combined syntax later used successfully:
  ```ini
  BLUETOOTH_BMS = Jkbms_Ble 28:D4:1E:26:05:72
  ```

The repeated installer error was:
```text
ERROR: BMS MAC address for battery 0 with BMS type 28:D4:1E:26:05:72 is empty. Aborting installation.
```
This indicated that the parsing order of type vs. MAC was wrong for the format being used at that moment.

Reinstalling `dbus-serialbattery` from upstream eventually reset the environment and clarified the expected format.

## 2.4 JK BLE runtime issues
Even after config parsing was corrected, BLE remained unreliable. Logs repeatedly showed:
- `BLE client not found: 28:D4:1E:26:05:72 - is it turned on and nearby?`
- `Device info MISSING`
- `Cell info MISSING`
- `Settings MISSING`
- `>>> No battery connection at Jkbms_Ble 28:D4:1E:26:05:72`

Later, when BLE did connect, logs showed successful entries like:
- `Try to connect to Jkbms_Ble at 28:D4:1E:26:05:72`
- `Device connected, check if it's really a JKBMS`
- `Processing frame with settings info`
- `Connection established`

However, overnight / later logs still showed critical failures:
- `Bluetooth connection interrupted. Got no fresh data since 15 s`
- `>>> ERROR: Battery does not respond, init/reset values <<<`
- `Battery did not recover in 90 s. Restarting driver...`

This led to the idea of a watchdog service.

---

# 3) Watchdog work completed during the chat

A watchdog concept was developed for Venus OS / Cerbo GX to monitor driver logs and restart the driver on failure.

## 3.1 First watchdog idea
The first version checked log content every 5 minutes and restarted the BLE service when errors such as these appeared:
- `BLE client not found`
- `No battery connection`
- `Device info MISSING`
- `Cell info MISSING`
- `Settings MISSING`

## 3.2 Updated watchdog for deep Bluetooth/BMS failure
The watchdog was then expanded to detect:
- `Bluetooth connection interrupted`
- `Battery does not respond`
- `init/reset values`
- `did not recover in`
- `NOT in a safe threshold`

## 3.3 Final requested watchdog behavior
The user narrowed the requirement to this exact restart condition only:
```text
>>> ERROR: Battery does not respond, init/reset values <<<
```
And requested the restart to happen using:
```bash
/data/apps/dbus-serialbattery/restart.sh
```
instead of restarting only the individual BLE service.

So the final intended watchdog logic was:
- read the relevant log file
- search for the exact “Battery does not respond, init/reset values” error
- if found, run:
  ```bash
  /data/apps/dbus-serialbattery/restart.sh
  ```
- check periodically (every 5 minutes via daemontools service)

---

# 4) Transition from Bluetooth JK BMS to USB JBD/LLT BMS

The setup later changed significantly:
- the user connected a **JBD/LLT BMS by USB-UART cable to Cerbo GX**
- Bluetooth became historical context rather than the active solution

This was a major turning point in the chat.

## 4.1 Active serial port discovery
At first, the user tried to read logs using:
```bash
tail -F /data/log/dbus-serialbattery.ttyUSB*/current | tai64nlocal
```
and got:
```text
tail: can't open '/data/log/dbus-serialbattery.ttyUSB*/current': No such file or directory
```

By listing `/data/log`, it was discovered that the actual active log directory was:
- **`/data/log/dbus-serialbattery.ttyACM0`**

So the correct command became:
```bash
tail -F /data/log/dbus-serialbattery.ttyACM0/current | tai64nlocal
```

## 4.2 Important user mistake that was corrected
The user tried to execute the log file as if it were a command:
```bash
/data/log/dbus-serialbattery.ttyACM0/current
```
which resulted in:
```text
Permission denied
```

This was not a permissions problem with `tail`; it was simply a log file, not an executable.

Correct usage:
```bash
tail -F /data/log/dbus-serialbattery.ttyACM0/current | tai64nlocal
```

---

# 5) USB JBD/LLT config phase

## 5.1 File location repeatedly confirmed
The main config file is:
```bash
/data/apps/dbus-serialbattery/config.ini
```
Open with:
```bash
nano /data/apps/dbus-serialbattery/config.ini
```

Reference defaults file:
```bash
/data/apps/dbus-serialbattery/config.default.ini
```

## 5.2 Active config direction changed to NMC / Leaf use case
The user later showed a `config.ini` geared toward **JBD/LLT over USB** for a **Nissan Leaf-derived 14S NMC pack**. Key values used/discussed included:
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

Bluetooth lines were kept commented out while in USB/UART mode.

---

# 6) Battery chemistry and pack design conclusions

## 6.1 JBD for Nissan Leaf 7 modules in series
The user asked which JBD BMS chemistry/profile to use for:
- **7 Nissan Leaf modules in series**
- about **48V class battery**

Conclusion reached during the chat:
- Use **NMC / Li-ion**, not LFP
- 7 Leaf modules in series = **14S pack**
- One Leaf module is typically 2 cells in series internally, so 7 modules = 14 series cells overall

## 6.2 Practical voltage reasoning used
For a 14S NMC pack:
- `MAX_CELL_VOLTAGE = 4.10` gives:
  - `4.10 × 14 = 57.40 V`
- `FLOAT_CELL_VOLTAGE = 3.85` gives:
  - `3.85 × 14 = 53.90 V`
- Later it was suggested that **3.80 V/cell** float might be gentler for longevity than **3.85 V/cell**.

## 6.3 Capacity guidance
The user was advised that for **7 modules in series**, Ah do **not** add in series.
So pack Ah should remain the Ah of one module (adjusted for age/health), not multiplied by 7.
A practical working capacity target around **55 Ah** was used in the conversation.
Later, the driver log showed:
```text
Serial Number/Unique Identifier: 32_55.0Ah
```
which fit the chosen capacity assumption.

---

# 7) ESS / SmartShunt / parallel battery context

A very important system-level context emerged later:
- The system has **13 batteries connected in parallel**
- One battery was being used by Victron for ESS / BMS integration
- The battery connected via JBD/LLT showed SoC values that did not match the system-level monitor
- SmartShunt showed a different SoC than the one JBD battery

Conclusion reached:
- **Do not trust SoC from a single JBD/LLT battery as the SoC of the whole parallel ESS system**
- If SmartShunt is the intended system-level monitor, it should be preferred for system SoC
- Because of that, setting:
  ```ini
  SOC_CALCULATION = False
  ```
  in `dbus-serialbattery` was recommended, so the one JBD battery would not confuse ESS/system interpretation

---

# 8) Important config error found on USB setup

When the user first tailed the active `ttyACM0` log, the driver was crashing with:
```text
configparser.DuplicateOptionError: While reading from '/data/apps/dbus-serialbattery/config.ini' [line 34]: option 'soc_calculation' in section 'DEFAULT' already exists
```

This was the key issue on the USB setup at that moment.

## Cause
`SOC_CALCULATION` appeared more than once in `[DEFAULT]` inside `config.ini`.

## Fix
Keep only one `SOC_CALCULATION` line, for example:
```ini
SOC_CALCULATION = False
```

Command suggested to find duplicates:
```bash
grep -ni '^SOC_CALCULATION' /data/apps/dbus-serialbattery/config.ini
```

After this was fixed, the driver started properly.

---

# 9) Latest healthy USB JBD/LLT runtime state (important handoff)

After fixing the duplicate config entry, the user tailed the `ttyACM0` log and got healthy startup lines like:
```text
INFO:SerialBattery:> CHARGE MODE: Linear
INFO:SerialBattery:> MIN CELL VOLTAGE: 3.250 V | MAX CELL VOLTAGE: 4.100 V | FLOAT CELL VOLTAGE: 3.850 V
INFO:SerialBattery:> MAX BATTERY CHARGE CURRENT: 60.0 A | MAX BATTERY DISCHARGE CURRENT: 60.0 A
INFO:SerialBattery:> CVCM:       True
INFO:SerialBattery:> CCCM CV:    True  | DCCM CV:       True
INFO:SerialBattery:> CCCM T:     True  | DCCM T:        True
INFO:SerialBattery:> CCCM T MOS: True  | DCCM T MOS:    True
INFO:SerialBattery:> CCCM SOC:   False | DCCM SOC:      False
INFO:SerialBattery:> CHARGE FET: True  | DISCHARGE FET: True | BALANCE FET: True
INFO:SerialBattery:Serial Number/Unique Identifier: 32_55.0Ah
```

This means:
- `config.ini` was loading correctly
- the battery was communicating successfully over **USB serial on ttyACM0**
- BMS charge/discharge/balance MOSFETs were enabled
- charge/discharge limits were applied as configured
- cell voltage limits were applied as configured
- SOC-based charge/discharge current limiting was disabled (`CCCM SOC: False | DCCM SOC: False`)

---

# 10) Float / absorb / charge current discussions

The user asked how to change max charging current and float/absorb values.
The conclusion for `dbus-serialbattery` was:
- edit **only** `config.ini`
- do **not** edit Python files like `jkbms_brn.py`

## Settings discussed
### Max charge / discharge current
```ini
MAX_BATTERY_CHARGE_CURRENT = 60.0
MAX_BATTERY_DISCHARGE_CURRENT = 60.0
```
(or other values depending on desired current and hardware limits)

### Cell voltages
```ini
MIN_CELL_VOLTAGE = 3.25
MAX_CELL_VOLTAGE = 4.10
FLOAT_CELL_VOLTAGE = 3.85
```

### Charge mode
The healthy log showed:
```text
CHARGE MODE: Linear
```

### Recommendation refinement
Although `FLOAT_CELL_VOLTAGE = 3.85` was working, it was later suggested that for Leaf NMC longevity, a gentler value such as:
```ini
FLOAT_CELL_VOLTAGE = 3.80
```
might be preferable.

---

# 11) SOC / float-threshold issue that appeared earlier

Before the USB setup stabilized, the user had repeated log messages like:
```text
Could not change to float voltage. Battery SoC (...) is lower than SWITCH_TO_BULK_SOC_THRESHOLD (...)
```
paired with:
```text
JK BMS SOC reset finished.
```

This happened when `SWITCH_TO_BULK_SOC_THRESHOLD` was set too high relative to the reported SoC.
That is why lowering it from 80 to 60, then to 40, was discussed and later used.

The working later config used:
```ini
SWITCH_TO_BULK_SOC_THRESHOLD = 40
```

---

# 12) Active file paths and commands that matter now

## Main config
```bash
/data/apps/dbus-serialbattery/config.ini
```
Open with:
```bash
nano /data/apps/dbus-serialbattery/config.ini
```

## Default config reference
```bash
/data/apps/dbus-serialbattery/config.default.ini
```

## Active USB serialbattery log
```bash
/data/log/dbus-serialbattery.ttyACM0/current
```
View live:
```bash
tail -F /data/log/dbus-serialbattery.ttyACM0/current | tai64nlocal
```

## Restart driver
```bash
/data/apps/dbus-serialbattery/restart.sh
```

## Check service state
```bash
svstat /service/dbus-serialbattery.*
```

## Show serial ports
```bash
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA0 2>/dev/null
```

## Show serialbattery log folders
```bash
ls -la /data/log | grep -i serialbattery
```

## Remove Windows line endings if needed
```bash
sed -i 's/
$//' /data/apps/dbus-serialbattery/config.ini
```

---

# 13) Final practical state at end of conversation

At the end of the conversation, the practical state was:
- **Active solution:** JBD/LLT BMS over USB-UART on **ttyACM0**
- **Cerbo GX** running **dbus-serialbattery v2.0.20250729**
- **Battery type:** 14S NMC pack made from **7 Nissan Leaf modules in series**
- **Config applied successfully** with current limits and NMC cell voltages
- **One important config crash (duplicate `SOC_CALCULATION`) was found and fixed**
- **SmartShunt should likely remain the ESS/system-level SOC source**, because a single JBD battery should not define SOC for a bank of 13 batteries in parallel

---

# 14) Recommended future follow-ups

If another chat continues this work, these are good next tasks:
1. Confirm the final `config.ini` against the actual JBD app values (capacity, protections, current limits).
2. Decide whether `FLOAT_CELL_VOLTAGE` should remain **3.85** or be reduced to **3.80** for Leaf longevity.
3. Confirm whether **60 A** charge/discharge in `config.ini` matches the actual JBD hardware rating, wiring, fuse, busbar, and thermal limits.
4. Confirm the Victron ESS data-source strategy:
   - SmartShunt for system SoC
   - JBD/LLT only for protection / temperature / voltage / cell data
5. If watchdog behavior is still desired, build a **USB-serial-oriented watchdog** for `ttyACM0` instead of the older BLE-focused one.

---

# 15) One-paragraph executive handoff

The system evolved from unstable **JK BMS over BLE** troubleshooting to a more stable **JBD/LLT BMS over USB-UART** connected to **Cerbo GX**. The active `dbus-serialbattery` service is now on **ttyACM0**, with logs at `/data/log/dbus-serialbattery.ttyACM0/current`. The battery in focus is a **14S NMC pack made from 7 Nissan Leaf modules in series**, with a practical capacity assumption around **55 Ah**. The active config uses **MAX_CELL_VOLTAGE=4.10**, **MIN_CELL_VOLTAGE=3.25**, **FLOAT_CELL_VOLTAGE=3.85**, **MAX_BATTERY_CHARGE_CURRENT=60.0**, **MAX_BATTERY_DISCHARGE_CURRENT=60.0**, and **SOC_CALCULATION=False** to avoid using one JBD battery as the SOC authority for a much larger parallel ESS system where **SmartShunt** is the better system-level SOC source. A duplicate `SOC_CALCULATION` entry previously crashed the driver, but after removing the duplicate, the driver started cleanly and reported healthy FET and voltage settings.
