#!/bin/bash
set -e
mkdir -p /root/.ssh
[ -f /tmp/test_key.pub ] && cp /tmp/test_key.pub /root/.ssh/authorized_keys
chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true
/usr/sbin/sshd
cd /data/home/nodered/.node-red
if [ -n "${TEST_GX_FAKETIME:-}" ]; then
    export LD_PRELOAD="/usr/local/lib/faketime/libfaketimeMT.so.1${LD_PRELOAD:+:$LD_PRELOAD}"
    export FAKETIME="$TEST_GX_FAKETIME"
    export FAKETIME_DONT_FAKE_MONOTONIC=1
fi
exec node-red --userDir /data/home/nodered/.node-red
