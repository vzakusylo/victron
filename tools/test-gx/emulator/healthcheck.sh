#!/bin/bash
# emu: the emulator API answers only after its services are registered; otherwise the simulation's system service must exist.
if [ "$1" = "emu" ]; then python3 -c 'import urllib.request as u; u.urlopen("http://127.0.0.1:8081/state", timeout=2)'; else dbus -y com.victronenergy.system /DeviceInstance GetValue >/dev/null; fi
