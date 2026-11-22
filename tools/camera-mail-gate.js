#!/usr/bin/env node
// Forced SSH command for camera mail only. Exact SSH_ORIGINAL_COMMAND "check"
// checks SMTP login without sending; every other command is ignored.
// Send: one UTF-8 JSON object on stdin, then EOF within 45 s. Max 10 MiB
// including whitespace and Base64. Fields: nonblank subject (max 200 Unicode
// code points, no control characters), text string, optional jpg_b64 (canonical
// padded standard Base64 of a JPEG); unknown fields are rejected.
// Stdout: one JSON line, {ok:true}, {ok:true,check:true}, or {ok:false,error:string}.
// Exit 0: success; 1: sender/internal failure; 2: invalid/timed-out input.
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { TextDecoder } = require('node:util');

const MAX_INPUT = 10 * 1024 * 1024;
const MAIL_TOOL = '/data/home/nodered/tools/send-mail.js';

class BadInput extends Error {}

async function readMessage(input) {
    let bytes = 0;
    const chunks = [];
    const timer = setTimeout(() => input.destroy(new BadInput('mail input timeout')), 45_000);
    try {
        for await (const chunk of input) {
            bytes += chunk.length;
            if (bytes > MAX_INPUT) throw new BadInput('mail input exceeds 10 MiB');
            chunks.push(chunk);
        }
    } finally {
        clearTimeout(timer);
    }

    let msg;
    try { msg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { throw new BadInput('expected one UTF-8 JSON object'); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) ||
        Object.keys(msg).some(k => !['subject', 'text', 'jpg_b64'].includes(k))) {
        throw new BadInput('expected only subject, text and optional jpg_b64');
    }
    const { subject, text, jpg_b64: encoded } = msg;
    if (typeof subject !== 'string' || !subject.trim() || Array.from(subject).length > 200 ||
        /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(subject) || typeof text !== 'string') {
        throw new BadInput('expected nonblank subject (max 200 characters, no controls) and text string');
    }
    let jpg;
    if (encoded !== undefined) {
        if (typeof encoded !== 'string') throw new BadInput('jpg_b64 must be a Base64 string');
        jpg = Buffer.from(encoded, 'base64');
        if (jpg.toString('base64') !== encoded ||
            jpg.length < 5 || jpg[0] !== 0xff || jpg[1] !== 0xd8 || jpg[2] !== 0xff ||
            jpg.at(-2) !== 0xff || jpg.at(-1) !== 0xd9) {
            throw new BadInput('jpg_b64 must be a standard Base64 JPEG');
        }
    }
    return { subject, text, jpg };
}

function send(args, signal, mailTool) {
    // The production CLI uses a fixed script and no inherited environment.
    // Tests inject the tool through the module API, not the SSH process environment.
    return new Promise(resolve => {
        const child = execFile(process.execPath, [mailTool, ...args], {
            env: {}, timeout: 125_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal
        }, (err, stdout) => {
            let result;
            try { result = JSON.parse(stdout); } catch { /* malformed sender response */ }
            if (!err && result?.ok === true) return resolve({ ok: true, ...(result.check === true ? { check: true } : {}) });
            const error = result?.ok === false && typeof result.error === 'string' && result.error
                ? result.error.slice(0, 1000)
                : err?.killed && !signal.aborted ? 'mail sender timeout' : 'mail sender failed';
            resolve({ ok: false, error });
        });
        child.stdin.end();
    });
}

async function gate({ input, command, signal, mailTool = MAIL_TOOL, tmp = '/tmp' }) {
    let dir;
    try {
        if (command === 'check') return await send(['--check'], signal, mailTool);
        const { subject, text, jpg } = await readMessage(input);
        dir = await fs.mkdtemp(path.join(tmp, 'camera-mail-'));
        const mail = path.join(dir, 'mail.json');
        await fs.writeFile(mail, JSON.stringify({ subject, text }), { mode: 0o600, flag: 'wx' });
        const args = ['--file', mail];
        if (jpg) {
            const image = path.join(dir, 'snapshot.jpg');
            await fs.writeFile(image, jpg, { mode: 0o600, flag: 'wx' });
            args.push('--attach', image);
        }
        return await send(args, signal, mailTool);
    } finally {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
}

module.exports = { gate };

if (require.main === module) {
    const controller = new AbortController();
    for (const name of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
        process.once(name, () => {
            controller.abort();
            if (process.stdin.readableFlowing !== null) process.stdin.destroy(new Error('mail request interrupted'));
        });
    }
    gate({ input: process.stdin, command: process.env.SSH_ORIGINAL_COMMAND, signal: controller.signal })
        .then(result => ({ result, code: result.ok ? 0 : 1 }))
        .catch(err => err instanceof BadInput
            ? { result: { ok: false, error: err.message }, code: 2 }
            : { result: { ok: false, error: 'mail gate failed' }, code: 1 })
        .then(({ result, code }) => {
            process.exitCode = code;
            process.stdout.write(JSON.stringify(result) + '\n');
        });
}
