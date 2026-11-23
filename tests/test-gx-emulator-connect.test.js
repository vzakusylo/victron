const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('Test GX emulator retries its initial MQTT connection', (t) => {
    const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3'];
    const python = candidates.find(command => {
        const probe = spawnSync(command, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
        return probe.status === 0 && probe.stdout.trim() === '3';
    });
    if (!python) return t.skip('Python 3 is not available');

    const script = path.join(__dirname, '..', 'tools', 'test-gx', 'emulator', 'test_connect_retry.py');
    const result = spawnSync(python, ['-B', script], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
