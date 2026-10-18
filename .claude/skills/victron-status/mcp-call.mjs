#!/usr/bin/env node
// Calls the Victron grid-control MCP server (Node-RED on the Cerbo GX) and prints the results as JSON.
//
// Usage:
//   MCP_TOKEN=<token> node mcp-call.mjs [--url <url>] [--ca <pem> | --insecure] [tool ...]
//
//   tool      MCP tool names, e.g. get_system_overview get_capacity_tariff
//             "list" (or no tool) prints the available tools
//   --url     default https://venus.local:1881/mcp (the GX certificate is issued to venus.local)
//   --ca      PEM of the GX self-signed certificate; default ~/.claude/victron-gx.pem when it exists
//   --insecure  skip certificate checks (only if no CA file is available)
//
// The token is read from the MCP_TOKEN environment variable only (never from arguments or files),
// so it does not end up in the shell history or on disk.
// get_battery_driver_status / get_device_status trigger a fresh check on the GX; when their data is
// missing or older than 60 s the script waits 6 s and reads them again.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

const args = process.argv.slice(2);
let url = 'https://venus.local:1881/mcp';
let caPath = path.join(os.homedir(), '.claude', 'victron-gx.pem');
let insecure = false;
const tools = [];

for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--url') { url = args[++index]; }
    else if (arg === '--ca') { caPath = args[++index]; }
    else if (arg === '--insecure') { insecure = true; }
    else { tools.push(arg); }
}

const token = String(process.env.MCP_TOKEN || '').trim();
if (!token) {
    console.error('MCP_TOKEN is not set. Ask the user for the token from the dashboard page "Agent (MCP)".');
    process.exit(2);
}

const target = new URL(url);
const isHttps = target.protocol === 'https:';
const ca = isHttps && !insecure && fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined;
if (isHttps && !insecure && !ca) {
    console.error('No CA file at ' + caPath + ' - pass --ca <pem> or --insecure.');
    process.exit(2);
}

let nextId = 1;

function rpc(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: params || {} });
    const options = {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(body)
        },
        timeout: 20000
    };
    if (isHttps) {
        options.ca = ca;
        options.rejectUnauthorized = !insecure;
        options.servername = target.hostname;
    }
    return new Promise((resolve, reject) => {
        const req = (isHttps ? https : http).request(options, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 401) { return reject(new Error('401 Unauthorized - the token is wrong or was regenerated')); }
                if (res.statusCode === 403) { return reject(new Error('403 Forbidden - ' + data.trim().substring(0, 120))); }
                if (res.statusCode === 503) { return reject(new Error('503 - MCP server disabled on the GX (enable it on the Agent (MCP) page)')); }
                let json;
                try { json = JSON.parse(data); }
                catch (error) { return reject(new Error('HTTP ' + res.statusCode + ', not JSON: ' + data.substring(0, 160))); }
                if (json.error) { return reject(new Error(json.error.code + ' ' + json.error.message)); }
                resolve(json.result);
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout after 20 s - is this computer on the GX network (or VPN)?')));
        req.on('error', error => reject(new Error((error.code || '') + ' ' + error.message)));
        req.end(body);
    });
}

async function callTool(name, toolArgs) {
    const result = await rpc('tools/call', { name, arguments: toolArgs || {} });
    const text = result && result.content && result.content[0] ? result.content[0].text : '';
    try { return JSON.parse(text); }
    catch (error) { return { text }; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const REFRESHING = ['get_battery_driver_status', 'get_device_status'];

try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'victron-status-skill', version: '1' } });
    const output = { server: init.serverInfo, url };

    if (!tools.length || tools.includes('list')) {
        const list = await rpc('tools/list');
        output.tools = list.tools.map(tool => ({ name: tool.name, description: tool.description }));
    }

    for (const name of tools.filter(tool => tool !== 'list')) {
        let data = await callTool(name, REFRESHING.includes(name) ? { refresh: true } : {});
        if (REFRESHING.includes(name) && (data.available === false || (data.ageSeconds !== undefined && data.ageSeconds > 60))) {
            await sleep(6000);
            data = await callTool(name, { refresh: false });
        }
        output[name] = data;
    }

    console.log(JSON.stringify(output, null, 2));
}
catch (error) {
    console.error('MCP call failed: ' + error.message);
    process.exit(1);
}
