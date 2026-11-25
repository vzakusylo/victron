//! @shared
// Optional log files can be absent, but other I/O errors must reach the caller.
async function openHistoryFile(filename) {
    try {
        return await fs.promises.open(filename, 'r');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
    }
}

async function* historyLines(file, inflate) {
    if (!file) return;
    const raw = file.createReadStream({ highWaterMark: 16 * 1024 });
    const input = inflate ? inflate() : raw;
    if (inflate) {
        raw.on('error', error => input.destroy(error));
        raw.pipe(input);
    }
    let tail = '';
    try {
        for await (const chunk of input.setEncoding('utf8')) {
            const lines = (tail + chunk).split('\n');
            tail = lines.pop();
            for (const line of lines) yield { line, newline: true };
        }
        if (tail) yield { line: tail, newline: false };
    } finally {
        raw.destroy();
    }
}

async function historyNames(dir) {
    try {
        return await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return [];
    }
}
