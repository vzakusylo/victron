'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { preserveSettings, ScenarioCleanupError, assertFunctionHashes, assertNoTemporaryFlows } = require('./scenario-state');
const { preserveController } = require('./scenario-controller');

const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIOS = path.join(__dirname, 'scenarios');
const DEFAULT_JUNIT = path.join(__dirname, 'out', 'test-gx-scenarios.xml');
const DEFAULT_API = process.env.TEST_GX_API || 'http://127.0.0.1:8081';
const DEFAULT_SCENARIO_TIMEOUT_MS = Number(process.env.TEST_GX_SCENARIO_TIMEOUT_MS) || 20 * 60 * 1000;
const DEFAULT_CLEANUP_GRACE_MS = 3 * 60 * 1000;
const DEFAULT_ADMIN = process.env.TEST_GX_ADMIN || 'http://127.0.0.1:1881';
const AUTOMATIONS_NODE = 'hpa-fn-01';
const AUTOMATIONS_FLOW = '995ac4ed6222a706';

class ScenarioTimeoutError extends Error {}

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

function validateProtection(value, source) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source} protection must be a mapping`);
    const booleans = ['enabled', 'gridSupportDisableNoSun', 'exportGuardEnabled', 'forceChargeEnabled', 'forceChargeLimiterEnabled'];
    const numbers = ['start', 'release', 'full', 'gridSupportW', 'gridSupportBatteryCapacityAh', 'gridSupportReserveAh',
        'gridSupportStartHour', 'gridSupportEndHour', 'gridSupportMaxDischargeA', 'gridSupportForecastConfidencePct',
        'gridSupportSolarAssistGainPct', 'gridSupportWeakForecastBlockAh', 'gridSupportMinGridImportW',
        'gridSupportDisableNoSunBelowW', 'forceChargeGridW', 'forceChargeLimiterStart', 'forceChargeLimiterRelease', 'forceChargeLimiterFull'];
    for (const [key, setting] of Object.entries(value)) {
        if (booleans.includes(key) ? typeof setting !== 'boolean'
            : numbers.includes(key) ? !Number.isFinite(setting)
                : key === 'gridSupportMode' ? !['hv-only', 'adaptive-day', 'hybrid'].includes(setting) : true) {
            throw new Error(`${source} has an unsupported protection setting or type: ${key}`);
        }
    }
}

function validateScenario(scenario, source = 'scenario') {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new Error(`${source} must be a YAML mapping`);
    if (typeof scenario.name !== 'string' || !scenario.name.trim()) throw new Error(`${source} needs a name`);
    faketimeRate(scenario.faketime);
    if (!Array.isArray(scenario.steps) || !scenario.steps.length) throw new Error(`${source} needs one or more steps`);
    if (scenario.expected_fail !== undefined && (typeof scenario.expected_fail !== 'string' || !scenario.expected_fail.trim())) {
        throw new Error(`${source} expected_fail must be a bug reference`);
    }
    if (scenario.expected_fail_step !== undefined && (!scenario.expected_fail ||
        !Number.isInteger(scenario.expected_fail_step) || scenario.expected_fail_step < 1 ||
        scenario.expected_fail_step > scenario.steps.length)) {
        throw new Error(`${source} expected_fail_step must identify a step of an expected_fail scenario`);
    }
    if (scenario.settings !== undefined && (!scenario.settings || typeof scenario.settings !== 'object' || Array.isArray(scenario.settings))) {
        throw new Error(`${source} settings must be a mapping`);
    }
    if (scenario.controller !== undefined && (!scenario.controller || typeof scenario.controller !== 'object' ||
        Array.isArray(scenario.controller) || !scenario.observe ||
        Object.keys(scenario.controller).some(key => !['protection', 'forecastWatts'].includes(key)) ||
        scenario.controller.forecastWatts !== undefined && (!Number.isFinite(scenario.controller.forecastWatts) ||
            scenario.controller.forecastWatts < 0 || scenario.controller.forecastWatts > 20000))) {
        throw new Error(`${source} controller requires D-Bus observe selectors and supported protection/forecastWatts settings`);
    }
    if (scenario.controller?.protection !== undefined) validateProtection(scenario.controller.protection, source);
    if (scenario.observe !== undefined && (!Array.isArray(scenario.observe) || !scenario.observe.length ||
        scenario.observe.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
            Object.keys(item).some(key => !['service', 'path'].includes(key)) ||
            typeof item.service !== 'string' || !item.service || typeof item.path !== 'string' || !item.path))) {
        throw new Error(`${source} observe must contain service and path selectors`);
    }
    if (scenario.settings) {
        const allowed = ['dhw', 'heat', 'df_exchange_off', 'df_exchange_on', 'hp_er03_restart'];
        if (Object.keys(scenario.settings).some(key => !['master', 'modes', 'heatCurve', 'heat', 'dhw', 'dhwLastDone'].includes(key)) ||
            scenario.settings.dhwLastDone !== undefined && !Number.isFinite(scenario.settings.dhwLastDone) ||
            ['heat', 'dhw'].some(key => scenario.settings[key] !== undefined && (!scenario.settings[key] ||
                typeof scenario.settings[key] !== 'object' || Array.isArray(scenario.settings[key]))) ||
            typeof scenario.settings.master !== 'boolean' || !scenario.settings.modes ||
            typeof scenario.settings.modes !== 'object' || Array.isArray(scenario.settings.modes) ||
            Object.entries(scenario.settings.modes).some(([id, mode]) => !allowed.includes(id) || !['off', 'dry', 'live'].includes(mode))) {
            throw new Error(`${source} settings must contain a boolean master and known rule modes`);
        }
        const curve = scenario.settings.heatCurve;
        if (curve !== undefined && (!curve || typeof curve !== 'object' || Array.isArray(curve) ||
            Object.keys(curve).some(key => !['p23', 'p24'].includes(key)) ||
            !Number.isFinite(curve.p23) || curve.p23 < 0 || curve.p23 > 40 ||
            !Number.isFinite(curve.p24) || curve.p24 < 1 || curve.p24 > 30)) {
            throw new Error(`${source} settings.heatCurve must contain valid p23 and p24 values`);
        }
    }
    for (const [index, step] of scenario.steps.entries()) {
        if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`${source} step ${index + 1} must be a mapping`);
        parseDuration(step.when, `${source} step ${index + 1} when`);
        if (step.fromDeploy !== undefined && (step.fromDeploy !== true || !scenario.settings)) {
            throw new Error(`${source} step ${index + 1} fromDeploy requires heat-pump settings and the value true`);
        }
        if (step.heating !== undefined) {
            const action = step.heating;
            const valid = action && typeof action === 'object' && !Array.isArray(action) && (
                action.action === 'heatWarm' && typeof action.on === 'boolean' &&
                    Object.keys(action).every(key => ['action', 'on', 'deltaC', 'hours'].includes(key)) &&
                    ['deltaC', 'hours'].every(key => action[key] === undefined || Number.isFinite(action[key])) ||
                action.action === 'mode' && action.id === 'heat' && ['off', 'dry', 'live'].includes(action.mode) &&
                    Object.keys(action).length === 3 ||
                action.action === 'heatSet' && typeof action.cfg?.band === 'boolean' &&
                    Object.keys(action.cfg).length === 1 && Object.keys(action).length === 2);
            if (!scenario.settings || !valid) {
                throw new Error(`${source} step ${index + 1} heating requires settings and a supported heating UI action`);
            }
        }
        parseDuration(step.settle === undefined ? '12s' : step.settle, `${source} step ${index + 1} settle`);
        if (!step.expect || typeof step.expect !== 'object' || Array.isArray(step.expect) ||
            (step.expect.writes === undefined ? !step.expect.outputs?.length : !Array.isArray(step.expect.writes))) {
            throw new Error(`${source} step ${index + 1} requires an expect.writes sequence or nonempty expect.outputs`);
        }
        if (step.expect.outputs !== undefined && (!Array.isArray(step.expect.outputs) ||
            step.expect.outputs.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
                Object.keys(item).some(key => !['service', 'path', 'value'].includes(key)) ||
                typeof item.service !== 'string' || !item.service || typeof item.path !== 'string' || !item.path ||
                !Object.hasOwn(item, 'value')))) {
            throw new Error(`${source} step ${index + 1} expect.outputs must contain service, path, and value`);
        }
        if (step.expect.log !== undefined && (!Array.isArray(step.expect.log) ||
            step.expect.log.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
                Object.keys(item).some(key => !['contains', 'count'].includes(key)) ||
                typeof item.contains !== 'string' || !item.contains ||
                item.count !== undefined && !(Number.isInteger(item.count) && item.count >= 0)))) {
            throw new Error(`${source} step ${index + 1} expect.log must contain contains and an optional count`);
        }
        if (step.expect.view !== undefined && (!Array.isArray(step.expect.view) ||
            step.expect.view.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
                Object.keys(item).some(key => !['path', 'equals', 'contains'].includes(key)) ||
                typeof item.path !== 'string' || !item.path ||
                Object.hasOwn(item, 'equals') === Object.hasOwn(item, 'contains') ||
                Object.hasOwn(item, 'contains') && typeof item.contains !== 'string'))) {
            throw new Error(`${source} step ${index + 1} expect.view must contain path and exactly one of equals or contains`);
        }
        if (step.expect.if_changed !== undefined &&
            (typeof step.expect.if_changed !== 'boolean' || !scenario.observe || !step.expect.writes)) {
            throw new Error(`${source} step ${index + 1} if_changed requires D-Bus observe selectors and writes`);
        }
        if (step.expect.maxWriteDelay !== undefined) {
            if (!step.expect.if_changed || step.expect.writes.length !== 1 || Object.keys(step.inputs || {}).length !== 1 ||
                step.controller || step.fail || step.stale || index === 0) {
                throw new Error(`${source} step ${index + 1} maxWriteDelay requires a single input change and expected D-Bus write after setup`);
            }
            parseDuration(step.expect.maxWriteDelay, `${source} step ${index + 1} maxWriteDelay`);
        }
        if (step.controller !== undefined && (!scenario.controller || !step.controller ||
            typeof step.controller !== 'object' || Array.isArray(step.controller) ||
            Object.keys(step.controller).some(key => !['protection', 'refreshForecast', 'forecastFault', 'command'].includes(key)) ||
            step.controller.forecastFault !== undefined && !['stale', 'future', 'previous-day', 'nan'].includes(step.controller.forecastFault))) {
            throw new Error(`${source} step ${index + 1} controller actions require scenario controller settings`);
        }
        if (step.controller?.protection !== undefined) validateProtection(step.controller.protection, `${source} step ${index + 1}`);
        if (step.controller?.refreshForecast !== undefined && typeof step.controller.refreshForecast !== 'boolean') {
            throw new Error(`${source} step ${index + 1} refreshForecast must be boolean`);
        }
        const command = step.controller?.command;
        if (command !== undefined && (!command || typeof command !== 'object' || Array.isArray(command) ||
            Object.keys(command).some(key => !['topic', 'payload'].includes(key)) ||
            !['manual-discharge', 'manual-discharge-stop-voltage'].includes(command.topic) || !Object.hasOwn(command, 'payload'))) {
            throw new Error(`${source} step ${index + 1} command must be a supported manual-discharge topic and payload`);
        }
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

function assertChangedWrites(actual, expected, before, after, scenarioName, stepIndex) {
    if (!Array.isArray(before?.outputs) || !Array.isArray(after?.outputs)) {
        throw new Error('D-Bus if_changed assertions require emulator /state outputs');
    }
    const unavailable = [...before.outputs, ...after.outputs].find(output => output.error);
    if (unavailable) throw new Error(`Cannot read emulator output ${unavailable.service} ${unavailable.path}: ${unavailable.error}`);
    const key = write => JSON.stringify([write.service, write.path]);
    const baseline = new Map(before.outputs.map(write => [key(write), write.value]));
    const final = new Map(after.outputs.map(write => [key(write), write.value]));
    const changes = [];
    for (const wanted of expected) {
        if (!wanted || typeof wanted.service !== 'string' || typeof wanted.path !== 'string' || !Object.hasOwn(wanted, 'value')) {
            throw new Error('D-Bus if_changed expectations require service, path, and value');
        }
        const id = key(wanted);
        if (!baseline.has(id)) throw new Error(`Missing emulator output snapshot for ${id}`);
        if (isEqual(baseline.get(id), wanted.value)) {
            throw new ScenarioAssertionError(
                `${scenarioName} step ${stepIndex}: if_changed requires a new write, but ${id} is already ${formatValue(wanted.value)}`);
        }
        changes.push(wanted);
        baseline.set(id, wanted.value);
    }
    // Writes to different D-Bus paths come from separate flow outputs, so their order is not deterministic.
    const byPath = (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    const sortable = Array.isArray(actual) && actual.every(write => write && typeof write.service === 'string' && typeof write.path === 'string');
    assertWrites(sortable ? [...actual].sort(byPath) : actual, sortable ? [...changes].sort(byPath) : changes, scenarioName, stepIndex);
    for (const wanted of expected) {
        const id = key(wanted);
        const last = baseline.get(id);
        if (!final.has(id) || !isEqual(final.get(id), last)) {
            throw new ScenarioAssertionError(`${scenarioName} step ${stepIndex}: final ${id} expected ${formatValue(last)}, received ${formatValue(final.get(id))}`);
        }
    }
}

function assertOutputs(state, expected, scenarioName, stepIndex) {
    if (!Array.isArray(state?.outputs)) throw new ScenarioAssertionError(`${scenarioName} step ${stepIndex}: /state did not return outputs`);
    for (const wanted of expected) {
        const got = state.outputs.find(output => output.service === wanted.service && output.path === wanted.path);
        if (!got || got.error || !isEqual(got.value, wanted.value)) {
            const actual = got?.error ? `unavailable: ${got.error}` : formatValue(got?.value);
            throw new ScenarioAssertionError(
                `${scenarioName} step ${stepIndex}: final ${JSON.stringify([wanted.service, wanted.path])} expected ${formatValue(wanted.value)}, received ${actual}`);
        }
    }
}

// Log events that are not in the earlier snapshot (compared as JSON, so repeated identical events still count).
function newLogEvents(log, seen) {
    const left = new Map(seen);
    const fresh = [];
    for (const event of log) {
        const id = JSON.stringify(event);
        if (left.get(id) > 0) left.set(id, left.get(id) - 1);
        else fresh.push(event);
    }
    return fresh;
}

function logSnapshot(log) {
    const seen = new Map();
    for (const event of log) {
        const id = JSON.stringify(event);
        seen.set(id, (seen.get(id) || 0) + 1);
    }
    return seen;
}

function assertLog(fresh, expected, scenarioName, stepIndex) {
    for (const wanted of expected) {
        const count = wanted.count === undefined ? 1 : wanted.count;
        const hits = fresh.filter(event => typeof event?.text === 'string' && event.text.includes(wanted.contains));
        if (hits.length !== count) {
            throw new ScenarioAssertionError(`${scenarioName} step ${stepIndex}: expected ${count} new log events containing ${formatValue(wanted.contains)}, received ${hits.length}; new events: ${JSON.stringify(fresh.map(event => event?.text))}`);
        }
    }
}

function assertView(view, expected, scenarioName, stepIndex) {
    for (const wanted of expected) {
        const got = wanted.path.split('.').reduce((value, key) => value === null || value === undefined ? undefined : value[key], view);
        const ok = Object.hasOwn(wanted, 'equals') ? isEqual(got, wanted.equals) : typeof got === 'string' && got.includes(wanted.contains);
        if (!ok) {
            throw new ScenarioAssertionError(`${scenarioName} step ${stepIndex}: view ${wanted.path} expected ${Object.hasOwn(wanted, 'equals') ? formatValue(wanted.equals) : `text containing ${formatValue(wanted.contains)}`}, received ${formatValue(got)}`);
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

function runCompose(command, options = {}) {
    const composeDir = options.composeDir || __dirname;
    const project = options.project || process.env.TEST_GX_COMPOSE_PROJECT || 'test-gx';
    const args = ['compose', '-p', project, '-f', 'docker-compose.yml'];
    if (process.env.TEST_GX_COMPOSE_OVERRIDE) args.push('-f', process.env.TEST_GX_COMPOSE_OVERRIDE);
    args.push(...command);
    const result = spawnSync('docker', args, {
        cwd: composeDir,
        encoding: 'utf8',
        env: { ...process.env, ...(options.faketime === undefined ? {} : { TEST_GX_FAKETIME: options.faketime }) },
        windowsHide: true
    });
    if (result.error) throw new Error(`Test GX compose ${command[0]} failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Test GX compose ${command[0]} failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
}

function setFaketime(value, options = {}) {
    runCompose(['up', '-d', '--no-build', '--no-deps', '--force-recreate', 'nodered'], { ...options, faketime: value || '' });
}

function stopNodeRed(options = {}) {
    runCompose(['stop', 'nodered'], options);
}

function createAdmin(baseUrl = DEFAULT_ADMIN, fetchImpl = globalThis.fetch,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    async function request(method, route, body, headers = {}) {
        const response = await fetchImpl(new URL(route, baseUrl), {
            method,
            headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error(`Node-RED ${method} ${route} returned ${response.status}: ${await response.text()}`);
        const text = await response.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
    }
    return {
        async ready() { await request('GET', '/flows'); },
        async deployElapsed() {
            const route = `/context/node/${AUTOMATIONS_NODE}/lastDefrost`;
            const response = await fetchImpl(new URL(route, baseUrl), { signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error(`Node-RED GET ${route} returned ${response.status}`);
            const now = Date.parse(response.headers.get('date'));
            const deployed = JSON.parse((await response.json()).msg);
            if (!Number.isFinite(now) || !Number.isFinite(deployed) || deployed <= 0 || now < deployed) {
                throw new Error('Node-RED did not return a valid fake wall time and deploy timestamp');
            }
            return now - deployed;
        },
        async verifyDeployed() {
            try {
                await assertNoTemporaryFlows(request);
                const response = await request('GET', '/flows');
                return assertFunctionHashes(Array.isArray(response) ? response : response.flows);
            } catch (error) {
                throw new ScenarioCleanupError([error], error.message);
            }
        },
        async verifyControllerInputs(inputs) {
            for (const [input, key, normalize] of [
                ['batt_v', 'batteryVoltage', Number],
                ['consumed_ah', 'batteryConsumedAh', value => Math.abs(value)],
                ['grid_w', 'gridPowerW', Number],
                ['load_w', 'acLoadPowerW', value => Math.max(0, value)],
                ['pv_w', 'pvChargerPowerW', value => Math.max(0, value)]
            ]) {
                if (!Object.hasOwn(inputs, input)) continue;
                const encoded = await request('GET', `/context/node/e4766632305fb432/${key}`);
                assert.equal(encoded?.format, 'number', `Controller has not received ${input}`);
                assert.equal(Number(encoded.msg), normalize(inputs[input]), `Controller received stale ${input}`);
            }
        },
        // Node-RED returns a context value as a JSON string; a large value comes back cut off, which is an error here.
        async readContext(scope, id, key) {
            const encoded = await request('GET', `/context/${scope}/${id}/${key}`);
            if (!encoded || typeof encoded.msg !== 'string') return undefined;
            try { return JSON.parse(encoded.msg); } catch {
                throw new Error(`Cannot read ${scope} context ${key}: value is not complete JSON (${encoded.format})`);
            }
        },
        preserveSettings: () => preserveSettings(request, wait),
        preserveController: scenario => preserveController(request, wait, scenario),
        async loadSettings(settings, keepInject = false) {
            const inject = randomBytes(8).toString('hex');
            const flow = {
                label: 'Temporary Test GX scenario settings',
                nodes: [{
                    id: inject, type: 'inject', name: 'Load scenario settings',
                    props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
                    payload: '{}', payloadType: 'json', topic: 'ui',
                    repeat: '', crontab: '', once: false, onceDelay: 0.1,
                    x: 120, y: 80, wires: [['hpa-fn-01']]
                }]
            };
            const created = await request('POST', '/flow', flow);
            if (!created || typeof created.id !== 'string') throw new Error('Node-RED did not return the temporary flow id');
            const restore = async () => {
                await request('DELETE', `/flow/${created.id}`);
                await wait(6000);
            };
            let retained = false;
            try {
                const deployed = await request('GET', `/flow/${created.id}`);
                const node = deployed.nodes && deployed.nodes.find(item => item.name === 'Load scenario settings' && item.type === 'inject');
                if (!node) throw new Error('Node-RED did not deploy the scenario settings inject node');
                await wait(6000);
                const actions = [
                    ...(settings.heatCurve || settings.heat || settings.dhw || settings.dhwLastDone ? [{ topic: 'load', payload: {
                        master: false,
                        ...(settings.heatCurve ? { heatCurve: settings.heatCurve } : {}),
                        ...(settings.heat ? { heat: settings.heat } : {}),
                        ...(settings.dhw ? { dhw: settings.dhw } : {}),
                        ...(settings.dhwLastDone ? { dhwLastDone: settings.dhwLastDone } : {})
                    } }] : []),
                    { topic: 'ui', payload: { action: 'master', on: false } },
                    { topic: 'ui', payload: { action: 'modeAll', mode: 'off' } },
                    { topic: 'ui', payload: { action: 'mode', id: 'dhw', mode: 'off' } },
                    { topic: 'ui', payload: { action: 'mode', id: 'heat', mode: 'off' } },
                    ...Object.entries(settings.modes || {}).map(([id, mode]) => ({ topic: 'ui', payload: { action: 'mode', id, mode } })),
                    { topic: 'ui', payload: { action: 'master', on: settings.master === true } }
                ];
                const injectAction = ({ topic, payload }) =>
                    request('POST', `/inject/${node.id}`, {
                        __user_inject_props__: [
                            { p: 'payload', v: JSON.stringify(payload), vt: topic === 'load' ? 'str' : 'json' },
                            { p: 'topic', v: topic, vt: 'str' }
                        ]
                    });
                for (const action of actions) {
                    await injectAction(action);
                    await wait(200);
                }
                if (keepInject) {
                    retained = true;
                    return { apply: payload => injectAction({ topic: 'ui', payload }), restore };
                }
            } finally {
                if (!retained) await restore();
            }
        }
    };
}

// Wraps every function of `target` so a call rejects as soon as `signal` aborts.
function abortable(target, signal) {
    if (!signal) return target;
    return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, typeof value !== 'function' ? value
        : (...args) => {
            signal.throwIfAborted();
            return new Promise((resolve, reject) => {
                const onAbort = () => reject(signal.reason);
                signal.addEventListener('abort', onAbort, { once: true });
                Promise.resolve().then(() => value.apply(target, args)).then(resolve, reject)
                    .finally(() => signal.removeEventListener('abort', onAbort));
            });
        }]));
}

async function waitReady(api, timeoutMs = 120000, signal) {
    const end = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < end) {
        signal?.throwIfAborted();
        try { await api.getState(); return; } catch (error) {
            signal?.throwIfAborted();
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
    const signal = options.signal;
    const rawAdmin = options.admin || createAdmin(options.adminUrl);
    const rawClock = options.setFaketime || setFaketime;
    // The body is abortable; the cleanup in `finally` uses the raw handles and always runs to completion.
    const api = abortable(options.api || createApi(options.baseUrl), signal);
    // preserveSettings, preserveController and loadSettings must finish so restore() always runs; only ready is open-ended.
    const admin = { ...rawAdmin, ready: abortable(rawAdmin, signal).ready };
    const clock = abortable({ clock: rawClock }, signal).clock;
    const rawWait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const wait = abortable({ wait: rawWait }, signal).wait;
    if (options.waitReady !== false) await waitReady({ getState: admin.ready }, options.readyTimeoutMs, signal);
    await admin.verifyDeployed();
    let saved;
    let heating;
    let controller;
    let controllerSettingsApplied = false;
    let failure;
    let stopped = false;
    let activeStep;
    try {
        if (scenario.controller) {
            if (options.waitReady !== false) await waitReady(api, options.readyTimeoutMs, signal);
            stopped = true;
            await (options.stopNodeRed || stopNodeRed)();
            await api.post('/reset', { outputs: true });
            const resetState = await api.getState();
            const baseline = resetState.outputs;
            for (const [service, outputPath, value] of [
                ['settings', '/Settings/SystemSetup/MaxChargeCurrent', -1],
                ['settings', '/Settings/CGwacs/AcPowerSetPoint', 0],
                ['vebus', '/Ac/In/1/CurrentLimit', 25]
            ]) {
                assert.equal(baseline?.find(output => output.service === service && output.path === outputPath)?.value,
                    value, `Emulator /reset did not restore ${service} ${outputPath} before Node-RED startup`);
            }
            await applyActions(api, scenario.initial || {});
        }
        await clock(scenario.faketime);
        stopped = false;
        if (options.waitReady !== false) {
            await waitReady(api, options.readyTimeoutMs, signal);
            await waitReady({ getState: admin.ready }, options.readyTimeoutMs, signal);
        }
        if (scenario.settings || scenario.controller) {
            saved = await admin.preserveSettings();
            if (scenario.settings) heating = await admin.loadSettings(scenario.settings, scenario.steps.some(step => step.heating));
            if (scenario.controller) {
                controller = await admin.preserveController(scenario);
            }
        }
        if (!scenario.controller) {
            await api.post('/reset', {});
            await applyActions(api, scenario.initial || {});
        }

        const rate = faketimeRate(scenario.faketime);
        const start = Date.now();
        let inputs = { ...scenario.initial?.inputs };
        let cursor = scenario.controller ? (await api.getWrites()).length : 0;
        const readLog = async () => (await admin.readContext('node', AUTOMATIONS_NODE, 'log')) || [];
        let logSeen = scenario.steps.some(step => step.expect.log) ? logSnapshot(await readLog()) : undefined;
        for (const [index, step] of scenario.steps.entries()) {
            activeStep = index + 1;
            const offset = parseDuration(step.when, 'when');
            const elapsed = step.fromDeploy ? await admin.deployElapsed() : 0;
            if (step.fromDeploy && elapsed > offset) {
                throw new Error(`${scenario.name} step ${index + 1}: missed deploy-relative observation window`);
            }
            const due = (step.fromDeploy ? Date.now() : start) + (offset - elapsed) / rate;
            if (due > Date.now()) await wait(due - Date.now());
            const before = step.expect.if_changed ? await api.getState() : undefined;
            if (scenario.controller && !controllerSettingsApplied) {
                await controller.apply({ protection: scenario.controller.protection || {} });
                controllerSettingsApplied = true;
            }
            await applyActions(api, step);
            inputs = { ...inputs, ...step.inputs };
            if (step.controller) await controller.apply(step.controller);
            if (step.heating) await heating.apply(step.heating);
            const settle = parseDuration(step.settle === undefined ? '12s' : step.settle, 'settle');
            if (settle) await wait(settle / rate);
            if (scenario.controller && options.waitReady !== false) await admin.verifyControllerInputs(inputs);
            const writes = await api.getWrites();
            const current = writes.slice(cursor).filter(write => scenario.observe
                ? scenario.observe.some(selector => write.service === selector.service && write.path === selector.path)
                : write.operation === 'SET');
            cursor = writes.length;
            const finalState = step.expect.if_changed || step.expect.outputs ? await api.getState() : undefined;
            if (step.expect.if_changed) {
                assertChangedWrites(current, step.expect.writes, before, finalState, scenario.name, index + 1);
            } else if (step.expect.writes) assertWrites(current, step.expect.writes, scenario.name, index + 1);
            if (step.expect.maxWriteDelay !== undefined) {
                // /state and /writes use the same unfaked emulator clock.
                const delayMs = (current[0].ts - before.now) * 1000;
                if (!Number.isFinite(delayMs)) throw new Error('State or write timestamp is missing from emulator API');
                const limitMs = parseDuration(step.expect.maxWriteDelay, 'maxWriteDelay');
                const timing = `${scenario.name} step ${index + 1}: D-Bus write after ${(delayMs / 1000).toFixed(2)} real s`;
                if (delayMs < 0 || delayMs > limitMs) {
                    throw new ScenarioAssertionError(`${timing}; expected a new write within ${limitMs / 1000} s`);
                }
                options.onTiming?.(timing);
            }
            if (step.expect.outputs) assertOutputs(finalState, step.expect.outputs, scenario.name, index + 1);
            if (step.expect.log) {
                const log = await readLog();
                assertLog(newLogEvents(log, logSeen), step.expect.log, scenario.name, index + 1);
                logSeen = logSnapshot(log);
            } else if (logSeen) logSeen = logSnapshot(await readLog());
            if (step.expect.view) {
                assertView(await admin.readContext('flow', AUTOMATIONS_FLOW, 'dhwView'), step.expect.view, scenario.name, index + 1);
            }
        }
    } catch (error) {
        if (error instanceof ScenarioAssertionError) error.step = activeStep;
        failure = error;
        throw error;
    } finally {
        const errors = [];
        for (const state of [heating, controller, saved]) {
            if (state) {
                try { await state.restore(); } catch (error) { errors.push(error); }
            }
        }
        if (stopped) {
            try {
                await rawClock('');
                if (options.waitReady !== false) await waitReady({ getState: rawAdmin.ready }, options.readyTimeoutMs);
            } catch (error) { errors.push(error); }
        }
        try { await rawAdmin.verifyDeployed(); } catch (error) { errors.push(error); }
        if (errors.length) {
            if (failure) errors.unshift(failure);
            throw new ScenarioCleanupError(errors, errors.map(error => error.message).join('; '));
        }
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
            const progress = options.onProgress && setInterval(() => options.onProgress({
                name: scenario.name, durationMs: Date.now() - started
            }), 60000);
            let cleanupFailed = false;
            const timeoutMs = options.scenarioTimeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
            const graceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
            const abort = new AbortController();
            let timer;
            let graceTimer;
            let running;
            try {
                running = runScenario(scenario, {
                    ...options, signal: abort.signal,
                    setFaketime: async value => { shifted = true; await setClock(value); }
                });
                running.catch(() => {});
                await Promise.race([running, new Promise((resolve, reject) => {
                    timer = setTimeout(() => reject(new ScenarioTimeoutError(
                        `scenario timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
                })]);
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
                cleanupFailed = error instanceof ScenarioCleanupError;
                let stopError;
                if (error instanceof ScenarioTimeoutError) {
                    abort.abort(error);
                    const outcome = await Promise.race([
                        running.then(() => 'done', cause => cause),
                        new Promise(resolve => { graceTimer = setTimeout(() => resolve('grace'), graceMs); })
                    ]);
                    if (outcome === 'grace') {
                        stopError = new Error(`Scenario "${scenario.name}" timed out and its cleanup did not finish within ${Math.round(graceMs / 1000)} s; stopping the run because the stack was not restored`);
                    } else if (outcome instanceof ScenarioCleanupError) cleanupFailed = true;
                }
                const expected = scenario.expected_fail && error instanceof ScenarioAssertionError &&
                    (scenario.expected_fail_step === undefined || error.step === scenario.expected_fail_step);
                results.push({
                    name: scenario.name,
                    status: expected ? 'expected_fail' : 'fail',
                    reference: expected ? scenario.expected_fail : undefined,
                    message: error.message,
                    durationMs: Date.now() - started
                });
                if (stopError) {
                    if (options.onResult) options.onResult(results.at(-1));
                    stopError.results = results;
                    throw stopError;
                }
            } finally {
                clearTimeout(timer);
                clearTimeout(graceTimer);
                if (progress) clearInterval(progress);
            }
            if (options.onResult) options.onResult(results.at(-1));
            if (cleanupFailed) break;
        }
    } finally {
        if (shifted && options.restoreFaketime !== false) await setClock('');
    }
    return results;
}

function loadScenarios(directory = SCENARIOS) {
    const origins = new Map();
    return fs.readdirSync(directory).filter(name => /\.ya?ml$/i.test(name)).sort().flatMap(name => {
        const fullPath = path.join(directory, name);
        const value = parseYaml(fs.readFileSync(fullPath, 'utf8'));
        const items = Array.isArray(value) ? value : [value];
        return items.map((scenario, index) => {
            const source = `${name}${items.length > 1 ? ` item ${index + 1}` : ''}`;
            validateScenario(scenario, source);
            if (origins.has(scenario.name)) {
                throw new Error(`Duplicate scenario name "${scenario.name}" in ${source} and ${origins.get(scenario.name)}`);
            }
            origins.set(scenario.name, source);
            // T1: the source file, for --file (one CI job per scenario file); not enumerable, so it is never sent anywhere
            Object.defineProperty(scenario, 'file', { value: name, enumerable: false });
            return scenario;
        });
    });
}

function trivialScenario() {
    return {
        name: 'trivial scenario runner smoke',
        faketime: '@2026-11-16 12:00:00',
        steps: [{ when: '0s', settle: '0s', expect: { writes: [] } }]
    };
}

async function main(args = process.argv.slice(2), overrides = {}) {
    const options = { baseUrl: DEFAULT_API };
    let selfTest = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--junit') options.junitPath = args[++i];
        else if (args[i] === '--scenario') options.scenarioName = args[++i];
        else if (args[i] === '--suite') {
            options.suite = args[++i];
            if (!['charging', 'heatpump'].includes(options.suite)) throw new Error('--suite must be charging or heatpump');
        }
        else if (args[i] === '--file') options.files = String(args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        else if (args[i] === '--api') options.baseUrl = args[++i];
        else if (args[i] === '--self-test') selfTest = true;
        else throw new Error(`Unknown argument: ${args[i]}`);
    }
    let scenarios = selfTest ? [trivialScenario()] : loadScenarios();
    if (options.suite) scenarios = scenarios.filter(scenario => Boolean(scenario.controller) === (options.suite === 'charging'));
    if (options.files) {
        const known = new Set(scenarios.map(s => s.file));
        const missing = options.files.filter(f => !known.has(f));
        if (missing.length) throw new Error(`--file: no scenario file ${missing.join(', ')}`);
        scenarios = scenarios.filter(s => options.files.includes(s.file));
    }
    if (options.scenarioName) scenarios = scenarios.filter(s => s.name === options.scenarioName);
    if (!scenarios.length) throw new Error(`No scenarios selected${options.scenarioName ? ` for ${options.scenarioName}` : ''}`);

    if (selfTest) {
        const api = {
            post: async () => ({ ok: true }),
            getState: async () => ({}),
            getWrites: async () => []
        };
        options.api = api;
        options.admin = { verifyDeployed: async () => {} };
        options.waitReady = false;
        options.setFaketime = async () => {};
        options.restoreFaketime = false;
    }
    const { scenarios: injectedScenarios, ...injectedOptions } = overrides;
    if (injectedScenarios) scenarios = injectedScenarios;
    Object.assign(options, injectedOptions);
    options.onResult = result => console.log(
        `${result.status === 'pass' ? 'PASS' : result.status === 'expected_fail' ? 'EXPECTED_FAIL' : 'FAIL'} ${result.name}${result.message ? `: ${result.message}` : ''}`);
    options.onProgress = result => console.log(`RUNNING ${result.name}: ${Math.floor(result.durationMs / 60000)} real min elapsed`);
    options.onTiming = timing => console.log(`TIMING ${timing}`);
    let results;
    let stopError;
    try { results = await runScenarios(scenarios, options); } catch (error) {
        if (!error.results) throw error;
        stopError = error;
        results = error.results;
    }
    const junitPath = options.junitPath || process.env.TEST_GX_JUNIT || DEFAULT_JUNIT;
    fs.mkdirSync(path.dirname(path.resolve(junitPath)), { recursive: true });
    fs.writeFileSync(junitPath, junitXml(results), 'utf8');
    let counts = { pass: 0, fail: 0, expected_fail: 0 };
    for (const result of results) {
        counts[result.status]++;
    }
    console.log(`Scenarios: ${counts.pass} passed, ${counts.fail} failed, ${counts.expected_fail} expected_fail; JUnit: ${junitPath}`);
    if (stopError) throw stopError;
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
    assertChangedWrites,
    assertOutputs,
    assertLog,
    assertView,
    newLogEvents,
    logSnapshot,
    createAdmin,
    faketimeRate,
    junitXml,
    loadScenarios,
    main,
    parseDuration,
    parseYaml,
    runScenario,
    runScenarios,
    setFaketime,
    stopNodeRed,
    trivialScenario,
    validateScenario
};
