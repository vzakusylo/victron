'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { ScenarioCleanupError, decodeContext } = require('./scenario-state');

const CONTEXT_KEYS = ['highVoltageSettings', 'controllerConstantsOverrides', 'solarForecastToday', 'solarForecastAdjusted'];
const API_HEADERS = { 'Node-RED-API-Version': 'v2' };
const DEPLOY_HEADERS = { ...API_HEADERS, 'Node-RED-Deployment-Type': 'nodes' };

function contextBridgeSource() {
    return `const keys = ${JSON.stringify(CONTEXT_KEYS)};
try {
    if (msg.payload.action === 'restore') {
        flow.set('testGxGridExercise', undefined);
        for (const key of keys) {
            const saved = msg.payload.context[key];
            if (!saved) throw Error('Missing context snapshot: ' + key);
            flow.set(key, saved.exists ? saved.value : undefined);
        }
    } else if (msg.payload.action === 'gridExercise') {
        flow.set('testGxGridExercise', msg.payload.mode);
        if (msg.payload.mode === 'load') {
            const stop = Date.now() + 23000;
            const rows = Array.from({ length: 3000 }, (_, i) => ({ i, value: 'synthetic dashboard row' }));
            const work = () => {
                if (Date.now() >= stop || flow.get('testGxGridExercise') !== 'load') return;
                const end = Date.now() + 30;
                do { JSON.parse(JSON.stringify(rows)); } while (Date.now() < end);
                setTimeout(work, 70);
            };
            setTimeout(work, 0);
        }
    } else if (msg.payload.action === 'reset') {
        flow.set('controllerConstantsOverrides', {});
        flow.set('solarForecastToday', undefined);
        flow.set('solarForecastAdjusted', undefined);
    } else if (msg.payload.action === 'remember') {
        const forecast = flow.get('solarForecastToday');
        if (!forecast || !Number.isFinite(forecast.energyKWh) || forecast.energyKWh < 0 ||
            msg.payload.requirePositive && forecast.energyKWh === 0) throw Error('HTTP fixture did not produce the required stored forecast');
        context.set('fixtureForecast', { ...forecast });
    } else if (msg.payload.action === 'fault') {
        const saved = context.get('fixtureForecast');
        if (!saved) throw Error('Fetch the HTTP fixture before injecting a cached-forecast fault');
        const forecast = { ...saved };
        const hours = { stale: 19, future: -1 };
        if (msg.payload.fault === 'nan') forecast.energyKWh = Number.NaN;
        else if (msg.payload.fault === 'previous-day') {
            const previous = new Date();
            previous.setDate(previous.getDate() - 1);
            previous.setHours(23, 0, 0, 0);
            forecast.updatedAt = previous.toISOString();
        }
        else if (Object.hasOwn(hours, msg.payload.fault)) {
            forecast.updatedAt = new Date(Date.now() - hours[msg.payload.fault] * 3600000).toISOString();
        } else throw Error('Unknown forecast fault');
        flow.set('solarForecastToday', forecast);
    } else if (msg.payload.action !== 'snapshot') throw Error('Unknown context action');
    msg.payload = Object.fromEntries(keys.map(key => {
        const value = flow.get(key);
        return [key, value === undefined ? { exists: false } : { exists: true, value }];
    }));
} catch (error) {
    node.error(error.message, msg);
    msg.statusCode = 500;
    msg.payload = { error: error.message };
}
return msg;`;
}

async function preserveController(request, wait, scenario, options = {}) {
    const original = await request('GET', '/flows', undefined, API_HEADERS);
    if (!Array.isArray(original.flows) || !original.rev) throw new Error('Node-RED did not return revisioned flows');
    const controller = original.flows.find(node => node.name === 'Battery + Grid Controller' && node.type === 'function');
    const protection = original.flows.find(node => node.name === 'Apply HV settings' && node.type === 'function');
    const refresh = original.flows.find(node => node.name === 'Refresh solar forecast 15m' && node.type === 'inject');
    const forecastInstance = original.flows.find(node => node.name === 'Solar forecast Hokksund');
    const forecastType = forecastInstance?.type.replace(/^subflow:/, '');
    const http = original.flows.find(node => node.z === forecastType && node.type === 'http request');
    if (!controller || !protection || !refresh || !http) throw new Error('Required charging/forecast nodes are missing');
    const context = {};
    for (const key of CONTEXT_KEYS) {
        const encoded = await request('GET', `/context/flow/${controller.z}/${key}`);
        context[key] = encoded?.format === 'undefined'
            ? { exists: false } : { exists: true, value: decodeContext(encoded, key) };
    }
    const token = randomBytes(8).toString('hex');
    const prefix = `tgx-controller-${token}`;
    const route = `/test-gx-controller-${token}`;
    const forecastUrl = new URL('/forecast', 'http://venus:8081');
    forecastUrl.searchParams.set('date', scenario.faketime.slice(1, 11));
    forecastUrl.searchParams.set('watts', String(scenario.controller.forecastWatts || 0));
    const stubUrl = forecastUrl.toString();
    const nodes = [
        { id: `${prefix}-in`, type: 'http in', z: controller.z, method: 'post', url: route,
            x: 120, y: 80, wires: [[`${prefix}-context`]] },
        { id: `${prefix}-context`, type: 'function', z: controller.z, name: 'Temporary Test GX scenario context',
            outputs: 1, func: contextBridgeSource(), x: 340, y: 80, wires: [[`${prefix}-out`]] },
        { id: `${prefix}-out`, type: 'http response', z: controller.z, x: 560, y: 80, wires: [] },
        ...[['command', controller.id], ['protection', protection.id]].map(([kind, target], index) => ({
            id: `${prefix}-${kind}`, type: 'inject', z: controller.z, name: `Temporary Test GX scenario ${kind}`,
            props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }], payloadType: 'json', payload: '{}',
            topic: '', repeat: '', crontab: '', once: false, onceDelay: 0.1,
            x: 120, y: 160 + index * 80, wires: [[target]]
        }))
    ];
    const directory = options.backupDirectory || path.join(os.tmpdir(), 'test-gx-scenario-backups');
    fs.mkdirSync(directory, { recursive: true });
    const backupPath = path.join(directory, `${token}-controller.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ flows: original, context }, null, 2), { flag: 'wx' });
    const ownIds = new Set(nodes.map(node => node.id));
    let installed = false;
    async function restore() {
        const errors = [];
        if (installed) {
            try {
                assert.deepEqual(await request('POST', route, { action: 'restore', context }), context,
                    'Controller context differs after restoration');
            } catch (error) { errors.push(error); }
            try {
                const current = await request('GET', '/flows', undefined, API_HEADERS);
                const originalHttp = current.flows.find(node => node.id === http.id);
                const urlConflict = !originalHttp || originalHttp.url !== stubUrl;
                const restored = current.flows.filter(node => !ownIds.has(node.id)).map(node =>
                    node.id === http.id && !urlConflict ? { ...node, url: http.url } : node);
                await request('POST', '/flows', { rev: current.rev, flows: restored }, DEPLOY_HEADERS);
                if (urlConflict) throw new Error('Forecast URL changed concurrently; preserved that edit instead of overwriting it');
                const verified = await request('GET', '/flows', undefined, API_HEADERS);
                if (verified.flows.some(node => ownIds.has(node.id))) throw new Error('Temporary controller nodes remain deployed');
                assert.equal(verified.flows.find(node => node.id === http.id)?.url, http.url, 'Forecast URL was not restored');
                for (const key of CONTEXT_KEYS) {
                    const encoded = await request('GET', `/context/flow/${controller.z}/${key}`);
                    const actual = encoded?.format === 'undefined' ? { exists: false }
                        : { exists: true, value: decodeContext(encoded, key) };
                    assert.deepEqual(actual, context[key], `${key} differs after temporary-node removal`);
                }
            } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new ScenarioCleanupError(errors,
            `Controller cleanup failed (backup ${backupPath}): ${errors.map(error => error.message).join('; ')}`);
    }
    try {
        installed = true;
        await request('POST', '/flows', {
            rev: original.rev,
            flows: [...original.flows.map(node => node.id === http.id ? { ...node, url: stubUrl } : node), ...nodes]
        }, DEPLOY_HEADERS);
        await wait(6000);
        await request('POST', route, { action: 'reset' });
        const inject = (kind, topic, payload, type = 'json') => request('POST', `/inject/${prefix}-${kind}`, {
            __user_inject_props__: [
                { p: 'payload', v: JSON.stringify(payload), vt: type }, { p: 'topic', v: topic, vt: 'str' }
            ]
        });
        return {
            backupPath,
            restore,
            gridExercise: mode => request('POST', route, { action: 'gridExercise', mode }),
            async apply(action) {
                if (action.protection) {
                    await inject('protection', '', {
                        start: 55.2, release: 55, full: 55.4, exportGuardEnabled: false, ...action.protection
                    }, 'str');
                }
                if (action.refreshForecast) {
                    await request('POST', `/inject/${refresh.id}`, {});
                    await wait(1500);
                    await request('POST', route, { action: 'remember',
                        requirePositive: (scenario.controller.forecastWatts || 0) > 0 });
                }
                if (action.forecastFault) {
                    await request('POST', route, { action: 'fault', fault: action.forecastFault });
                    await inject('command', 'scenario-recalculate', null);
                }
                if (action.command) await inject('command', action.command.topic, action.command.payload);
            }
        };
    } catch (error) {
        try { await restore(); } catch (cleanupError) {
            throw new ScenarioCleanupError([error, cleanupError], `${error.message}; ${cleanupError.message}`);
        }
        throw error;
    }
}

module.exports = { CONTEXT_KEYS, contextBridgeSource, preserveController };
