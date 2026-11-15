#!/usr/bin/env node
// Owner-requested work-tree deployment. No Git mutation or remote download.
// Prepare on PC: node tools/gx/deploy-local.js --prepare LIVE.b64 PLAN.json
// On GX: node deploy-local.js PLAN.json (dry); DRY=0 node deploy-local.js PLAN.json
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib'), http = require('http');
const { execFileSync } = require('child_process');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const norm = (s) => String(s || '').replace(/\r\n/g, '\n');
const fail = (s) => { throw new Error(s); };
const ROOT = path.resolve(__dirname, '..', '..');
function prepare(snapshotFile, output) {
    const raw = fs.readFileSync(snapshotFile, 'utf8').replace(/[^A-Za-z0-9+/=]/g, '');
    const live = JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')));
    const flows = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows.json')));
    const { snapshot } = require('./live-snapshot');
    const { diffSnapshots, buildPatch } = require('./compare');
    const diff = diffSnapshots(live, snapshot(flows));
    const byId = new Map(flows.map(n => [n.id,n]));
    const old = new Map(live.nodes.map(n => [n.id,n]));
    const patch = {};
    for (const [id, fields] of Object.entries(buildPatch(diff, false))) {
        patch[id] = Object.fromEntries(fields.map(field => [field, { before:hash(norm(old.get(id).code[field])), value:byId.get(id)[field] }]));
    }
    const newNodes = diff.onlyRepo.map(n => byId.get(n.id));
    if (newNodes.some(n => !n.id.startsWith('temps-'))) fail('Unreviewed new node outside the temperature page');
    const files = {};
    for (const file of ['tools/sensor-history.js','tools/heatpump-decode.js','tools/elvenett-statistics.js','tools/deploy-version.js','tools/gx/live-snapshot.js','tools/gx/window.js','tools/gx/dashboard-assets.js','tools/gx/deploy-local.js']) {
        const data = fs.readFileSync(path.join(ROOT,file));
        files[file] = { data:data.toString('base64'), hash:hash(data) };
    }
    const stats = fs.readFileSync(path.join(ROOT,'.secrets','elvenett-statistics.json'));
    const parsed = JSON.parse(stats);
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.months)) fail('Invalid Elvenett import');
    files['grid-control-config/elvenett-statistics.json'] = {data:stats.toString('base64'),hash:hash(stats)};
    const content = { patch, newNodes, files, label:flows.find(n=>n.type==='tab'&&/d#\d+/.test(n.label)).label,
        recorder:old.has('temps-record-01')?{before:old.get('temps-record-01').rest,outputs:byId.get('temps-record-01').outputs,wires:byId.get('temps-record-01').wires}:null,
        wire:{id:'dv-fn-01',before:old.has('temps-record-01')?byId.get('dv-fn-01').wires:[['dv-page-01'],['dv-exec-01']],value:byId.get('dv-fn-01').wires} };
    const plan = { expectRev:live.rev, source:'local:'+hash(JSON.stringify(content)), content };
    fs.writeFileSync(output,JSON.stringify(plan),{mode:0o600});
    console.log('Prepared '+plan.source+'; '+Object.keys(patch).length+' existing nodes, '+newNodes.length+' new nodes');
}
function api(method, url, body) {
    return new Promise((resolve,reject) => {
        const req = http.request({host:'127.0.0.1',port:Number(process.env.VICTRON_API_PORT)||1880,path:url,method,
            headers:{'Node-RED-API-Version':'v2','Content-Type':'application/json','Node-RED-Deployment-Type':'nodes'}},res=>{
            let text=''; res.on('data',b=>text+=b); res.on('end',()=>{
                if (res.statusCode<200||res.statusCode>=300) return reject(new Error(method+' '+url+' -> '+res.statusCode));
                try {resolve(JSON.parse(text));} catch(e) {reject(e);}
            });
        });
        req.setTimeout(15000,()=>req.destroy(new Error('Admin API timeout')));
        req.on('error',reject); if(body) req.write(JSON.stringify(body)); req.end();
    });
}
async function deploy(file) {
    const home = process.env.VICTRON_HOME || '/data/home/nodered';
    const p = JSON.parse(fs.readFileSync(file));
    if (!p.expectRev || p.source !== 'local:'+hash(JSON.stringify(p.content))) fail('Invalid local plan fingerprint');
    const c = p.content;
    const stage = fs.mkdtempSync(path.join(home,'.gx-local-stage.'));
    try {
        for (const [name,item] of Object.entries(c.files)) {
            if (!/^tools\/(?:gx\/)?[\w.-]+\.js$/.test(name) && name !== 'grid-control-config/elvenett-statistics.json') fail('Unexpected file '+name);
            const data=Buffer.from(item.data,'base64'); if(hash(data)!==item.hash) fail('File hash mismatch '+name);
            const dest=path.join(stage,name); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest,data);
            if(name.endsWith('.js')) execFileSync(process.execPath,['--check',dest]);
        }
        const {stampDeployment} = require(path.join(stage,'tools/deploy-version.js'));
        const {snapshot} = require(path.join(stage,'tools/gx/live-snapshot.js'));
        const {collect,judge,format} = require(path.join(stage,'tools/gx/window.js'));
        const original=await api('GET','/flows');
        if(original.rev!==p.expectRev) fail('Live revision changed: take a fresh snapshot');
        const verdict=judge(await collect());
        console.log(format(verdict)); if(!verdict.safe) fail('Unsafe deployment window');
        const payload=JSON.parse(JSON.stringify(original));
        const byId=new Map(payload.flows.map(n=>[n.id,n]));
        for(const [id,fields] of Object.entries(c.patch)) {
            const n=byId.get(id); if(!n) fail('Missing node '+id);
            for(const [field,v] of Object.entries(fields)) {
                if(!['func','initialize','finalize','format','command'].includes(field)||hash(norm(n[field]))!==v.before) fail('Unexpected live code '+id+'.'+field);
                n[field]=v.value;
            }
        }
        if(c.wire.id!=='dv-fn-01'||JSON.stringify(byId.get(c.wire.id).wires)!==JSON.stringify(c.wire.before)) fail('Unexpected Devices wiring');
        byId.get(c.wire.id).wires=c.wire.value;
        if(c.recorder) {
            const n=byId.get('temps-record-01');
            if(!n||snapshot([n]).nodes[0].rest!==c.recorder.before) fail('Unexpected temperature recorder configuration');
            if(c.recorder.outputs!==3||JSON.stringify(c.recorder.wires)!==JSON.stringify([['temps-file-01'],['temps-catalog-01'],['temps-exec-01']])) fail('Unreviewed temperature recorder wiring');
            n.outputs=c.recorder.outputs;
            n.wires=c.recorder.wires;
        }
        for(const n of c.newNodes) {if(!n.id.startsWith('temps-')||byId.has(n.id)) fail('New node collision '+n.id);payload.flows.push(n);byId.set(n.id,n);}
        for(const n of payload.flows) for(const output of n.wires||[]) for(const id of output) if(!byId.has(id)) fail('Missing wire target '+id);
        const tab=payload.flows.find(n=>n.type==='tab'&&/d#\d+/.test(n.label));
        if(Number(/d#(\d+)/.exec(tab.label)[1])>Number(/d#(\d+)/.exec(c.label)[1])) fail('Live version is newer');
        tab.label=c.label;
        const stamped=stampDeployment(payload,{dashboard:p.source},original);
        console.log(c.label+'; source '+p.source);
        console.log('Dashboard package assets are not changed; use dashboard-assets.js separately for a reviewed repair.');
        if(process.env.DRY!=='0') {console.log('DRY RUN - nothing changed');return;}
        const backup=path.join(home,'.node-red','backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'-pre-local');
        fs.mkdirSync(backup,{mode:0o700});
        for(const name of ['flows.json','flows_cred.json']) fs.copyFileSync(path.join(home,'.node-red',name),path.join(backup,name));
        fs.writeFileSync(path.join(backup,'original-live.json'),JSON.stringify(original),{mode:0o600});
        fs.writeFileSync(path.join(backup,'plan.json'),JSON.stringify(p),{mode:0o600});
        console.log('BACKUP '+backup);
        const owner=fs.statSync(path.join(home,'tools'));
        const saved=[];
        const jobs=Object.keys(c.files).map(name=>({dest:path.join(home,name),data:fs.readFileSync(path.join(stage,name))}));
        try {
            for(const job of jobs) {
                const folder=path.dirname(job.dest);
                if(!fs.existsSync(folder)) {fs.mkdirSync(folder,{recursive:true,mode:0o755});fs.chownSync(folder,owner.uid,owner.gid);}
                if(!fs.lstatSync(folder).isDirectory()) fail('Unsafe destination directory '+folder);
                const stat=fs.existsSync(job.dest)?fs.lstatSync(job.dest):null;
                if(stat&&!stat.isFile()) fail('Destination is not a regular file '+job.dest);
                const previous=stat?path.join(backup,'file-'+saved.length):null;
                if(previous) fs.copyFileSync(job.dest,previous);
                saved.push({dest:job.dest,previous,stat});
                fs.writeFileSync(job.dest+'.gx-new',job.data,{mode:stat?stat.mode&0o777:0o644,flag:'wx'});
                fs.chownSync(job.dest+'.gx-new',stat?stat.uid:owner.uid,stat?stat.gid:owner.gid);
                fs.renameSync(job.dest+'.gx-new',job.dest);
            }
            fs.writeFileSync(path.join(backup,'files.json'),JSON.stringify(saved),{mode:0o600});
            await api('POST','/flows',stamped);
        } catch(e) {
            let live; try {live=await api('GET','/flows');} catch(readError) {console.error('Cannot determine flow state: '+readError.message);}
            if(live&&live.rev===p.expectRev) for(const s of saved.reverse()) {if(s.previous) fs.copyFileSync(s.previous,s.dest);else fs.rmSync(s.dest,{force:true});}
            else console.error('Flow state changed or unknown; preserve files and recover from '+backup);
            throw e;
        }
        await new Promise(resolve=>setTimeout(resolve,4000));
        const after=await api('GET','/flows'), got=new Map(after.flows.map(n=>[n.id,n]));
        for(const [id,fields] of Object.entries(c.patch)) for(const [field,v] of Object.entries(fields)) if(norm(got.get(id)[field])!==norm(v.value)) fail('Verification failed '+id+'.'+field);
        if(after.flows.length!==stamped.flows.length) fail('Node count verification failed');
        if(c.recorder&&(got.get('temps-record-01').outputs!==c.recorder.outputs||JSON.stringify(got.get('temps-record-01').wires)!==JSON.stringify(c.recorder.wires))) fail('Recorder wiring verification failed');
        for(const n of c.newNodes) if(!got.has(n.id)||got.get(n.id).type!==n.type) fail('New node verification failed '+n.id);
        for(const n of original.flows.filter(n=>n.type==='tuya-smart-device'||n.id==='hpa-fn-01')) if(JSON.stringify(got.get(n.id))!==JSON.stringify(n)) fail('An untouched controller/device changed '+n.id);
        console.log('DEPLOYED '+got.get(tab.id).label+'; rev '+after.rev);
    } finally {fs.rmSync(stage,{recursive:true,force:true});}
}
module.exports={prepare,deploy};
if(require.main===module) {
    const args=process.argv.slice(2);
    Promise.resolve().then(()=>args[0]==='--prepare'?prepare(args[1],args[2]):deploy(args[0]))
        .catch(e=>{console.error('ABORT '+e.message);process.exitCode=1;});
}
