'use strict';

// Keep the stdout contract used by the flows without importing SMTP or opening a socket.
const fs = require('node:fs');
try {
    const args = process.argv.slice(2);
    if (!args.includes('--check')) {
        const index = args.indexOf('--file');
        const { subject, text } = JSON.parse(fs.readFileSync(index >= 0 ? args[index + 1] : 0, 'utf8'));
        if (typeof subject !== 'string' || typeof text !== 'string') throw new Error('Mail fixture requires subject and text');
    }
    console.log(JSON.stringify({ ok: true, stub: true }));
} catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
}
