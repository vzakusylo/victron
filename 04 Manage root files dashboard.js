// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `04 Manage root files dashboard.js` and the embedded `func` for "Manage root files dashboard"
//   in `flows.json` must always stay synchronized.
// Purpose:
// - Full file-management handler for the root-files dashboard panel.
// - Lists, previews, deletes and refreshes log files in configured folder sections.
// - Persists expanded/selected UI state to a JSON config file.
// Config / paths:
// - Config : /data/home/nodered/grid-control-config/files-dashboard-state.json
// - Logs   : /data/home/nodered/grid-control-logs/
// Input (msg.topic):
// - `load-root-files-ui-state-request` -> load persisted UI state + send file list
// - `root-files-toggle-section`         -> toggle a folder section expanded/collapsed
// - `root-files-select-file`            -> select file and preview its content
// - `root-files-delete-file`            -> delete file and refresh list
// - `root-files-refresh`                -> re-scan folders and send updated list
// Output (1):
// - output 1 -> dashboard UI payload for the root-files panel
// Change notes:
// 1. Initial version.
// ==========================
const ROOT_PATH = '/data/home/nodered/grid-control-logs';
const CONFIG_PATH = '/data/home/nodered/grid-control-config/files-dashboard-state.json';
const FOLDER_SECTIONS = [
    '/data/home/nodered/grid-control-logs',
    '/data/home/nodered/grid-control-logs/'
];

function byteSize(rawText) {
    if (typeof rawText !== 'string' || !rawText.length) {
        return 0;
    }

    return typeof Buffer !== 'undefined'
        ? Buffer.byteLength(rawText, 'utf8')
        : rawText.length;
}

function normalizeFolder(path) {
    return String(path || '').replace(//+$/, '');
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
        name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : (path.split('/').pop() || path)
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

    return { files, selectedIndex, content };
}

function saveState(state) {
    flow.set('dashboardRootFiles', state.files);
    flow.set('dashboardRootFileIndex', state.selectedIndex);
    flow.set('dashboardRootFileContent', state.content);
}

function buildPersistMsg(state) {
    const selectedFile = state.files[state.selectedIndex] || null;
    return {
        filename: CONFIG_PATH,
        payload: JSON.stringify({
            selectedIndex: state.selectedIndex,
            selectedPath: selectedFile ? selectedFile.path : '',
            files: state.files,
            content: state.content,
            updatedAt: new Date().toISOString()
        }, null, 2),
        encoding: 'utf8'
    };
}

function buildOutputs(state, listMsg, readMsg, persistMsg) {
    const selectedFile = state.files[state.selectedIndex] || null;
    const status = state.content.status || 'idle';
    const summary = 'Files ' + state.files.length + ' | Selected ' + (selectedFile ? selectedFile.name : 'none') + ' | Status ' + status + ' | Size ' + (state.content.fileSize || 0) + ' bytes';

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
        files: state.files.map((file, index) => ({
            index,
            name: file.name,
            path: file.path,
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
    state.files = [];
    state.selectedIndex = 0;
    state.content = {
        path: ROOT_PATH,
        name: '',
        status: 'loading-list',
        fileSize: 0,
        rawText: ''
    };
    saveState(state);

    return buildOutputs(state, {
        topic: 'root-files-list',
        payload: 'find "' + ROOT_PATH + '" -type f 2>/dev/null | sort || printf ""'
    }, null, buildPersistMsg(state));
}

let state = getState();

if (msg.topic === 'load-root-files-ui-state-request') {
    return buildOutputs(state, null, null, null);
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
            state = loadedState;
            saveState(state);
            return buildOutputs(state, null, null, null);
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

    return buildOutputs(state, null, selectedFile ? {
        topic: 'root-file-content',
        payload: 'cat "' + selectedFile.path + '" 2>/dev/null || printf ""',
        filePath: selectedFile.path,
        fileName: selectedFile.name
    } : null, buildPersistMsg(state));
}

if (msg.topic === 'root-files-list') {
    const files = String(msg.payload || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(path => ({
            path,
            name: path.split('/').pop() || path
        }));

    state.files = files;

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

    return buildOutputs(state, null, selectedFile ? {
        topic: 'root-file-content',
        payload: 'cat "' + selectedFile.path + '" 2>/dev/null || printf ""',
        filePath: selectedFile.path,
        fileName: selectedFile.name
    } : null, buildPersistMsg(state));
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