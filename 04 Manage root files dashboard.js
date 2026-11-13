// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `04 Manage root files dashboard.js` and the embedded `func` for "Manage root files dashboard"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Read-only handler of the Files page: lists the log files with sizes and disk usage,
//   shows the selected file and remembers the selection in a JSON config file.
// Config / paths:
// - Config : /data/home/nodered/grid-control-config/files-dashboard-state.json
// - Logs   : /data/home/nodered/grid-control-logs/
// Input (msg.topic):
// - `load-root-files-ui-state-request` (dashboard opened), `files-refresh` -> rescan the folder
// - `load-root-files-ui-state` (exec: the saved selection)                  -> restore it, rescan
// - `root-files-nav` { action: prev | next | select | select-section | refresh, index }
// - `root-files-list` / `root-file-content` (exec stdout)                   -> list / file text
// Outputs (6):
// - 1 summary text, 2 file list, 3 file content, 4 exec "list files", 5 exec "read file",
//   6 file node that stores the selection
// Change notes:
// 1. Initial version.
// 2. Fixed the folder regex (`//+$/` was parsed as a comment, so the node never compiled).
//    Exec commands are now single-quoted for `sh -c` (the exec nodes run `sh -c <payload>`).
//    The list command also reports disk usage (`df -Pk`), the logs folder size (`du -sk`) and
//    each file's size; the panel shows used / free space. Output that lacks the `@@FILES`
//    marker (e.g. stray stderr) is ignored. Opening the dashboard always rescans the folder
//    and keeps the selected file. Removed the duplicate folder section.
// 3. `.gz` files are unpacked for the preview, a plain-file preview is cut at 512 KB, the file path is
//    shell-quoted, and the state file stores only the selection (it used to hold a copy of the
//    whole selected file and the file list, rewritten on every click).
// ==========================
const ROOT_PATH = '/data/home/nodered/grid-control-logs';
const CONFIG_PATH = '/data/home/nodered/grid-control-config/files-dashboard-state.json';
const MAX_PREVIEW_KB = 512;
const FOLDER_SECTIONS = [
    '/data/home/nodered/grid-control-logs'
];
const LIST_SCRIPT = [
    'echo "@@DF"',
    'df -Pk "' + ROOT_PATH + '" 2>/dev/null | tail -n 1',
    'echo "@@DU"',
    'du -sk "' + ROOT_PATH + '" 2>/dev/null',
    'echo "@@FILES"',
    'find "' + ROOT_PATH + '" -type f 2>/dev/null | sort | while IFS= read -r f; do printf "%s\\t%s\\n" "$(wc -c < "$f")" "$f"; done'
].join('; ');

// The exec nodes run `sh -c <payload>`, so the whole script must be one shell word.
function shellQuote(script) {
    return "'" + String(script).replace(/'/g, "'\\''") + "'";
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

function parseListOutput(rawText) {
    const disk = { totalKb: 0, usedKb: 0, availableKb: 0, usePct: 0, mount: '', logsKb: 0, valid: false };
    const files = [];
    let section = '';

    String(rawText || '').split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }
        if (trimmed === '@@DF' || trimmed === '@@DU' || trimmed === '@@FILES') {
            section = trimmed;
            return;
        }
        if (section === '@@DF') {
            // Filesystem 1024-blocks Used Available Capacity Mounted-on
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 6 && Number.isFinite(Number(parts[1]))) {
                disk.totalKb = Number(parts[1]) || 0;
                disk.usedKb = Number(parts[2]) || 0;
                disk.availableKb = Number(parts[3]) || 0;
                disk.usePct = parseInt(parts[4], 10) || 0;
                disk.mount = parts.slice(5).join(' ');
                disk.valid = disk.totalKb > 0;
            }
        }
        else if (section === '@@DU') {
            disk.logsKb = Number(trimmed.split(/\s+/)[0]) || 0;
        }
        else if (section === '@@FILES') {
            const tabIndex = line.indexOf('\t');
            const path = (tabIndex >= 0 ? line.substring(tabIndex + 1) : line).trim();
            if (path) {
                files.push({
                    path,
                    name: path.split('/').pop() || path,
                    size: tabIndex >= 0 ? Number(line.substring(0, tabIndex).trim()) || 0 : 0
                });
            }
        }
    });

    return { disk, files };
}

function buildDiskView(disk, files) {
    const logsBytes = disk && disk.logsKb
        ? disk.logsKb * 1024
        : files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);

    if (!disk || !disk.valid) {
        return { valid: false, logsText: formatBytes(logsBytes), fileCount: files.length };
    }

    return {
        valid: true,
        mount: disk.mount,
        usePct: disk.usePct,
        totalText: formatBytes(disk.totalKb * 1024),
        usedText: formatBytes(disk.usedKb * 1024),
        availableText: formatBytes(disk.availableKb * 1024),
        logsText: formatBytes(logsBytes),
        fileCount: files.length,
        level: disk.usePct >= 90 ? 'critical' : (disk.usePct >= 75 ? 'warning' : 'ok')
    };
}

function byteSize(rawText) {
    if (typeof rawText !== 'string' || !rawText.length) {
        return 0;
    }

    return typeof Buffer !== 'undefined'
        ? Buffer.byteLength(rawText, 'utf8')
        : rawText.length;
}

function normalizeFolder(path) {
    return String(path || '').replace(/\/+$/, '');
}

function sanitizeFile(file) {
    if (!file || typeof file !== 'object') {
        return null;
    }

    const path = typeof file.path === 'string' ? file.path.trim() : '';
    if (!path) {
        return null;
    }

    return {
        path,
        name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : (path.split('/').pop() || path),
        size: Number(file.size) || 0
    };
}

function normalizeLoadedState(rawState) {
    if (!rawState || typeof rawState !== 'object') {
        return null;
    }

    const files = Array.isArray(rawState.files)
        ? rawState.files.map(sanitizeFile).filter(Boolean)
        : [];
    const requestedPath = typeof rawState.selectedPath === 'string' ? rawState.selectedPath.trim() : '';
    let selectedIndex = Number.isInteger(rawState.selectedIndex) ? rawState.selectedIndex : -1;

    if (requestedPath) {
        const matchedIndex = files.findIndex(file => file.path === requestedPath);
        if (matchedIndex >= 0) {
            selectedIndex = matchedIndex;
        }
    }

    if (!(selectedIndex >= 0 && selectedIndex < files.length)) {
        selectedIndex = files.length ? 0 : 0;
    }

    const rawContent = rawState.content && typeof rawState.content === 'object' ? rawState.content : {};
    const rawText = typeof rawContent.rawText === 'string' ? rawContent.rawText : '';
    const rawStatus = typeof rawContent.status === 'string' ? rawContent.status : 'idle';
    const contentStatus = (rawStatus === 'loading' || rawStatus === 'loading-list')
        ? (rawText ? 'loaded' : (files.length ? 'idle' : 'empty'))
        : rawStatus;
    const contentPath = typeof rawContent.path === 'string' && rawContent.path.trim() ? rawContent.path.trim() : (files[selectedIndex] ? files[selectedIndex].path : ROOT_PATH);

    return {
        files,
        selectedIndex,
        content: {
            path: contentPath,
            name: typeof rawContent.name === 'string' && rawContent.name.trim() ? rawContent.name.trim() : (contentPath.split('/').pop() || ''),
            status: contentStatus,
            fileSize: Number(rawContent.fileSize) || 0,
            rawText
        }
    };
}

function getState() {
    const files = Array.isArray(flow.get('dashboardRootFiles')) ? flow.get('dashboardRootFiles') : [];
    const selectedIndex = Math.max(0, Number(flow.get('dashboardRootFileIndex')) || 0);
    const content = flow.get('dashboardRootFileContent') || {
        path: ROOT_PATH,
        name: '',
        status: 'idle',
        fileSize: 0,
        rawText: ''
    };
    const disk = flow.get('dashboardRootDisk') || null;

    return { files, selectedIndex, content, disk };
}

function saveState(state) {
    flow.set('dashboardRootFiles', state.files);
    flow.set('dashboardRootFileIndex', state.selectedIndex);
    flow.set('dashboardRootFileContent', state.content);
    flow.set('dashboardRootDisk', state.disk || null);
}

function buildPersistMsg(state) {
    const selectedFile = state.files[state.selectedIndex] || null;
    return {
        filename: CONFIG_PATH,
        // Only the selection: the file list is rescanned and the content re-read on every open.
        payload: JSON.stringify({
            selectedPath: selectedFile ? selectedFile.path : '',
            content: { path: state.content.path, name: state.content.name },
            updatedAt: new Date().toISOString()
        }, null, 2),
        encoding: 'utf8'
    };
}

function buildOutputs(state, listMsg, readMsg, persistMsg) {
    const selectedFile = state.files[state.selectedIndex] || null;
    const status = state.content.status || 'idle';
    const diskView = buildDiskView(state.disk, state.files);
    const diskText = diskView.valid
        ? ' | Disk ' + diskView.mount + ' used ' + diskView.usedText + ' of ' + diskView.totalText + ' (' + diskView.usePct + '%), free ' + diskView.availableText
        : '';
    const summary = 'Files ' + state.files.length + ' (' + diskView.logsText + ') | Selected ' + (selectedFile ? selectedFile.name : 'none') + ' | Status ' + status + ' | Size ' + formatBytes(state.content.fileSize || 0) + diskText;

    const folderSections = FOLDER_SECTIONS.map((folderPath, sectionIndex) => {
        const normalized = normalizeFolder(folderPath);
        const sectionFiles = state.files.filter(file => file.path === normalized || file.path.startsWith(normalized + '/'));
        const selectedInSection = selectedFile && (selectedFile.path === normalized || selectedFile.path.startsWith(normalized + '/'));

        return {
            index: sectionIndex,
            path: folderPath,
            count: sectionFiles.length,
            selected: Boolean(selectedInSection),
            firstIndex: sectionFiles.length ? state.files.indexOf(sectionFiles[0]) : -1
        };
    });

    const listPayload = {
        rootPath: ROOT_PATH,
        count: state.files.length,
        status,
        selectedIndex: selectedFile ? state.selectedIndex : -1,
        selectedName: selectedFile ? selectedFile.name : '',
        selectedPath: selectedFile ? selectedFile.path : '',
        canPrev: status !== 'loading-list' && state.selectedIndex > 0,
        canNext: status !== 'loading-list' && state.selectedIndex >= 0 && state.selectedIndex < state.files.length - 1,
        isLoading: status === 'loading-list' || status === 'loading',
        folderSections,
        disk: diskView,
        files: state.files.map((file, index) => ({
            index,
            name: file.name,
            path: file.path,
            sizeText: formatBytes(file.size),
            selected: index === state.selectedIndex
        }))
    };

    const rawPayload = {
        fileName: state.content.path || (selectedFile ? selectedFile.path : ROOT_PATH),
        status,
        fileSize: state.content.fileSize || 0,
        rawText: state.content.rawText || ''
    };

    return [
        { payload: summary },
        { payload: listPayload },
        { payload: rawPayload },
        listMsg || null,
        readMsg || null,
        persistMsg || null
    ];
}

function startListReload(state) {
    // Remember the selected file so the rescan re-selects it.
    const selectedFile = state.files[state.selectedIndex] || null;
    const keepPath = selectedFile ? selectedFile.path : (state.content && state.content.path) || ROOT_PATH;

    state.files = [];
    state.selectedIndex = 0;
    state.content = {
        path: keepPath,
        name: '',
        status: 'loading-list',
        fileSize: 0,
        rawText: ''
    };
    saveState(state);

    return buildOutputs(state, {
        topic: 'root-files-list',
        payload: shellQuote(LIST_SCRIPT)
    }, null, buildPersistMsg(state));
}

// Prints at most MAX_PREVIEW_KB of a plain file (`dd`: BusyBox on the GX has no `head -c`);
// `.gz` files (heat pump hours, a few KB) are unpacked in full.
// The path is quoted as a shell word, so a file name can never run as a command.
function buildReadMsg(selectedFile) {
    const file = selectedFile ? shellQuote(selectedFile.path) : '';
    const reader = selectedFile && /\.gz$/.test(selectedFile.path)
        ? 'gzip -dc ' + file
        : 'dd if=' + file + ' bs=1024 count=' + MAX_PREVIEW_KB;
    return selectedFile ? {
        topic: 'root-file-content',
        payload: shellQuote(reader + ' 2>/dev/null'),
        filePath: selectedFile.path,
        fileName: selectedFile.name
    } : null;
}

let state = getState();

if (msg.topic === 'load-root-files-ui-state-request') {
    // Dashboard opened: always rescan so the list and disk usage are current.
    return startListReload(state);
}

if (msg.topic === 'load-root-files-ui-state' || msg.execNode === 'Read root files UI state file') {
    const rawText = typeof msg.payload === 'string' ? msg.payload.trim() : '';

    if (!rawText) {
        return startListReload(state);
    }

    try {
        const parsed = JSON.parse(rawText);
        const loadedState = normalizeLoadedState(parsed);
        if (loadedState) {
            // Keep the persisted selection, but rescan: the stored list may be stale.
            loadedState.disk = state.disk;
            return startListReload(loadedState);
        }
    }
    catch (error) {
    }

    return startListReload(state);
}

if (msg.topic === 'files-refresh') {
    return startListReload(state);
}

if (msg.topic === 'root-files-nav') {
    const action = msg.payload && msg.payload.action;

    if (action === 'refresh' || !state.files.length) {
        return startListReload(state);
    }

    if (action === 'prev') {
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
    }
    else if (action === 'next') {
        state.selectedIndex = Math.min(state.files.length - 1, state.selectedIndex + 1);
    }
    else if (action === 'select') {
        const requestedIndex = Number(msg.payload && msg.payload.index);
        if (Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < state.files.length) {
            state.selectedIndex = requestedIndex;
        }
    }
    else if (action === 'select-section') {
        const requestedIndex = Number(msg.payload && msg.payload.index);
        const folderPath = FOLDER_SECTIONS[requestedIndex];
        const normalized = normalizeFolder(folderPath);
        const firstIndex = state.files.findIndex(file => file.path === normalized || file.path.startsWith(normalized + '/'));
        if (firstIndex >= 0) {
            state.selectedIndex = firstIndex;
        }
    }

    const selectedFile = state.files[state.selectedIndex] || null;
    state.content = {
        path: selectedFile ? selectedFile.path : ROOT_PATH,
        name: selectedFile ? selectedFile.name : '',
        status: selectedFile ? 'loading' : 'empty',
        fileSize: 0,
        rawText: ''
    };
    saveState(state);

    return buildOutputs(state, null, buildReadMsg(selectedFile), buildPersistMsg(state));
}

if (msg.topic === 'root-files-list') {
    const rawText = String(msg.payload || '');

    // stdout always carries the markers; anything else (e.g. stderr) must not wipe the list.
    if (rawText.indexOf('@@FILES') < 0) {
        return null;
    }

    const parsed = parseListOutput(rawText);
    const files = parsed.files;

    state.files = files;
    state.disk = parsed.disk;

    const currentPath = state.content && typeof state.content.path === 'string' ? state.content.path : '';
    const matchedIndex = currentPath ? state.files.findIndex(file => file.path === currentPath) : -1;
    state.selectedIndex = matchedIndex >= 0 ? matchedIndex : (files.length ? 0 : 0);

    const selectedFile = state.files[state.selectedIndex] || null;
    state.content = {
        path: selectedFile ? selectedFile.path : ROOT_PATH,
        name: selectedFile ? selectedFile.name : '',
        status: selectedFile ? 'loading' : 'empty',
        fileSize: 0,
        rawText: ''
    };
    saveState(state);

    return buildOutputs(state, null, buildReadMsg(selectedFile), buildPersistMsg(state));
}

if (msg.topic === 'root-file-content') {
    const rawText = typeof msg.payload === 'string' ? msg.payload : '';
    const selectedFile = state.files[state.selectedIndex] || null;
    state.content = {
        path: msg.filePath || (selectedFile ? selectedFile.path : ROOT_PATH),
        name: msg.fileName || (selectedFile ? selectedFile.name : ''),
        status: rawText ? 'loaded' : 'empty',
        fileSize: byteSize(rawText),
        rawText
    };
    saveState(state);

    return buildOutputs(state, null, null, buildPersistMsg(state));
}

return buildOutputs(state, null, null, null);