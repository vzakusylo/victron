#!/bin/sh
# Runs on the Cerbo GX (busybox sh). Reads a tar archive from stdin containing
#   secrets/<7 active private files> and tools/<2 helper scripts>,
# installs it with a timestamped backup, validates it and rolls back on failure.
# It never prints file contents and never restarts Node-RED.
set -eu
umask 077

GX_HOME=${VICTRON_HOME:-/data/home/nodered}
CONFIG_DIR="$GX_HOME/grid-control-config"
NODE_RED_DIR="$GX_HOME/.node-red"
TOOLS_DIR="$GX_HOME/tools"
SERVICE=${VICTRON_SERVICE:-/service/node-red-venus}
CONFIG_FILES="tuya-cloud.json tuya-devices.json tuya-local-sensors.json tuya-nodes.json email.json mcp-token.txt"
NODE_RED_FILES="settings-user.js"
TOOL_FILES="victron-secrets.js reload-victron-secrets.js"

if [ "$(id -u)" != 0 ]; then
    echo "Installation requires root" >&2
    exit 1
fi
STATE=$(svstat "$SERVICE") || exit 1
case "$STATE" in
    *": down "*) ;;
    *) echo "Stop Node-RED and verify it is down before installing secrets" >&2; exit 1 ;;
esac

STAGE=$(mktemp -d "$GX_HOME/.secrets-stage.XXXXXX")
BACKUP=
CHANGED=0
cleanup() {
    STATUS=$?
    trap - EXIT HUP INT TERM
    if [ "$CHANGED" = 1 ]; then
        echo "Installation failed; restoring previous files from $BACKUP" >&2
        RESTORE_FAILED=0
        for group in config node-red tools; do
            case "$group" in
                config) DEST="$CONFIG_DIR"; FILES="$CONFIG_FILES" ;;
                node-red) DEST="$NODE_RED_DIR"; FILES="$NODE_RED_FILES" ;;
                tools) DEST="$TOOLS_DIR"; FILES="$TOOL_FILES" ;;
            esac
            for f in $FILES; do
                if [ -e "$BACKUP/$group/$f" ]; then
                    # Remove first: never write through a symlink left at the destination.
                    { rm -f "$DEST/$f" && cp -p "$BACKUP/$group/$f" "$DEST/$f"; } || RESTORE_FAILED=1
                else
                    rm -f "$DEST/$f" || RESTORE_FAILED=1
                fi
            done
        done
        if [ "$RESTORE_FAILED" = 1 ]; then
            echo "Rollback incomplete; keep Node-RED stopped and restore from $BACKUP" >&2
        fi
        STATUS=1
    fi
    rm -rf "$STAGE" || STATUS=1
    exit "$STATUS"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cat > "$STAGE/archive.tar"
EXPECTED=$(for f in $CONFIG_FILES $NODE_RED_FILES; do echo "secrets/$f"; done; for f in $TOOL_FILES; do echo "tools/$f"; done)
tar -tf "$STAGE/archive.tar" > "$STAGE/members" || exit 1
tar -tvf "$STAGE/archive.tar" > "$STAGE/types" || exit 1
if grep -q '^[^-d]' "$STAGE/types"; then
    echo "Archive must contain only regular files and directories" >&2
    exit 1
fi
ACTUAL=$(grep -v '/$' "$STAGE/members" | sort)
if [ "$(echo "$EXPECTED" | sort)" != "$ACTUAL" ]; then
    echo "Archive does not contain exactly the expected files" >&2
    exit 1
fi
# Only these directories are allowed; reject traversal paths even for directories.
if grep '/$' "$STAGE/members" | grep -v -E '^(secrets|tools)/$' | grep -q .; then
    echo "Unexpected archive directory" >&2
    exit 1
fi
tar -xf "$STAGE/archive.tar" -C "$STAGE"

BACKUP=$(mktemp -d "$NODE_RED_DIR/backup-pre-secret-deploy-XXXXXX")
mkdir -p "$BACKUP/config" "$BACKUP/node-red" "$BACKUP/tools" "$CONFIG_DIR" "$TOOLS_DIR"
chmod 700 "$BACKUP"
# Back up regular files only: a symlink is not followed (its target is not ours to copy or restore).
is_plain() { [ -f "$1" ] && [ ! -L "$1" ]; }
for f in $CONFIG_FILES; do if is_plain "$CONFIG_DIR/$f"; then cp -p "$CONFIG_DIR/$f" "$BACKUP/config/$f"; fi; done
for f in $NODE_RED_FILES; do if is_plain "$NODE_RED_DIR/$f"; then cp -p "$NODE_RED_DIR/$f" "$BACKUP/node-red/$f"; fi; done
for f in $TOOL_FILES; do if is_plain "$TOOLS_DIR/$f"; then cp -p "$TOOLS_DIR/$f" "$BACKUP/tools/$f"; fi; done

# Venus OS (BusyBox) has no install(1). Set the owner and mode on the staged file (root-only
# directory on the same filesystem), remove the destination, then move the file in. Nothing is
# written through a symlink left at the destination (mv alone would move INTO a symlinked
# directory), a real directory there stops the install, and the secret never has the old mode.
place() {
    chown nodered:nodered "$2" && chmod "$1" "$2" && rm -f "$3" && mv -f "$2" "$3"
}

CHANGED=1
for f in $TOOL_FILES; do
    place 644 "$STAGE/tools/$f" "$TOOLS_DIR/$f"
done
for f in $CONFIG_FILES; do
    place 600 "$STAGE/secrets/$f" "$CONFIG_DIR/$f"
done
for f in $NODE_RED_FILES; do
    place 600 "$STAGE/secrets/$f" "$NODE_RED_DIR/$f"
done

node "$TOOLS_DIR/reload-victron-secrets.js" check
CHANGED=0
echo "Installed 7 active private files and 2 helper scripts; previous copies: $BACKUP"
echo "Node-RED remains stopped; start it explicitly after reviewing the installation"
