#!/bin/bash
# Venus container entry: "emu" = our emulator instead of a recorded simulation, anything else = venus-docker simulation.
if [ "$1" != "emu" ]; then exec /root/run_with_simulation.sh "$@"; fi

/root/start_services.sh
until python3 -c 'import sys, dbus; sys.exit("com.victronenergy.settings" not in dbus.SystemBus().list_names())' 2>/dev/null; do sleep 1; done
# the emulator provides com.victronenergy.system, vebus and battery itself
svc -d /service/dbus-systemcalc-py /service/dbus-modbus-client /service/dbus-generator-starter 2>/dev/null
sleep 2
exec python3 -u /emulator/emulator.py
