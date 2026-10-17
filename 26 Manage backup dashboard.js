// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `26 Manage backup dashboard.js` and the embedded `func` for "Manage backup dashboard"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Backup / restore of everything that is unique to this device, so a new GX device can be
//   brought to the same state (full history + all setup) from one `.tar.gz` file.
// Backup contents (each path only when it exists; paths are relative to `/`):
// - data/home/nodered/grid-control-logs     energy history (monthly CSV + legacy daily logs), notification logs
// - data/home/nodered/grid-control-config   dashboard settings (HV settings, controller constants, ...)
// - data/home/nodered/.node-red/*           Node-RED flows, credentials, settings, context, library
//                                           (node_modules / .npm / .cache are excluded)
// - data/apps                               installed drivers/apps incl. dbus-serialbattery (code + config.ini)
// - data/etc/dbus-serialbattery             legacy dbus-serialbattery install location
// - data/grid-control-logs, data/node-red   legacy log folders
// - data/etc/services, data/rc.local, data/rcS.local   custom services / boot scripts
// - data/conf/settings.xml                  Venus OS settings (restored only when explicitly selected)
// - a manifest `grid-control-config/backup-manifest.txt` marks the archive as a grid-control backup
// Backups are stored in /data/home/nodered/grid-control-backups (never deleted automatically).
// Inputs:
// - topic `backup-command` (dashboard): payload { action: 'refresh' | 'create' | 'restore',
//   name, restoreVenusSettings, restartNodeRed, enableDrivers, confirm }
// - topic `backup-exec` (exec stdout): script output with `@@` markers
// - topic `backup-uploaded` (from "Store uploaded backup"): payload { name }
// - anything else (dashboard connect) -> refresh
// Outputs (2):
// - output 1 -> dashboard template state
// - output 2 -> exec "Run backup script" (`sh -c <payload>`)
// Restore safety:
// - the backup name must match a file in the backup folder
// - the archive must contain the manifest and only the allowed paths (no `..`)
// - the user must type RESTORE; a `pre-restore-*` backup is created first
// - files are extracted to a staging folder, then copied over the live paths (merge, same names overwritten)
// - Node-RED is restarted afterwards when Node-RED files were restored and the option is set
// Change notes:
// 1. Initial version.
// 2. Backs up the whole /data/apps folder (driver code + config, e.g. dbus-serialbattery) and the legacy
//    /data/etc/dbus-serialbattery folder instead of only config.ini. Restore can run each restored
//    driver's enable.sh (option `enableDrivers`, default on); a reboot then starts the drivers.
//    Older backups that only contain config.ini still restore (it lives under data/apps).
// 3. Added `delete` action (dashboard button with a browser confirmation; never automatic).
//    /data/apps/overlay-fs (Venus OS root-filesystem overlay with unreadable kernel work dirs) is
//    excluded like node_modules; drivers recreate their overlays with enable.sh.
// ==========================

const BACKUP_DIR = '/data/home/nodered/grid-control-backups';
const MANIFEST_PATH = 'data/home/nodered/grid-control-config/backup-manifest.txt';
const NODE_RED_DIR = 'data/home/nodered/.node-red';
const VENUS_SETTINGS_PATH = 'data/conf/settings.xml';
// Venus OS keeps only /data across firmware updates, so drivers live in /data/apps/<name> and are
// (re)registered by their own enable.sh (dbus-serialbattery: /data/apps/dbus-serialbattery/enable.sh).
const DRIVERS_DIR = 'data/apps';
// Folders backed up child by child, skipping the listed children:
// - node_modules / .npm / .cache are reinstallable Node-RED packages and caches
// - overlay-fs is Venus OS's own overlay of the root filesystem (GUI/system mods, kernel work dirs);
//   drivers recreate their overlays with enable.sh, and restoring it on other firmware is unsafe
const EXPANDED_DIRS = {
    'data/home/nodered/.node-red': ['node_modules', '.npm', '.cache'],
    'data/apps': ['overlay-fs']
};
const BACKUP_PATHS = [
    'data/home/nodered/grid-control-logs',
    'data/home/nodered/grid-control-config',
    NODE_RED_DIR,
    DRIVERS_DIR,
    'data/etc/dbus-serialbattery',
    'data/grid-control-logs',
    'data/node-red',
    'data/etc/services',
    'data/rc.local',
    'data/rcS.local',
    VENUS_SETTINGS_PATH
];
const BACKUP_LABELS = {
    'data/home/nodered/grid-control-logs': 'Energy history and logs',
    'data/home/nodered/grid-control-config': 'Dashboard settings (HV, constants)',
    'data/home/nodered/.node-red': 'Node-RED flows, credentials, settings, context',
    'data/apps': 'Drivers and apps incl. dbus-serialbattery (code + config.ini)',
    'data/etc/dbus-serialbattery': 'dbus-serialbattery (legacy install path)',
    'data/grid-control-logs': 'Legacy logs',
    'data/node-red': 'Legacy Node-RED logs',
    'data/etc/services': 'Custom services',
    'data/rc.local': 'Boot script rc.local',
    'data/rcS.local': 'Boot script rcS.local',
    'data/conf/settings.xml': 'Venus OS settings (optional on restore)'
};
const NAME_PATTERN = /^[A-Za-z0-9._-]+\.tar\.gz$/;
const BUSY_TIMEOUT_MS = 15 * 60 * 1000;
const STATE_KEY = 'backupDashboardState';

function shellQuote(script) {
    return "'" + String(script).replace(/'/g, "'\\''") + "'";
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1024 * 1024 * 1024) {
        return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
    if (value >= 1024 * 1024) {
        return (value / (1024 * 1024)).toFixed(1) + ' MB';
    }
    if (value >= 1024) {
        return (value / 1024).toFixed(1) + ' KB';
    }
    return value + ' B';
}

// Shell helpers shared by every script: list backups + disk, and create an archive.
function scriptPrelude() {
    const plainPaths = BACKUP_PATHS.filter(path => !EXPANDED_DIRS[path]).join(' ');
    // Expanded folders are added child by child so excluded children never reach tar.
    const expandLines = Object.keys(EXPANDED_DIRS).map(dirPath =>
        '  if [ -d "$R/' + dirPath + '" ]; then for f in "$R/' + dirPath + '"/* "$R/' + dirPath + '"/.[!.]*; do [ -e "$f" ] || continue; '
        + 'case "${f##*/}" in ' + EXPANDED_DIRS[dirPath].join('|') + ') continue;; esac; add "' + dirPath + '/${f##*/}"; done; fi'
    );

    return [
        // R is the filesystem root (empty on the device; a temp folder in tests).
        'R=""',
        'B="$R' + BACKUP_DIR + '"',
        'list_backups() {',
        '  echo "@@USER $(id -un 2>/dev/null)"',
        '  echo "@@DF $(df -Pk "$B" 2>/dev/null | tail -n 1)"',
        '  for f in "$B"/*.tar.gz; do [ -f "$f" ] || continue; printf "@@B\\t%s\\t%s\\t%s\\n" "$(wc -c < "$f")" "$(date -r "$f" "+%Y-%m-%d %H:%M" 2>/dev/null)" "${f##*/}"; done',
        '}',
        'fail() { echo "@@ERROR $*"; list_backups; exit 0; }',
        'create_backup() {',
        '  NAME="$1-$(date +%Y%m%d-%H%M%S).tar.gz"',
        '  mkdir -p "$B" "$R/' + MANIFEST_PATH.replace(/\/[^/]+$/, '') + '" || fail "Cannot create $B"',
        '  L=""',
        '  add() { if [ -e "$R/$1" ]; then if [ -r "$R/$1" ]; then L="$L $1"; else echo "@@SKIPPED $1 (not readable)"; fi; fi; }',
        '  for p in ' + plainPaths + '; do add "$p"; done',
        ...expandLines,
        '  { echo "type=grid-control-backup"; echo "format=1"; echo "created=$(date "+%Y-%m-%d %H:%M:%S %z")"; echo "host=$(hostname)"; echo "venus=$(head -n 1 /opt/victronenergy/version 2>/dev/null)"; echo "user=$(id -un 2>/dev/null)"; for p in $L; do echo "path=$p"; done; } > "$R/' + MANIFEST_PATH + '" || fail "Cannot write manifest"',
        '  case " $L " in *" data/home/nodered/grid-control-config "*) ;; *) L="$L ' + MANIFEST_PATH + '";; esac',
        '  tar -czf "$B/$NAME.part" -C "$R/" $L 2>"$B/.tar-errors"',
        '  if tar -tzf "$B/$NAME.part" >/dev/null 2>&1; then mv "$B/$NAME.part" "$B/$NAME"; else rm -f "$B/$NAME.part"; sed "s/^/@@LOG /" "$B/.tar-errors"; fail "Archive could not be created"; fi',
        '  sed "s/^/@@LOG /" "$B/.tar-errors"; rm -f "$B/.tar-errors"',
        '  for p in $L; do echo "@@INCLUDED $p"; done',
        '  CREATED="$NAME"',
        '}'
    ].join('\n');
}

function buildRefreshScript() {
    return scriptPrelude() + '\nlist_backups';
}

function buildCreateScript() {
    return scriptPrelude() + '\ncreate_backup grid-backup\necho "@@CREATED $CREATED"\nlist_backups';
}

// `name` is validated against NAME_PATTERN and the current list before this is called.
function buildDeleteScript(name) {
    return scriptPrelude() + '\n' + [
        '[ -f "$B/' + name + '" ] || fail "Backup not found: ' + name + '"',
        'rm -f "$B/' + name + '" && [ ! -e "$B/' + name + '" ] || fail "Cannot delete ' + name + '"',
        'echo "@@DELETED ' + name + '"',
        'list_backups'
    ].join('\n');
}

function buildRestoreScript(name, restoreVenusSettings, restartNodeRed, enableDrivers) {
    const allowed = BACKUP_PATHS.map(escapeRegex).join('|');
    // Parent folder entries (`data/`, `data/home/`, ...) appear when an archive is repacked by another tool.
    const parents = Array.from(new Set(BACKUP_PATHS.reduce((list, path) => {
        const parts = path.split('/');
        for (let index = 1; index < parts.length; index += 1) {
            list.push(parts.slice(0, index).join('/') + '/');
        }
        return list;
    }, []))).map(escapeRegex).join('|');

    return scriptPrelude() + '\n' + [
        'F="$B/' + name + '"',
        'ST="$B/.restore-staging"',
        '[ -f "$F" ] || fail "Backup not found: ' + name + '"',
        'tar -tzf "$F" > "$B/.restore-list" 2>/dev/null || fail "Not a valid .tar.gz archive"',
        'grep -q "^' + escapeRegex(MANIFEST_PATH) + '$" "$B/.restore-list" || fail "Not a grid-control backup (manifest missing)"',
        'BAD=$(grep -v -E "^(' + allowed + ')(/|$)" "$B/.restore-list" | grep -v -E "^(' + parents + ')$" | head -n 3 | tr "\\n" " ")',
        '[ -z "$BAD" ] || fail "Archive contains unexpected paths: $BAD"',
        'grep -q "\\.\\./" "$B/.restore-list" && fail "Archive contains .. paths"',
        'create_backup pre-restore',
        'echo "@@SAFETY $CREATED"',
        'rm -rf "$ST"; mkdir -p "$ST" || fail "Cannot create staging folder"',
        'tar -xzf "$F" -C "$ST" 2>/dev/null || { rm -rf "$ST"; fail "Extract failed"; }',
        'NR=0',
        'for p in ' + BACKUP_PATHS.join(' ') + '; do',
        '  [ -e "$ST/$p" ] || continue',
        '  if [ "$p" = "' + VENUS_SETTINGS_PATH + '" ] && [ "' + (restoreVenusSettings ? '1' : '0') + '" != "1" ]; then echo "@@SKIP $p (Venus OS settings not selected)"; continue; fi',
        '  D="$R/${p%/*}"',
        '  if mkdir -p "$D" && cp -a "$ST/$p" "$D/"; then echo "@@RESTORED $p"; [ "$p" = "' + NODE_RED_DIR + '" ] && NR=1; else echo "@@FAILED $p"; fi',
        'done',
        // Re-register every restored driver that ships an enable.sh (creates its services / rc.local hooks).
        'if [ "' + (enableDrivers ? '1' : '0') + '" = "1" ]; then',
        '  for e in "$ST/' + DRIVERS_DIR + '"/*/enable.sh; do',
        '    [ -f "$e" ] || continue',
        '    DRV="${e%/enable.sh}"; DRV="${DRV##*/}"',
        '    if [ -f "$R/' + DRIVERS_DIR + '/$DRV/enable.sh" ] && bash "$R/' + DRIVERS_DIR + '/$DRV/enable.sh" > "$B/.enable-$DRV.log" 2>&1; then echo "@@DRIVER $DRV"; else echo "@@FAILED ' + DRIVERS_DIR + '/$DRV/enable.sh"; fi',
        '    tail -n 5 "$B/.enable-$DRV.log" 2>/dev/null | sed "s/^/@@LOG [$DRV] /"; rm -f "$B/.enable-$DRV.log"',
        '  done',
        'fi',
        'rm -rf "$ST" "$B/.restore-list"',
        'if [ "$NR" = "1" ] && [ "' + (restartNodeRed ? '1' : '0') + '" = "1" ]; then ( sleep 5; for s in /service/node-red*; do svc -t "$s"; done ) >/dev/null 2>&1 & echo "@@RESTART Node-RED restarts in 5 s"; fi',
        'echo "@@DONE ' + name + '"',
        'list_backups'
    ].join('\n');
}

function parseScriptOutput(rawText) {
    const result = {
        user: '',
        disk: null,
        backups: [],
        created: '',
        safety: '',
        error: '',
        done: '',
        deleted: '',
        restart: '',
        drivers: [],
        included: [],
        restored: [],
        failed: [],
        skipped: [],
        log: []
    };

    String(rawText || '').split(/\r?\n/).forEach(line => {
        if (!line.trim()) {
            return;
        }
        if (line.startsWith('@@B\t')) {
            const parts = line.split('\t');
            const name = parts[3] || '';
            result.backups.push({
                name,
                size: Number(parts[1]) || 0,
                date: parts[2] || '',
                kind: name.startsWith('pre-restore-') ? 'safety' : (name.startsWith('uploaded-') ? 'uploaded' : 'backup')
            });
            return;
        }

        const match = line.match(/^@@([A-Z]+) ?(.*)$/);
        if (!match) {
            result.log.push(line);
            return;
        }

        const value = match[2].trim();
        switch (match[1]) {
            case 'USER': result.user = value; break;
            case 'DF': {
                const parts = value.split(/\s+/);
                if (parts.length >= 6 && Number(parts[1]) > 0) {
                    result.disk = {
                        totalText: formatBytes(Number(parts[1]) * 1024),
                        usedText: formatBytes(Number(parts[2]) * 1024),
                        availableText: formatBytes(Number(parts[3]) * 1024),
                        usePct: parseInt(parts[4], 10) || 0
                    };
                }
                break;
            }
            case 'CREATED': result.created = value; break;
            case 'SAFETY': result.safety = value; break;
            case 'ERROR': result.error = value; break;
            case 'DONE': result.done = value; break;
            case 'DELETED': result.deleted = value; break;
            case 'RESTART': result.restart = value; break;
            case 'DRIVER': result.drivers.push(value); break;
            case 'INCLUDED': result.included.push(value); break;
            case 'RESTORED': result.restored.push(value); break;
            case 'FAILED': result.failed.push(value); break;
            case 'SKIP':
            case 'SKIPPED': result.skipped.push(value); break;
            case 'LOG': result.log.push(value); break;
            default: result.log.push(line);
        }
    });

    result.backups.sort((a, b) => (b.date + b.name).localeCompare(a.date + a.name));
    return result;
}

function getState() {
    return flow.get(STATE_KEY) || {
        backups: [],
        disk: null,
        user: '',
        busy: '',
        busySince: 0,
        result: null,
        updatedAt: ''
    };
}

function emit(state, execPayload, action) {
    state.updatedAt = new Date().toISOString();
    flow.set(STATE_KEY, state);

    const view = Object.assign({}, state, {
        backups: state.backups.map(backup => Object.assign({}, backup, { sizeText: formatBytes(backup.size) })),
        contents: BACKUP_PATHS.map(path => ({ path: '/' + path, label: BACKUP_LABELS[path] || path }))
    });

    return [
        { topic: 'backup-state', payload: view },
        execPayload ? { topic: 'backup-exec', backupAction: action, payload: shellQuote(execPayload) } : null
    ];
}

let state = getState();
const nowTs = Date.now();

if (state.busy && nowTs - (Number(state.busySince) || 0) > BUSY_TIMEOUT_MS) {
    state.busy = '';
}

if (msg.topic === 'backup-exec') {
    const parsed = parseScriptOutput(msg.payload);
    const action = msg.backupAction || 'refresh';

    state.backups = parsed.backups;
    state.disk = parsed.disk || state.disk;
    state.user = parsed.user || state.user;
    state.busy = '';

    if (action !== 'refresh' || parsed.error) {
        let message;
        if (parsed.error) {
            message = ({ restore: 'Restore failed: ', create: 'Backup failed: ', delete: 'Delete failed: ' }[action] || 'Error: ') + parsed.error;
        }
        else if (action === 'create') {
            message = 'Backup created: ' + parsed.created + ' (' + parsed.included.length + ' item(s)). Download it and keep it off the device.';
        }
        else if (action === 'delete') {
            message = 'Deleted ' + parsed.deleted + '.';
        }
        else {
            message = 'Restored ' + parsed.restored.length + ' item(s) from ' + parsed.done
                + (parsed.failed.length ? ', FAILED: ' + parsed.failed.length : '')
                + '. Safety backup: ' + parsed.safety + '.'
                + (parsed.restart ? ' ' + parsed.restart + '.' : '')
                + (parsed.drivers.length ? ' Drivers enabled: ' + parsed.drivers.join(', ') + ' - reboot the GX device to start them.' : '')
                + (parsed.restored.indexOf(VENUS_SETTINGS_PATH) >= 0 ? ' Reboot the GX device to apply Venus OS settings.' : '');
        }

        state.result = {
            ok: !parsed.error && parsed.failed.length === 0,
            action,
            message,
            at: new Date().toISOString(),
            included: parsed.included,
            restored: parsed.restored,
            failed: parsed.failed,
            skipped: parsed.skipped,
            log: parsed.log.slice(0, 40)
        };
    }

    return emit(state, null, action);
}

if (msg.topic === 'backup-uploaded') {
    const name = msg.payload && msg.payload.name ? String(msg.payload.name) : '';
    state.result = {
        ok: true,
        action: 'upload',
        message: 'Uploaded ' + name + '. Select it below to restore.',
        at: new Date().toISOString(),
        included: [], restored: [], failed: [], skipped: [], log: []
    };
    return emit(state, buildRefreshScript(), 'refresh');
}

if (msg.topic === 'backup-command' && msg.payload && typeof msg.payload === 'object') {
    const action = String(msg.payload.action || 'refresh');

    if (action === 'refresh') {
        return emit(state, buildRefreshScript(), 'refresh');
    }

    if (state.busy) {
        state.result = { ok: false, action, message: 'Busy: ' + state.busy + ' is still running.', at: new Date().toISOString(), included: [], restored: [], failed: [], skipped: [], log: [] };
        return emit(state, null, action);
    }

    if (action === 'create') {
        state.busy = 'backup';
        state.busySince = nowTs;
        state.result = { ok: true, action, message: 'Creating backup...', at: new Date().toISOString(), included: [], restored: [], failed: [], skipped: [], log: [] };
        return emit(state, buildCreateScript(), 'create');
    }

    if (action === 'delete') {
        const name = String(msg.payload.name || '');

        if (!NAME_PATTERN.test(name) || !state.backups.some(backup => backup.name === name)) {
            state.result = { ok: false, action, message: 'Backup not in the list: ' + name, at: new Date().toISOString(), included: [], restored: [], failed: [], skipped: [], log: [] };
            return emit(state, null, action);
        }

        state.busy = 'delete';
        state.busySince = nowTs;
        state.result = { ok: true, action, message: 'Deleting ' + name + '...', at: new Date().toISOString(), included: [], restored: [], failed: [], skipped: [], log: [] };
        return emit(state, buildDeleteScript(name), 'delete');
    }

    if (action === 'restore') {
        const name = String(msg.payload.name || '');
        const reject = message => {
            state.result = { ok: false, action, message, at: new Date().toISOString(), included: [], restored: [], failed: [], skipped: [], log: [] };
            return emit(state, null, action);
        };

        if (!NAME_PATTERN.test(name) || !state.backups.some(backup => backup.name === name)) {
            return reject('Select a backup from the list first.');
        }
        if (String(msg.payload.confirm || '').trim() !== 'RESTORE') {
            return reject('Type RESTORE in the confirmation field to start the restore.');
        }

        state.busy = 'restore';
        state.busySince = nowTs;
        state.result = { ok: true, action, message: 'Restoring ' + name + ' (safety backup first)...', at: new Date().toISOString(), included: [], restored: [], failed: [], skipped: [], log: [] };
        return emit(state, buildRestoreScript(
            name,
            Boolean(msg.payload.restoreVenusSettings),
            msg.payload.restartNodeRed !== false,
            msg.payload.enableDrivers !== false
        ), 'restore');
    }
}

// Dashboard connect or any other trigger: refresh the list.
return emit(state, buildRefreshScript(), 'refresh');
