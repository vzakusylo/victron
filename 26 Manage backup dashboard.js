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
// 4. GNU tar also skips `supervise` folders (daemontools runtime state, root-only) at any depth.
// 5. Also backs up /data/grid-control-logperm.sh (makes driver logs readable for the Driver page).
// 6. Data archive by e-mail (d#146): action `mail` packs the energy and heating data of the last
//    `days` days (7 / 31, or 0 = all of grid-control-logs) into /tmp/grid-data-*.tar.gz and mails it
//    with tools/send-mail.js to the address in grid-control-config/email.json (same as the heat
//    pump alerts). Included per UTC day: heatpump/<day>/ (recorder), automations/<day>.jsonl,
//    energy-<day>.log, grid-control-<day>.log, heatpump-<day>.log; per month: energy-<month>.csv.
//    The archive is deleted after sending. Weekly: topic `backup-mail-tick` (inject every 15 min)
//    sends the last 7 days when Monday 07:00 Europe/Oslo has passed; a failed send is retried
//    every hour, at most MAIL_TRIES times, then the next Monday. Busy -> the next tick.
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
    'data/grid-control-logperm.sh',
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
    'data/grid-control-logperm.sh': 'Driver-log read permission helper (started from rc.local)',
    'data/conf/settings.xml': 'Venus OS settings (optional on restore)'
};
const NAME_PATTERN = /^[A-Za-z0-9._-]+\.tar\.gz$/;
const BUSY_TIMEOUT_MS = 15 * 60 * 1000;
const STATE_KEY = 'backupDashboardState';

// Data archive by e-mail
const LOGS_PARENT = '/data/home/nodered';
const MAIL_TOOL = '/data/home/nodered/tools/send-mail.js';
const MAIL_TZ = 'Europe/Oslo';
const MAIL_WEEKDAY = 1;            // Monday
const MAIL_HOUR = 7;               // 07:00 local time
const MAIL_DAYS_AUTO = 7;
const MAIL_DAYS_ALLOWED = [7, 31, 0];
const MAIL_TRIES = 3;
const MAIL_RETRY_MS = 60 * 60 * 1000;
const MAIL_MAX_BYTES = 18 * 1024 * 1024;

const pad2 = n => String(n).padStart(2, '0');

// Wall-clock parts of `ts` in MAIL_TZ (the GX itself runs in UTC).
function zoneParts(ts) {
    const parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: MAIL_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(ts)).forEach(p => { parts[p.type] = p.value; });
    return { y: Number(parts.year), mo: Number(parts.month) - 1, d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute) };
}

function zoneText(ts) {
    const p = zoneParts(ts);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay()];
    return wd + ' ' + p.y + '-' + pad2(p.mo + 1) + '-' + pad2(p.d) + ' ' + pad2(p.h) + ':' + pad2(p.mi);
}

// The first Monday 07:00 (MAIL_TZ) strictly after `ts`.
function nextMailDue(ts) {
    const p = zoneParts(ts);
    for (let k = 0; k <= 7; k += 1) {
        const day = new Date(Date.UTC(p.y, p.mo, p.d + k));
        if (day.getUTCDay() !== MAIL_WEEKDAY) {
            continue;
        }
        const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), MAIL_HOUR, 0);
        const z = zoneParts(wall);
        const offset = Date.UTC(z.y, z.mo, z.d, z.h, z.mi) - wall;     // zone offset at that moment
        const due = wall - offset;
        if (due > ts) {
            return due;
        }
    }
    return ts + 7 * 24 * 3600 * 1000;
}

function mailState(state) {
    state.mail = Object.assign({ dueAt: 0, tries: 0, lastAt: 0, lastOk: null, lastText: '', lastAuto: false }, state.mail || {});
    return state.mail;
}

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
        // GNU tar (Venus OS): skip daemontools runtime folders (`supervise`, root-only) at any depth.
        // BusyBox tar has no --exclude, so the option is only passed to GNU tar.
        '  EX=""; tar --version 2>/dev/null | grep -q GNU && EX="--exclude=supervise --exclude=lost+found"',
        '  tar -czf "$B/$NAME.part" $EX -C "$R/" $L 2>"$B/.tar-errors"',
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

// Packs the energy / heating data of the last `days` UTC days (0 = all of grid-control-logs) and mails it.
function buildMailScript(days, auto, nowTs) {
    const dayList = [];
    const months = [];
    for (let k = days; days > 0 && k >= 0; k -= 1) {
        const d = new Date(nowTs - k * 24 * 3600 * 1000).toISOString();
        dayList.push(d.slice(0, 10));
        if (months.indexOf(d.slice(0, 7)) < 0) {
            months.push(d.slice(0, 7));
        }
    }
    const stamp = new Date(nowTs).toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
    const period = days > 0 ? dayList[0] + ' … ' + dayList[dayList.length - 1] + ' (UTC days)' : 'all history';
    const name = 'grid-data-' + stamp + (days > 0 ? '-' + days + 'd' : '-all') + '.tar.gz';
    const mail = {
        subject: 'Cerbo GX data archive: ' + (days > 0 ? 'last ' + days + ' days' : 'all history') + ' (' + zoneText(nowTs).slice(4, 14) + ')',
        text: [
            (auto ? 'Weekly' : 'Requested') + ' archive of the energy and heating data of the Cerbo GX.',
            'Period: ' + period + '.',
            '',
            'Contents (grid-control-logs/):',
            '- energy-YYYY-MM.csv: energy history per hour (grid, battery, PV, tariff tier)',
            '- heatpump/YYYY-MM-DD/HH.csv(.gz): heat pump recorder, values per change',
            '- automations/YYYY-MM-DD.jsonl: automation log (heat pump rules, DHW controller, errors)',
            '- grid-control-YYYY-MM-DD.log, heatpump-YYYY-MM-DD.log, energy-YYYY-MM-DD.log: daily logs where present',
            '',
            'This is a data copy only. A full device backup (settings, flows, drivers) is made on the Backup tab.'
        ].join('\n')
    };
    const lines = [
        'T="/tmp/' + name + '"; M="/tmp/grid-data-mail.json"; G="grid-control-logs"',
        'cd "' + LOGS_PARENT + '" || fail "Cannot open ' + LOGS_PARENT + '"',
        'L=""',
        'addm() { [ -e "$1" ] && L="$L $1"; return 0; }'
    ];
    if (days > 0) {
        lines.push('for d in ' + dayList.join(' ') + '; do addm "$G/heatpump/$d"; addm "$G/automations/$d.jsonl"; addm "$G/energy-$d.log"; addm "$G/grid-control-$d.log"; addm "$G/heatpump-$d.log"; done');
        lines.push('for m in ' + months.join(' ') + '; do addm "$G/energy-$m.csv"; done');
    }
    else {
        lines.push('addm "$G"');
    }
    lines.push(
        '[ -n "$L" ] || fail "No data files found for ' + period + '"',
        'rm -f /tmp/grid-data-*.tar.gz',
        // the recorder may append to the current hour while tar reads it ("file changed"): the archive is still valid
        'tar -czf "$T" $L 2>/dev/null; tar -tzf "$T" >/dev/null 2>&1 || { rm -f "$T"; fail "Data archive could not be created"; }',
        'SZ=$(wc -c < "$T"); echo "@@MAILSIZE $SZ"; echo "@@MAILFILES $(tar -tzf "$T" | grep -c -v /$)"',
        '[ "$SZ" -le ' + MAIL_MAX_BYTES + ' ] || { rm -f "$T"; fail "Data archive is too large for e-mail: $SZ bytes. Use a shorter period or the Download of a full backup."; }',
        "cat > \"$M\" <<'GRID_MAIL_EOF'",
        JSON.stringify(mail),
        'GRID_MAIL_EOF',
        'R=$(node ' + MAIL_TOOL + ' --file "$M" --attach "$T" 2>&1 | tail -n 1)',
        'rm -f "$T" "$M"',
        'echo "@@MAIL $R"',
        'echo "@@MAILNAME ' + name + '"',
        'list_backups'
    );
    return scriptPrelude() + '\n' + lines.join('\n');
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
        log: [],
        mail: null,
        mailSize: 0,
        mailFiles: 0,
        mailName: ''
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
            case 'MAIL':
                try { result.mail = JSON.parse(value); } catch (e) { result.mail = { ok: false, error: value || 'no answer from send-mail.js' }; }
                break;
            case 'MAILSIZE': result.mailSize = Number(value) || 0; break;
            case 'MAILFILES': result.mailFiles = Number(value) || 0; break;
            case 'MAILNAME': result.mailName = value; break;
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

function emit(state, execPayload, action, extra) {
    state.updatedAt = new Date().toISOString();
    flow.set(STATE_KEY, state);
    const mail = mailState(state);

    const view = Object.assign({}, state, {
        backups: state.backups.map(backup => Object.assign({}, backup, { sizeText: formatBytes(backup.size) })),
        contents: BACKUP_PATHS.map(path => ({ path: '/' + path, label: BACKUP_LABELS[path] || path })),
        mail: Object.assign({}, mail, {
            nextText: mail.dueAt ? zoneText(mail.dueAt) + (mail.tries ? ' (retry ' + mail.tries + ' of ' + MAIL_TRIES + ')' : '') : '',
            lastAtText: mail.lastAt ? zoneText(mail.lastAt) : ''
        })
    });

    return [
        { topic: 'backup-state', payload: view },
        execPayload ? Object.assign({ topic: 'backup-exec', backupAction: action, payload: shellQuote(execPayload) }, extra || {}) : null
    ];
}

function startMail(state, days, auto) {
    state.busy = 'mail';
    state.busySince = nowTs;
    state.result = { ok: true, action: 'mail', message: 'Packing and mailing the data archive (' + (days > 0 ? 'last ' + days + ' days' : 'all history') + ')...', at: new Date().toISOString(), included: [], restored: [], failed: [], skipped: [], log: [] };
    return emit(state, buildMailScript(days, auto, nowTs), 'mail', { mailAuto: auto, mailDays: days });
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

    if (action === 'mail') {
        const mail = mailState(state);
        const days = Number(msg.mailDays) || 0;
        const ok = Boolean(!parsed.error && parsed.mail && parsed.mail.ok);
        const what = (days > 0 ? 'last ' + days + ' days' : 'all history') + ', ' + parsed.mailFiles + ' file(s), ' + formatBytes(parsed.mailSize);
        const error = parsed.error || (parsed.mail ? parsed.mail.error : '') || 'no answer from the mail script';
        mail.lastAt = nowTs;
        mail.lastOk = ok;
        mail.lastAuto = Boolean(msg.mailAuto);
        mail.lastText = ok ? 'sent: ' + what : 'failed: ' + error;
        if (msg.mailAuto) {
            if (ok || mail.tries + 1 >= MAIL_TRIES) {
                mail.tries = 0;
                mail.dueAt = nextMailDue(nowTs);
            }
            else {
                mail.tries += 1;
                mail.dueAt = nowTs + MAIL_RETRY_MS;
            }
        }
        state.result = {
            ok,
            action,
            message: ok ? 'Data archive mailed (' + what + ').' : 'Data archive mail failed: ' + error,
            at: new Date().toISOString(),
            included: [], restored: [], failed: [], skipped: [],
            log: parsed.log.slice(0, 40)
        };
        if (!ok) {
            node.warn('data archive mail failed: ' + error);
        }
        return emit(state, null, action);
    }

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

if (msg.topic === 'backup-mail-tick') {
    const mail = mailState(state);
    if (!mail.dueAt) {
        mail.dueAt = nextMailDue(nowTs);
        return emit(state, null, 'refresh');
    }
    if (nowTs < mail.dueAt || state.busy) {
        flow.set(STATE_KEY, state);
        return null;
    }
    return startMail(state, MAIL_DAYS_AUTO, true);
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

    if (action === 'mail') {
        const days = Number(msg.payload.days);
        return startMail(state, MAIL_DAYS_ALLOWED.indexOf(days) >= 0 ? days : MAIL_DAYS_AUTO, false);
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
