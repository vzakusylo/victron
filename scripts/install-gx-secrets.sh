#!/bin/sh
# Runs on the Cerbo GX (busybox sh). Reads a tar archive from stdin containing
#   secrets/<10 private files> and tools/<2 helper scripts>,
# installs it with a timestamped backup, validates it and rolls back on failure.
# It never prints file contents and never restarts Node-RED.
set -eu
umask 077

CONFIG_DIR=/data/home/nodered/grid-control-config
NODE_RED_DIR=/data/home/nodered/.node-red
TOOLS_DIR=/data/home/nodered/tools
CONFIG_FILES="tuya-cloud.json tuya-devices.json tuya-local-sensors.json tuya-nodes.json email.json mcp-token.txt"
NODE_RED_FILES="flows_cred.json .config.runtime.json .config.users.json settings-user.js"
TOOL_FILES="victron-secrets.js reload-victron-secrets.js"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGE=$(mktemp -d /data/home/nodered/.secrets-stage.XXXXXX)
BACKUP="$NODE_RED_DIR/backup-pre-secret-deploy-$STAMP"
trap 'rm -rf "$STAGE"' EXIT

cat > "$STAGE/archive.tar"
EXPECTED=$(for f in $CONFIG_FILES $NODE_RED_FILES; do echo "secrets/$f"; done; for f in $TOOL_FILES; do echo "tools/$f"; done)
ACTUAL=$(tar -tf "$STAGE/archive.tar" | grep -v '/$' | sort)
if [ "$(echo "$EXPECTED" | sort)" != "$ACTUAL" ]; then
    echo "Archive does not contain exactly the expected files" >&2
    exit 1
fi
tar -xf "$STAGE/archive.tar" -C "$STAGE"

mkdir -p "$BACKUP/config" "$BACKUP/node-red" "$BACKUP/tools" "$CONFIG_DIR" "$TOOLS_DIR"
chmod 700 "$BACKUP"
for f in $CONFIG_FILES; do [ -e "$CONFIG_DIR/$f" ] && cp -p "$CONFIG_DIR/$f" "$BACKUP/config/$f"; done
for f in $NODE_RED_FILES; do [ -e "$NODE_RED_DIR/$f" ] && cp -p "$NODE_RED_DIR/$f" "$BACKUP/node-red/$f"; done
for f in $TOOL_FILES; do [ -e "$TOOLS_DIR/$f" ] && cp -p "$TOOLS_DIR/$f" "$BACKUP/tools/$f"; done

rollback() {
    echo "Validation failed; restoring previous files from $BACKUP" >&2
    for f in $CONFIG_FILES; do [ -e "$BACKUP/config/$f" ] && cp -p "$BACKUP/config/$f" "$CONFIG_DIR/$f"; done
    for f in $NODE_RED_FILES; do [ -e "$BACKUP/node-red/$f" ] && cp -p "$BACKUP/node-red/$f" "$NODE_RED_DIR/$f"; done
    for f in $TOOL_FILES; do [ -e "$BACKUP/tools/$f" ] && cp -p "$BACKUP/tools/$f" "$TOOLS_DIR/$f"; done
    exit 1
}

for f in $TOOL_FILES; do
    install -m 644 -o nodered -g nodered "$STAGE/tools/$f" "$TOOLS_DIR/$f"
done
for f in $CONFIG_FILES; do
    install -m 600 -o nodered -g nodered "$STAGE/secrets/$f" "$CONFIG_DIR/$f"
done
for f in $NODE_RED_FILES; do
    install -m 600 -o nodered -g nodered "$STAGE/secrets/$f" "$NODE_RED_DIR/$f"
done

node "$TOOLS_DIR/reload-victron-secrets.js" check || rollback
echo "Installed 10 private files and 2 helper scripts; previous copies: $BACKUP"
