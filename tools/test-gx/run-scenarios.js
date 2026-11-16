'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIOS = path.join(__dirname, 'scenarios');
const DEFAULT_API = process.env.TEST_GX_API || 'http://127.0.0.1:8081';

class ScenarioAssertionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScenarioAssertionError';
    }
}

function stripComment(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote === '"' && c === '\\') { i++; continue; }
        if ((c === '"' || c === "'") && (!quote || quote === c)) {
            if (quote === c) quote = null;
            else quote = c;
        } else if (c === '#' && !quote && (i === 0 || /\s/.test(text[i - 1]))) {
            return text.slice(0, i).trimEnd();
        }
    }
    return text.trimEnd();
}

function colonIndex(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote === '"' && c === '\\') { i++; continue; }
        if ((c === '"' || c === "'") && (!quote || quote === c)) {
            if (quote === c) quote = null;
            else quote = c;
        } else if (c === ':' && !quote) return i;
    }
    return -1;
}

function parseScalar(text, line) {
    const value = text.trim();
    if (!value) return '';
    if (value.startsWith('"')) {
        try { return JSON.parse(value); } catch (error) { throw new Error(`YAML line ${line}: ${error.message}`); }
    }
    if (value.startsWith("'")) {
        if (!value.endsWith("'")) throw new Error(`YAML line ${line}: unterminated quoted scalar`);
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (/^(?:null|~)$/i.test(value)) return null;
    if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
    if (/^(?:\.nan|nan)$/i.test(value)) return Number.NaN;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
    if (value.startsWith('[') || value.startsWith('{')) {
        try { return JSON.parse(value); } catch (error) { throw new Error(`YAML line ${line}: inline collections must be JSON: ${error.message}`); }
    }
    return value;
}

function parseYaml(text) {
    if (typeof text !== 'string') throw new TypeError('YAML input must be a string');
    const lines = [];
    for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
        if (/^\s*\t/.test(raw)) throw new Error(`YAML line ${index + 1}: tabs are not supported`);
        const content = stripComment(raw);
        if (!content.trim() || content.trim() === '---' || content.trim() === '...') continue;
        const indent = content.length - content.trimStart().length;
        lines.push({ indent, text: content.trimStart(), line: index + 1 });
    }
    if (!lines.length) return null;

    function parseEntry(i, indent, target, entryText = lines[i].text) {
        const line = lines[i];
        const colon = colonIndex(entryText);
        if (colon < 1) throw new Error(`YAML line ${line.line}: expected key: value`);
        const key = String(parseScalar(entryText.slice(0, colon), line.line));
        if (Object.hasOwn(target, key)) throw new Error(`YAML line ${line.line}: duplicate key ${key}`);
        const rest = entryText.slice(colon + 1).trim();
        i++;
        if (rest) {
            target[key] = parseScalar(rest, line.line);
        } else if (i < lines.length && lines[i].indent > indent) {
            const child = parseBlock(i, lines[i].indent);
            target[key] = child.value;
            i = child.next;
        } else {
            target[key] = null;
        }
        return i;
    }

    function parseBlock(start, indent) {
        if (lines[start].indent !== indent) throw new Error(`YAML line ${lines[start].line}: inconsistent indentation`);
        if (lines[start].text === '-' || lines[start].text.startsWith('- ')) {
            const out = [];
            let i = start;
            while (i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- '))) {
                const line = lines[i];
                const item = line.text === '-' ? '' : line.text.slice(2).trim();
                if (!item) {
                    i++;
                    if (i < lines.length && lines[i].indent > indent) {
                        const child = parseBlock(i, lines[i].indent);
                        out.push(child.value);
                        i = child.next;
                    } else out.push(null);
                    continue;
                }
                if (colonIndex(item) < 1) {
                    out.push(parseScalar(item, line.line));
                    i++;
                    if (i < lines.length && lines[i].indent > indent) {
                        throw new Error(`YAML line ${lines[i].line}: scalar sequence items cannot have children`);
                    }
                    continue;
                }
                const object = {};
                i = parseEntry(i, indent + 2, object, item);
                while (i < lines.length && lines[i].indent > indent) {
                    if (lines[i].indent !== indent + 2) throw new Error(`YAML line ${lines[i].line}: inconsistent sequence mapping indentation`);
                    i = parseEntry(i, indent + 2, object);
                }
                out.push(object);
            }
            return { value: out, next: i };
        }

        const out = {};
        let i = start;
        while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
            i = parseEntry(i, indent, out);
        }
        return { value: out, next: i };
    }

    const parsed = parseBlock(0, lines[0].indent);
    if (parsed.next !== lines.length) throw new Error(`YAML line ${lines[parsed.next].line}: unexpected indentation`);
    return parsed.value;
}

function parseDuration(value, field = 'duration') {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value !== 'string') throw new Error(`${field} must be a nonnegative number or duration (for example 30s or 5m)`);
    const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i);
    if (!match) throw new Error(`${field} has an invalid duration: ${value}`);
    const scale = { ms: 1, s: 1000, m: 60000, h: 3600000 }[(match[2] || 'ms').toLowerCase()];
    return Number(match[1]) * scale;
}

function faketimeRate(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('scenario faketime must be a non-empty libfaketime value');
    if (!/^@\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\s+x\d+(?:\.\d+)?)?$/i.test(value.trim())) {
        throw new Error(`scenario faketime must use @YYYY-MM-DD HH:mm:ss with an optional xN rate: ${value}`);
    }
    const match = value.match(/(?:^|\s)x(\d+(?:\.\d+)?)\s*$/i);
    const rate = match ? Number(match[1]) : 1;
    if (!Number.isFinite(rate) || rate <= 0 || rate > 3600) throw new Error(`unsupported faketime rate in ${value}`);
    return rate;
}

function validateScenario(scenario, source = 'scenario') {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new Error(`${source} must be a YAML mapping`);
    if (typeof scenario.name !== 'string' || !scenario.name.trim()) throw new Error(`${source} needs a name`);
    faketimeRate(scenario.faketime);
    if (!Array.isArray(scenario.steps) || !scenario.steps.length) throw new Error(`${source} needs one or more steps`);
    if (scenario.expected_fail !== undefined && (typeof scenario.expected_fail !== 'string' || !scenario.expected_fail.trim())) {
        throw new Error(`${source} expected_fail must be a bug reference`);
    }
    for (const [index, step] of scenario.steps.entries()) {
        if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${source} step ${index + 1} must be a mapping`);
        parseDuration(step.when, `${source} step ${index + 1} when`);
        parseDuration(step.settle === undefined ? '12s' : step.settle, `${source} step ${index + 1} settle`);
        if (step.expect && (!Array.isArray(step.expect.writes))) throw new Error(`${source} step ${index + 1} expect.writes must be a sequence`);
        for (const key of ['inputs', 'fail', 'stale']) {
            if (step[key] !== undefined && (!step[key] || typeof step[key] !== 'object' || Array.isArray(step[key]))) {
                throw new Error(`${source} step ${index + 1} ${key} must be a mapping`);
            }
        }
    }
    return scenario;
}

function assertWrites(actual, expected, scenarioName, stepIndex) {
    if (!Array.isArray(actual)) throw new ScenarioAssertionError(`${scenarioName} step ${stepIndex}: /writes did not return an array`);
    if (actual.length !== expected.length) {
        throw new ScenarioAssertionError(`${scenarioName} step ${stepIndex}: expected ${expected.length} writes, received ${actual.length}: ${JSON.stringify(actual)}`);
    }
    for (let i = 0; i < expected.length; i++) {
        const wanted = expected[i];
        const got = actual[i];
        if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) {
            throw new ScenarioAssertionError(`${scenarioName} step ${stepIndex}: expected write ${i + 1} must be a mapping`);
        }
        for (const [key, value] of Object.entries(wanted)) {
            if (!Object.hasOwn(got, key) || !isEqual(got[key], value)) {
                throw new ScenarioAssertionError(`${scenarioName} step ${stepIndex}: write ${i + 1} ${key} expected ${formatValue(value)}, received ${formatValue(got[key])}`);
            }
        }
    }
}

function isEqual(a, b) {
    return Number.isNaN(a) && Number.isNaN(b) || JSON.stringify(a) === JSON.stringify(b);
}

function formatValue(value) {
    return Number.isNaN(value) ? 'NaN' : JSON.stringify(value);
}

function createApi(baseUrl = DEFAULT_API, fetchImpl = globalThis.fetch) {
    async function request(method, route, body) {
        let response;
        try {
            response = await fetchImpl(new URL(route, baseUrl), {
                method,
                headers: body === undefined ? {} : { 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(10000)
            });
        } catch (error) {
            throw new Error(`Test GX API ${method} ${route} failed: ${error.message}`);
        }
        const text = await response.text();
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!response.ok) throw new Error(`Test GX API ${method} ${route} returned ${response.status}: ${JSON.stringify(data)}`);
        return data;
    }
    return {
        getState: () => request('GET', '/state'),
        getWrites: () => request('GET', '/writes'),
        post: (route, body = {}) => request('POST', route, body)
    };
}

function setFaketime(value, options = {}) {
    const composeDir = options.composeDir || __dirname;
    const project = options.project || process.env.TEST_GX_COMPOSE_PROJECT || 'test-gx';
    const result = spawnSync('docker', [
        'compose', '-p', project, '-f', 'docker-compose.yml',
        'up', '-d', '--no-build', '--force-recreate', 'nodered'
    ], {
        cwd: composeDir,
        encoding: 'utf8',
        env: { ...process.env, TEST_GX_FAKETIME: value || '' },
        windowsHide: true
    });
    if (result.error) throw new Error(`Could not shift Test GX faketime: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Could not shift Test GX faketime (docker compose exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
}

async function waitReady(api, timeoutMs = 120000) {
    const end = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < end) {
        try { await api.getState(); return; } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    throw new Error(`Test GX emulator did not become ready: ${lastError ? lastError.message : 'timeout'}`);
}

async function applyActions(api, actions) {
    for (const [pathName, value] of Object.entries(actions.inputs || {})) {
        await api.post('/set', { path: pathName, value });
    }
    for (const [pathName, mode] of Object.entries(actions.fail || {})) {
        await api.post('/fail', { path: pathName, mode });
    }
    for (const [pathName, seconds] of Object.entries(actions.stale || {})) {
        await api.post('/stale', { path: pathName, seconds });
    }
}

async function runScenario(scenario, options = {}) {
    validateScenario(scenario);
    const api = options.api || createApi(options.baseUrl);
    const clock = options.setFaketime || setFaketime;
    const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    await clock(scenario.faketime);
    if (options.waitReady !== false) await waitReady(api, options.readyTimeoutMs);
    await api.post('/reset', {});
    await applyActions(api, scenario.initial || {});

    const rate = faketimeRate(scenario.faketime);
    const start = Date.now();
    let cursor = 0;
    for (const [index, step] of scenario.steps.entries()) {
        const due = start + parseDuration(step.when, 'when') / rate;
        if (due > Date.now()) await wait(due - Date.now());
        await applyActions(api, step);
        const settle = parseDuration(step.settle === undefined ? '12s' : step.settle, 'settle');
        if (settle) await wait(settle);
        const writes = await api.getWrites();
        const current = writes.slice(cursor);
        cursor = writes.length;
        if (step.expect) assertWrites(current, step.expect.writes, scenario.name, index + 1);
    }
}

function xmlEscape(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function junitXml(results) {
    const counts = {
        tests: results.length,
        failures: results.filter(r => r.status === 'fail').length,
        skipped: results.filter(r => r.status === 'expected_fail').length
    };
    const cases = results.map(result => {
        const base = `  <testcase classname="test-gx" name="${xmlEscape(result.name)}" time="${(result.durationMs / 1000).toFixed(3)}">`;
        if (result.status === 'fail') return `${base}<failure message="${xmlEscape(result.message)}">${xmlEscape(result.message)}</failure></testcase>`;
        if (result.status === 'expected_fail') return `${base}<skipped message="expected_fail: ${xmlEscape(result.reference)}">${xmlEscape(result.message)}</skipped></testcase>`;
        return `${base}</testcase>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="test-gx-scenarios" tests="${counts.tests}" failures="${counts.failures}" skipped="${counts.skipped}" expected_failures="${counts.skipped}">\n${cases.join('\n')}\n</testsuite>\n`;
}

async function runScenarios(scenarios, options = {}) {
    const results = [];
    let shifted = false;
    const setClock = options.setFaketime || setFaketime;
    try {
        for (const scenario of scenarios) {
            const started = Date.now();
            try {
                await runScenario(scenario, { ...options, setFaketime: async value => { await setClock(value); shifted = true; } });
                if (scenario.expected_fail) {
                    results.push({
                        name: scenario.name,
                        status: 'fail',
                        message: `unexpected pass for expected_fail scenario (${scenario.expected_fail})`,
                        durationMs: Date.now() - started
                    });
                } else {
                    results.push({ name: scenario.name, status: 'pass', durationMs: Date.now() - started });
                }
            } catch (error) {
                const expected = scenario.expected_fail && error instanceof ScenarioAssertionError;
                results.push({
                    name: scenario.name,
                    status: expected ? 'expected_fail' : 'fail',
                    reference: expected ? scenario.expected_fail : undefined,
                    message: error.message,
                    durationMs: Date.now() - started
                });
            }
        }
    } finally {
        if (shifted && options.restoreFaketime !== false) await setClock('');
    }
    return results;
}

function loadScenarios(directory = SCENARIOS) {
    return fs.readdirSync(directory).filter(name => /\.ya?ml$/i.test(name)).sort().flatMap(name => {
        const fullPath = path.join(directory, name);
        const value = parseYaml(fs.readFileSync(fullPath, 'utf8'));
        const items = Array.isArray(value) ? value : [value];
        return items.map((scenario, index) => validateScenario(scenario, `${name}${items.length > 1 ? ` item ${index + 1}` : ''}`));
    });
}

function trivialScenario() {
    return {
        name: 'trivial scenario runner smoke',
        faketime: '@2026-11-16 12:00:00',
        steps: [{ when: '0s', settle: '0s', expect: { writes: [] } }]
    };
}

async function main(args = process.argv.slice(2)) {
    const options = { baseUrl: DEFAULT_API };
    let selfTest = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--junit') options.junitPath = args[++i];
        else if (args[i] === '--scenario') options.scenarioName = args[++i];
        else if (args[i] === '--api') options.baseUrl = args[++i];
        else if (args[i] === '--self-test') selfTest = true;
        else throw new Error(`Unknown argument: ${args[i]}`);
    }
    let scenarios = selfTest ? [trivialScenario()] : loadScenarios();
    if (options.scenarioName) scenarios = scenarios.filter(s => s.name === options.scenarioName);
    if (!scenarios.length) throw new Error(`No scenarios selected${options.scenarioName ? ` for ${options.scenarioName}` : ''}`);

    if (selfTest) {
        const api = {
            post: async () => ({ ok: true }),
            getState: async () => ({}),
            getWrites: async () => []
        };
        options.api = api;
        options.waitReady = false;
        options.setFaketime = async () => {};
        options.restoreFaketime = false;
    }
    const results = await runScenarios(scenarios, options);
    const junitPath = options.junitPath || process.env.TEST_GX_JUNIT || path.join(os.tmpdir(), 'test-gx-scenarios.xml');
    fs.mkdirSync(path.dirname(path.resolve(junitPath)), { recursive: true });
    fs.writeFileSync(junitPath, junitXml(results), 'utf8');
    let counts = { pass: 0, fail: 0, expected_fail: 0 };
    for (const result of results) {
        counts[result.status]++;
        console.log(`${result.status === 'pass' ? 'PASS' : result.status === 'expected_fail' ? 'EXPECTED_FAIL' : 'FAIL'} ${result.name}${result.message ? `: ${result.message}` : ''}`);
    }
    console.log(`Scenarios: ${counts.pass} passed, ${counts.fail} failed, ${counts.expected_fail} expected_fail; JUnit: ${junitPath}`);
    if (counts.fail) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    ScenarioAssertionError,
    assertWrites,
    faketimeRate,
    junitXml,
    loadScenarios,
    parseDuration,
    parseYaml,
    runScenario,
    runScenarios,
    setFaketime,
    trivialScenario,
    validateScenario
};
