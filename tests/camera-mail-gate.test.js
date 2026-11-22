'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { gate } = require('../tools/camera-mail-gate');

const cli = require.resolve('../tools/camera-mail-gate');
const jpg = Buffer.from([255, 216, 255, 224, 255, 217]);
const message = { subject: 'Camera alert', text: 'Snapshot attached', jpg_b64: jpg.toString('base64') };

async function fixture(t) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'camera-gate-test-'));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const mailTool = path.join(tmp, 'fake-sender.js');
    await fs.writeFile(mailTool, `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        if (args[0] === '--check') {
            assert.deepEqual(args, ['--check']);
            console.log(JSON.stringify({ok:true,check:true}));
        } else {
            assert.equal(args[0], '--file');
            const m = JSON.parse(fs.readFileSync(args[1], 'utf8'));
            assert.deepEqual(m, {subject: 'Camera alert', text: 'Snapshot attached'});
            if (args[2] === '--attach') {
                assert.equal(args.length, 4);
                assert.deepEqual([...fs.readFileSync(args[3])], [255,216,255,224,255,217]);
                console.log(JSON.stringify({ok:true}));
            } else {
                assert.equal(args.length, 2);
                console.log(JSON.stringify({ok:false,error:'SMTP refused'}));
                process.exitCode = 1;
            }
        }
    `);
    async function run(input, command) {
        return gate({ input, command, mailTool, tmp, signal: new AbortController().signal });
    }
    return { tmp, run };
}

test('camera gate ignores remote shell text and sends only the validated message and JPG', async (t) => {
    const { run, tmp } = await fixture(t);
    const input = Readable.from([Buffer.from(JSON.stringify(message))]);
    assert.deepEqual(await run(input, 'check; exit 99'), { ok: true });
    assert.deepEqual(await fs.readdir(tmp), ['fake-sender.js']);
});

test('only exact check bypasses stdin; normal sender failures still clean up', async (t) => {
    const { run, tmp } = await fixture(t);
    const unused = Readable.from((function* () { throw new Error('check read stdin'); })());
    assert.deepEqual(await run(unused, 'check'), { ok: true, check: true });
    const input = Readable.from([Buffer.from(JSON.stringify({ subject: message.subject, text: message.text }))]);
    assert.deepEqual(await run(input), { ok: false, error: 'SMTP refused' });
    assert.deepEqual(await fs.readdir(tmp), ['fake-sender.js']);
});

test('invalid inputs return exactly one JSON line with exit 2', () => {
    for (const input of [
        '{', '{} {}', '{"subject":"x","text":"y","to":"somewhere"}',
        '{"subject":"x\\ny","text":"y"}', JSON.stringify({ ...message, subject: 'x'.repeat(201) }),
        JSON.stringify({ ...message, jpg_b64: 'ABC' })
    ]) {
        const r = spawnSync(process.execPath, [cli], {
            input, encoding: 'utf8', env: { ...process.env, SSH_ORIGINAL_COMMAND: 'check ' }
        });
        assert.equal(r.status, 2, r.stderr);
        assert.equal(r.stdout.trim().split('\n').length, 1);
        assert.equal(JSON.parse(r.stdout).ok, false);
    }
});

test('camera gate bounds the stream before JSON parsing or temporary writes', async (t) => {
    const { run, tmp } = await fixture(t);
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const input = Readable.from((function* () {
        for (let i = 0; i < 10; i++) yield chunk;
        yield Buffer.from(' ');
        assert.fail('must stop reading after exceeding the limit');
    })(), { highWaterMark: 0 });
    await assert.rejects(run(input), /exceeds 10 MiB/);
    assert.deepEqual(await fs.readdir(tmp), ['fake-sender.js']);
});
