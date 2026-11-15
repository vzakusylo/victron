#!/bin/bash
set -e
mkdir -p /root/.ssh
[ -f /tmp/test_key.pub ] && cp /tmp/test_key.pub /root/.ssh/authorized_keys
chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true
/usr/sbin/sshd
cd /data/home/nodered/.node-red
exec node-red --userDir /data/home/nodered/.node-red
