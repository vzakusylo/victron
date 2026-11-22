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
// - data/home/nodered/tools                 tool scripts run on the GX (d#181)
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
//    Dated mail also includes air (UTC), temperatures and sensor events (Oslo days). Optional
//    files may be omitted to fit the 18 MiB limit; the mail lists those omissions.
//    The archive is deleted after sending. Weekly: topic `backup-mail-tick` (inject every 15 min)
//    sends the last 7 days when Monday 07:00 Europe/Oslo has passed; a failed send is retried
//    every hour, at most MAIL_TRIES times, then the next Monday. Busy -> the next tick.
// ==========================

// NR9: backup helpers are included at build time.
const BACKUP_DIR = '/data/home/nodered/grid-control-backups';
const MANIFEST_PATH = 'data/home/nodered/grid-control-config/backup-manifest.txt';
const NODE_RED_DIR = 'data/home/nodered/.node-red';
const TOOLS_DIR = 'data/home/nodered/tools';
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
    // d#181: scripts run by exec nodes and by settings-user.js (tools/victron-secrets.js), and the deploy /
    // check scripts in tools/gx. Without them a restored Node-RED cannot load its file secrets.
    TOOLS_DIR,
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
    'data/home/nodered/tools': 'Tool scripts (sensors, mail, secrets loader, deploy / check)',
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
const DROP_RETRIES = 3;   // single-file repacks after a short size estimate, before the rest of a set is left out

// #include lib/backup/mail-schedule.js

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
// #include lib/backup/archive-scripts.js

// #include lib/backup/mail-scripts.js

// #include lib/backup/view.js

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
