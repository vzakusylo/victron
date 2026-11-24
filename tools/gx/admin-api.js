'use strict';

// Also appended to scripts piped over SSH, where there is no sibling file to require.
function createAdminApi({
    port = Number(process.env.VICTRON_API_PORT) || 1880,
    getTimeoutMs = Number(process.env.VICTRON_API_GET_TIMEOUT_MS) || 30000,
    writeTimeoutMs = 120000,
    measureTtfb = false
} = {}) {
    const http = require('http');
    const { performance } = require('perf_hooks');
    const retryDelays = [1000, 3000];
    const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']);
    const transientStatuses = new Set([502, 503, 504]);

    async function requestOnce(method, urlPath, body, headers, timeoutMs) {
        let timer;
        try {
            return await new Promise((resolve, reject) => {
                const start = performance.now();
                const request = http.request({
                    host: '127.0.0.1', port, path: urlPath, method,
                    headers: { 'Node-RED-API-Version': 'v2', ...headers }
                }, (res) => {
                    res.on('error', reject);
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
                        res.destroy();
                        return;
                    }
                    const ttfb = performance.now() - start;
                    let text = '';
                    if (measureTtfb) res.resume();
                    else {
                        res.setEncoding('utf8');
                        res.on('data', chunk => { text += chunk; });
                    }
                    res.on('end', () => resolve(measureTtfb ? ttfb : text));
                });
                request.on('error', reject);
                timer = setTimeout(() => {
                    const error = Object.assign(new Error(`timeout after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
                    reject(error);
                    request.destroy(error);
                }, timeoutMs);
                request.end(body);
            });
        } finally {
            clearTimeout(timer);
        }
    }

    return async function api(method, urlPath, body, headers) {
        const read = method === 'GET';
        const maxAttempts = read ? retryDelays.length + 1 : 1;
        for (let attempt = 1; ; attempt++) {
            try {
                return await requestOnce(method, urlPath, body, headers, read ? getTimeoutMs : writeTimeoutMs);
            } catch (error) {
                const detail = error.message;
                const transient = transientCodes.has(error.code) || transientStatuses.has(error.status);
                if (!transient || attempt === maxAttempts) {
                    throw Object.assign(new Error(`${method} ${urlPath} failed after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${detail}`),
                        { status: error.status });
                }
                console.error(`api retry      : ${method} ${urlPath} (attempt ${attempt + 1}/${maxAttempts}: ${detail})`);
                await new Promise(resolve => setTimeout(resolve, retryDelays[attempt - 1]));
            }
        }
    };
}

if (module.id !== '[stdin]') module.exports = createAdminApi;
