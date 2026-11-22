//! Node 26: Parse script output and build the backup dashboard view.
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
