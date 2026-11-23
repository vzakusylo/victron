'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { build, read, prune, validateDay, isRoomSensorKey } = require('../tools/sensor-history');
const { decode } = require('../tools/heatpump-decode');
const { loadNode } = require('./harness');
const { prepare, repair } = require('../tools/gx/dashboard-assets');
const { stampDeployment } = require('../tools/deploy-version');
const day = '2026-11-12', t = Date.parse('2026-11-12T12:00:00Z');
const base = '#day ' + day + '\n#hp1 ' + day + ' 13 cols=t,st,102\n0,CCCCCC,30\n30,,,,31\n';
const dashboardBundle = 'g.menu.length>0&&e("left")&&e("left").close();' +
    'angular.module("ui",["ngMaterial","ngMdIcons","ngSanitize","ngTouch","sprintf","chart.js","color.picker"]);';
const dashboardIndex = '<body ng-swipe-right="onSwipeRight();" ng-swipe-left="onSwipeLeft();" ' +
    'ng-attr-ng-swipe-disable-mouse="{{main.allowSwipe !== \'mouse\' ? \'\' : undefined}}">Dashboard</body>';

function roomPolicy(meta = {}) {
    const request = loadNode('50 Devices model.js').run({ topic: 'tick' }, { now: t }).result[1];
    // Unwrap the outer sh -c argument, then execute only its local Node classifier, not the device polling.
    const script = request.payload.slice(1, -1).replaceAll("'\\''", "'");
    const [, classifier, fixedIds] = /node -e '([^']+)' [^\n]+\/sensor-history\.js '([^']+)'/.exec(script);
    return require('node:child_process').execFileSync(process.execPath,
        ['-e', classifier, path.join(__dirname, '..', 'tools', 'sensor-history.js'), fixedIds],
        { encoding: 'utf8', input: JSON.stringify(meta) }).trim();
}

test('Devices reads the room exclusions from the history tool', () => {
    assert.deepEqual(JSON.parse(roomPolicy({ room: {} })), ['hp', 'acc', 'plate']);
    for (const key of ['hp:102', 'acc:Temperature', 'plate:Temperature', 'plate:x']) assert.equal(isRoomSensorKey(key), false, key);
    assert.equal(isRoomSensorKey('air-monitor:Temperature'), true);
});

test('toilet chart uses actual PIR/clear reports, not battery wakes, other devices or cached state', () => {
    const n = loadNode('38 Build heat pump history.js');
    n.flow.set('bathroomMotion', { id: 'toilet' });
    const reports = [{ t, id: 'toilet', dps: { 101: 'pir' }, source: 'local' },
        { t, id: 'toilet', dps: { 101: 'pir' }, source: 'cloud report' },
        { t: t+1000, id: 'toilet', dps: { 102: 'high' }, source: 'local' },
        { t: t+2000, id: 'other', dps: { 101: 'pir' }, source: 'local' },
        { t: t+3000, id: 'toilet', dps: { 101: 'none' }, source: 'cloud report' }];
    const result = n.run({topic:'day',day,payload:base+'#motion available\n'+reports.map(JSON.stringify).join('\n')+'\nbad JSON'}, {now:t});
    assert.equal(result.result.payload.chart.motion.count,1);
    assert.equal(result.result.payload.chart.motion.events.length,2);
    assert.equal(result.result.payload.chart.motion.errors,1);
    assert.match(result.warnings[0],/invalid sensor reports/);
    const missing = n.run({topic:'day',day,payload:base}, {now:t}).result.payload.chart.motion;
    assert.equal(missing.available,false);
});

test('temperature recorder rejects stale/future values and does not resample a sleeping sensor', () => {
    const n = loadNode('58 Record sensor temperatures.js');
    const sensors = [{key:'room',name:'Room',t,value:21,online:true},
        {key:'stale',t,value:19,online:false},{key:'future',t:t+10000,value:20,online:true}];
    const msg = {payload:{temperatureSensors:sensors,updated:new Date(t).toISOString()}};
    assert.equal(n.run(msg,{now:t}).result[0].length,1);
    assert.equal(n.run(msg,{now:t+1000}).result[0].length,0);
});

test('cloud PIR history can identify the sole known motion sensor before a local wake, without guessing among several', () => {
    const n = loadNode('50 Devices model.js');
    const meta = {toilet:{name:'Toilet PIR',dps:{101:{code:'pir_state'}}}};
    const result = n.run({topic:'read',payload:'@@META\n'+JSON.stringify(meta)+'\n@@DBUSJSON {"services":[]}'},{now:t}).result[0].payload;
    assert.equal(result.motionSensorId,'toilet');
    assert.equal(n.flow.get('motionSensorId'),'toilet');
    meta.other = meta.toilet;
    const ambiguous = n.run({topic:'read',payload:'@@META\n'+JSON.stringify(meta)+'\n@@DBUSJSON {"services":[]}'},{now:t});
    assert.equal(ambiguous.result[0].payload.motionSensorId,'');
    assert.ok(ambiguous.warnings.some(warning => /multiple PIR/.test(warning)));
});

test('Devices catalog and Temperatures chart/table keep room and Air Monitor temperatures only', () => {
    const n = loadNode('50 Devices model.js');
    n.flow.set('heatPump',{hp:{state:'CONNECTED',lastData:t,dps:{101:30,102:36,103:-2,108:47}}});
    const meta = { room: { name: 'Living room', dps: { 1: { code: 'temp_current' } } } };
    const keys = n.run({topic:'read',payload:'@@ROOM_EXCLUSIONS\n'+roomPolicy(meta)+'\n@@META\n'+JSON.stringify(meta)+'\n@@DBUSJSON {"services":[]}'},{now:t}).result[0].payload.temperatureSensors.map(s=>s.key);
    assert.deepEqual(keys, ['room:Temperature', 'air-monitor:Temperature']);
    const allKeys = ['hp:102', 'hp:103', 'acc:Temperature', 'plate:Temperature', ...keys];
    const c = { sensors: allKeys.map(key => ({ key, name: key })) };
    const s = allKeys.map(key => ({ key, name: key, t, value: 20 }));
    const r = build(day,c,s,[],false,[day]);
    assert.deepEqual(r.sensors.map(x=>x.key), keys);
    assert.deepEqual(r.series.map(x=>x.key), keys);
});

test('history keeps empty sensors, averages measured buckets and does not connect long gaps', () => {
    const c = {sensors:[{key:'room',name:'Room',value:21},{key:'empty',name:'Empty',value:null}],motionId:'toilet'};
    const s = [{key:'room',name:'Room',t,value:20},{key:'room',name:'Room',t:t+30000,value:22},
        {key:'room',name:'Room',t:t+3600000,value:23}];
    const r = build(day,c,s,[],false,[day,'2026-11-11']);
    assert.equal(r.series[0].points[0].value,21);
    assert.equal(r.series[0].lines.length,0);
    assert.equal(r.sensors.find(s=>s.key==='empty').samples,0);
    assert.equal(r.motion.available,false);
    assert.throws(()=>validateDay('2026-02-30'));
    assert.throws(()=>validateDay('../secrets'));
});

test('day navigation ignores delayed or other-client responses for a different day', () => {
    const script = fs.readFileSync(path.join(__dirname,'..','59 Temperatures page.html'),'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
    let watch;
    const scope = {$watch:(_,cb)=>watch=cb,$on:()=>{},send:()=>{}};
    new Function('scope','setTimeout','setInterval','clearTimeout','clearInterval',script)(scope,()=>0,()=>0,()=>{},()=>{});
    scope.loadTemp('2026-11-14');
    watch({topic:'sensorHistory',payload:{day:'2026-11-15'}});
    assert.equal(scope.busy,true);
    assert.equal(scope.s.day,undefined);
    watch({topic:'sensorHistory',payload:{day:'2026-11-14',days:['2026-11-15','2026-11-14']}});
    assert.equal(scope.busy,false);
    assert.equal(scope.selected,'2026-11-14');
    watch({topic:'sensorHistory',payload:{day:'2026-11-15'}});
    assert.equal(scope.selected,'2026-11-14');
    scope.loadTemp('2026-11-13');
    watch({topic:'sensorHistory',payload:{error:'Archive access denied'}});
    assert.equal(scope.busy,false);
    assert.equal(scope.selected,'2026-11-14');
    assert.deepEqual(scope.s.days,['2026-11-15','2026-11-14']);
    assert.equal(scope.s.error,'Archive access denied');
    scope.loadTemp('2026-11-13');
    assert.equal(scope.busy,true);
});

test('corrupt JSONL and invalid typed rows preserve valid history, navigation and visible diagnostics', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sensor-history-corrupt-'));
    try {
        fs.mkdirSync(path.join(dir,'temperatures'));
        fs.mkdirSync(path.join(dir,'sensor-events'));
        fs.writeFileSync(path.join(dir,'temperatures','catalog.json'),JSON.stringify({sensors:[{key:'room',name:'Room'}],motionId:'toilet'}));
        const samples = [{key:'room',t,value:21},{key:'room',t:'bad',value:21},null,{key:'room',t,value:'warm'}];
        fs.writeFileSync(path.join(dir,'temperatures',day+'.jsonl'),samples.map(JSON.stringify).join('\n')+'\n{"key":"room","val');
        fs.writeFileSync(path.join(dir,'temperatures','2026-11-11.jsonl'),'');
        const reports = [{t,id:'toilet',dps:{101:'pir'},source:'local'},null,{t:1e20,id:'toilet',dps:{101:'pir'}}];
        fs.writeFileSync(path.join(dir,'sensor-events',day+'.jsonl'),reports.map(JSON.stringify).join('\n')+'\n{"t":');
        const result = read(day,dir);
        assert.equal(result.invalidRows,7);
        assert.equal(result.sensors[0].samples,1);
        assert.equal(result.series[0].points[0].value,21);
        assert.equal(result.motion.count,1);
        assert.deepEqual(result.days,[day,'2026-11-11']);
        const ui = loadNode('57 Sensor history.js').run({topic:'read',payload:JSON.stringify(result)});
        assert.equal(ui.result[0].payload.invalidRows,7);
        assert.match(ui.warnings[0],/skipped 7 invalid archive rows/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('bad archive times and nonnumeric cells are counted without poisoning later delta samples', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sensor-history-cells-'));
    try {
        fs.mkdirSync(path.join(dir,'air'));
        const text = '#hp1 '+day+' 13 cols=t,st,102,104\n0,CCCCCC,30,55\noops,CCCCCC,99,99\n30,,,\n60,,bad,56\n90,,31,\n';
        fs.writeFileSync(path.join(dir,'air',day+'.csv'),'99:00:00,800,1,2,3,22\n13:00:00,800,1,2,3,bad\n13:02:00,800,1,2,3,22\n');
        const result = read(day,dir);
        assert.equal(result.invalidRows,2);
        assert.deepEqual(result.sensors.map(s=>s.key),['air-monitor:Temperature']);
        assert.equal(result.series.find(s=>s.key==='air-monitor:Temperature').points[0].value,22);
        assert.throws(()=>[...decode(text)],/invalid sample time/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('recorder and reader count archived temperatures once, including redundant legacy JSONL rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sensor-history-recording-'));
    try {
        const sensors = [{key:'hp:102',name:'Supply',t,value:30,online:true},
            {key:'air-monitor:Temperature',name:'Air',t,value:22,online:true},
            {key:'room',name:'Room',t,value:21,online:true},
            {key:'acc:Temperature',name:'Accumulator',t,value:43,online:true},
            {key:'plate:Temperature',name:'Plate',t,value:32,online:true}];
        const n = loadNode('58 Record sensor temperatures.js');
        const msg = {payload:{temperatureSensors:sensors,updated:new Date(t).toISOString()}};
        const outputs = n.run(msg,{now:t}).result;
        const row = JSON.parse(outputs[0][0].payload);
        assert.deepEqual(row,{key:'room',t,value:21});
        assert.equal(outputs[2].topic,'prune');
        assert.equal(outputs[2].payload,'--prune');
        assert.equal(n.run(msg,{now:t+1000}).result[2],null);
        assert.equal(n.run(msg,{now:t+86400000}).result[2].topic,'prune');
        fs.mkdirSync(path.join(dir,'temperatures'));
        fs.mkdirSync(path.join(dir,'heatpump',day),{recursive:true});
        fs.mkdirSync(path.join(dir,'air'));
        fs.writeFileSync(path.join(dir,'temperatures','catalog.json'),outputs[1].payload);
        fs.writeFileSync(path.join(dir,'temperatures',day+'.jsonl'),outputs[0][0].payload+sensors.filter(s=>s.key!=='room').map(JSON.stringify).join('\n'));
        fs.writeFileSync(path.join(dir,'heatpump',day,'13.csv'),'#hp1 '+day+' 13 cols=t,st,102,atemp,xtemp\n0,CCCCCC,30,43,32\n');
        fs.writeFileSync(path.join(dir,'air',day+'.csv'),'13:00:00,800,1,2,3,22\n');
        const result = read(day,dir);
        assert.equal(result.invalidRows,0);
        assert.deepEqual(result.sensors.map(s=>[s.key,s.samples]),[['air-monitor:Temperature',1],['room',1]], 'room sensors only, each counted once');
        assert.equal(result.series.find(s=>s.key==='room').name,'Room');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('retention removes only regular dated temperature logs older than 400 days', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sensor-history-retention-'));
    try {
        const folder = path.join(dir,'temperatures');
        fs.mkdirSync(folder);
        const boundary = new Date(t-400*86400000).toISOString().slice(0,10);
        const expired = new Date(t-401*86400000).toISOString().slice(0,10);
        for (const file of [expired+'.jsonl',boundary+'.jsonl',day+'.jsonl','catalog.json','notes.jsonl','2025-02-30.jsonl']) {
            fs.writeFileSync(path.join(folder,file),'keep');
        }
        fs.mkdirSync(path.join(folder,'2024-01-01.jsonl'));
        fs.mkdirSync(path.join(dir,'sensor-events'));
        fs.writeFileSync(path.join(dir,'sensor-events',expired+'.jsonl'),'keep');
        assert.equal(prune(dir,t).pruned,1);
        assert.equal(fs.existsSync(path.join(folder,expired+'.jsonl')),false);
        for (const file of [boundary+'.jsonl',day+'.jsonl','catalog.json','notes.jsonl','2025-02-30.jsonl','2024-01-01.jsonl']) {
            assert.equal(fs.existsSync(path.join(folder,file)),true);
        }
        assert.equal(fs.existsSync(path.join(dir,'sensor-events',expired+'.jsonl')),true);
        const failure = loadNode('57 Sensor history.js').run({topic:'prune',payload:'{"error":"Permission denied"}'});
        assert.equal(failure.result,null);
        assert.match(failure.warnings[0],/Permission denied/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('motion tooltips use Oslo time in winter, summer and both repeated autumn hours', () => {
    const cases = [[day,[t],['13:00:00']],['2026-07-02',[Date.parse('2026-07-01T22:30:00Z')],['00:30:00']],
        ['2026-10-25',[Date.parse('2026-10-25T00:30:00Z'),Date.parse('2026-10-25T01:30:00Z')],['02:30:00','02:30:00']]];
    for (const [d,times,expected] of cases) {
        const reports = times.map(t=>({t,id:'toilet',dps:{101:'pir'},source:'local'}));
        const result = build(d,{motionId:'toilet'},[],reports,true,[d]);
        assert.deepEqual(result.motion.events.map(e=>e.time),expected);
    }
});

test('default history day follows Oslo midnight even when the Node-RED server clock is UTC', () => {
    const before = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
        const n = loadNode('57 Sensor history.js');
        for (const [now,expected] of [['2026-07-01T22:30:00Z','2026-07-02'],['2026-11-12T23:30:00Z','2026-11-13']]) {
            assert.equal(n.run({topic:'ui',payload:{}},{now}).result[1].day,expected);
            assert.equal(n.run({topic:'ui',payload:{day:'2026-11-11'}},{now}).result[1].day,'2026-11-11');
        }
    } finally {
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
    }
});

test('heat pump archives are not read; the air archive still is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sensor-history-'));
    try {
        fs.mkdirSync(path.join(dir,'heatpump',day),{recursive:true});
        fs.mkdirSync(path.join(dir,'air'));
        fs.writeFileSync(path.join(dir,'heatpump',day,'13.csv'),'#hp1 '+day+' 13 cols=t,st,102,104,atemp\n0,CCCCCC,30,55,42\n30,,,,56,\n');
        fs.writeFileSync(path.join(dir,'air',day+'.csv'),'13:00:00,800,1,2,3,22,40\n');
        const r = read(day,dir);
        assert.deepEqual(r.series.map(s=>s.key),['air-monitor:Temperature']);
        assert.ok(r.series.some(s=>s.key==='air-monitor:Temperature'));
        assert.equal(r.motion.available,false);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('bootstrap asset preparation is idempotent and refuses unfamiliar code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-assets-'));
    try {
        fs.mkdirSync(path.join(dir,'dist','js'),{recursive:true});
        fs.writeFileSync(path.join(dir,'package.json'),'{"version":"3.6.6"}');
        const file = path.join(dir,'dist','js','app.min.js');
        fs.writeFileSync(file,dashboardBundle);
        fs.writeFileSync(path.join(dir,'dist','index.html'),dashboardIndex);
        const jobs = prepare(dir);
        assert.equal(jobs.length,3);
        const bundle = jobs[0].data.toString('utf8');
        assert.match(bundle,/waitFor/);
        const modules = [];
        const bootstrap = bundle.match(/angular\.module\("ui",\[[^\]]+\]\)/)[0];
        new Function('angular', bootstrap)({ module: (name, dependencies) => modules.push(...dependencies) });
        assert.ok(modules.includes('ngMaterial'));
        assert.ok(!modules.includes('ngTouch'), 'Material must not receive the conflicting ngTouch services');
        for (const job of jobs) fs.writeFileSync(job.dest,job.data);
        assert.equal(prepare(dir).length,0);
        fs.writeFileSync(file,dashboardBundle + dashboardBundle);
        assert.throws(()=>prepare(dir),/refusing/);
        fs.writeFileSync(file,'unexpected');
        assert.throws(()=>prepare(dir),/refusing/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Material swipe replacement retains touch swipes and permits mouse only in mouse mode', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-swipe-'));
    t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
    fs.mkdirSync(path.join(dir,'dist','js'),{recursive:true});
    fs.writeFileSync(path.join(dir,'package.json'),'{"version":"3.6.6"}');
    fs.writeFileSync(path.join(dir,'dist','js','app.min.js'),dashboardBundle);
    fs.writeFileSync(path.join(dir,'dist','index.html'),dashboardIndex);
    const html = prepare(dir).find(job => job.dest.endsWith('index.html')).data.toString('utf8');
    assert.ok(!html.includes('ng-swipe-'), 'ngTouch directives must be replaced, not left as a broken fallback');
    for (const direction of ['Left', 'Right']) {
        const expression = html.match(new RegExp('md-swipe-' + direction.toLowerCase() + '="([^"]+)"'))[1];
        const run = new Function('main','$event','onSwipe' + direction,'return ' + expression);
        for (const [pointer, source] of [['t',{}], ['p',{pointerType:'touch'}]]) {
            let calls = 0;
            run({allowSwipe:'true'},{pointer:{type:pointer},srcEvent:source},() => calls++);
            assert.equal(calls,1,'touch should invoke the existing controller once');
        }
        for (const [pointer, source] of [['m',{}], ['p',{pointerType:'mouse'}], ['p',{pointerType:4}]]) {
            for (const mode of ['true','menu','mouse']) {
                let calls = 0;
                run({allowSwipe:mode},{pointer:{type:pointer},srcEvent:source},() => calls++);
                assert.equal(calls,mode === 'mouse' ? 1 : 0,mode + ' mouse-swipe behavior');
            }
        }
    }
});

test('standalone Dashboard repair is dry by default, backed up, idempotent and restores partial writes', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-repair-'));
    t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
    const root = path.join(dir,'node_modules','node-red-dashboard');
    const app = path.join(root,'dist','js','app.min.js'), index = path.join(root,'dist','index.html');
    fs.mkdirSync(path.dirname(app),{recursive:true});
    fs.writeFileSync(path.join(root,'package.json'),'{"version":"3.6.6"}');
    fs.writeFileSync(app,dashboardBundle);
    fs.writeFileSync(index,dashboardIndex);
    fs.writeFileSync(path.join(dir,'flows.json'),'untouched flow');
    const dry = repair(root);
    assert.equal(dry.backup,null);
    assert.equal(fs.readFileSync(app,'utf8'),dashboardBundle);
    assert.equal(fs.readFileSync(index,'utf8'),dashboardIndex);
    const rename = fs.renameSync;
    try {
        fs.renameSync = (from,to) => {
            if (to === index) throw new Error('simulated index replacement failure');
            return rename(from,to);
        };
        assert.throws(() => repair(root,true),/prior written assets restored.*simulated index/);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(app,'utf8'),dashboardBundle);
    assert.equal(fs.readFileSync(index,'utf8'),dashboardIndex);
    try {
        fs.renameSync = (from,to) => {
            if (to === index) {
                fs.writeFileSync(app,'external change');
                throw new Error('simulated concurrent replacement');
            }
            return rename(from,to);
        };
        assert.throws(() => repair(root,true),/rollback incomplete\. Backup: .*Concurrent asset change/);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(app,'utf8'),'external change','rollback must preserve a concurrent external write');
    fs.writeFileSync(app,dashboardBundle);
    const applied = repair(root,true);
    const saved = JSON.parse(fs.readFileSync(path.join(applied.backup,'files.json'),'utf8'));
    assert.equal(fs.readFileSync(saved.find(file=>file.dest===app).saved,'utf8'),dashboardBundle);
    assert.equal(fs.readFileSync(saved.find(file=>file.dest===index).saved,'utf8'),dashboardIndex);
    assert.equal(fs.readFileSync(path.join(dir,'flows.json'),'utf8'),'untouched flow');
    assert.equal(prepare(root).length,0);
    assert.deepEqual(repair(root,true),{jobs:[],backup:null});
    fs.writeFileSync(path.join(root,'package.json'),'{"version":"4.0.0"}');
    assert.throws(() => repair(root,true),/only supports version 3\.6\.6/);
});

test('Dashboard repair preserves original bytes in patches, backups and rollback', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-bytes-'));
    t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
    const root = path.join(dir,'node_modules','node-red-dashboard');
    const app = path.join(root,'dist','js','app.min.js'), index = path.join(root,'dist','index.html');
    fs.mkdirSync(path.dirname(app),{recursive:true});
    fs.writeFileSync(path.join(root,'package.json'),'{"version":"3.6.6"}');
    const tail = Buffer.concat([Buffer.from('\n// ' + String.fromCodePoint(0x416,0x1f600)),Buffer.from([0xff,0xfe])]);
    const beforeApp = Buffer.concat([Buffer.from(dashboardBundle),tail]);
    const beforeIndex = Buffer.concat([Buffer.from(dashboardIndex),tail]);
    fs.writeFileSync(app,beforeApp);
    fs.writeFileSync(index,beforeIndex);
    const rename = fs.renameSync;
    try {
        fs.renameSync = (from,to) => {
            if (to === index) throw new Error('simulated byte-exact rollback');
            return rename(from,to);
        };
        assert.throws(() => repair(root,true),/prior written assets restored/);
    } finally { fs.renameSync = rename; }
    assert.ok(fs.readFileSync(app).equals(beforeApp));
    assert.ok(fs.readFileSync(index).equals(beforeIndex));
    const applied = repair(root,true);
    const saved = JSON.parse(fs.readFileSync(path.join(applied.backup,'files.json'),'utf8'));
    for (const [file,original] of [[app,beforeApp],[index,beforeIndex]]) {
        assert.ok(fs.readFileSync(saved.find(entry=>entry.dest===file).saved).equals(original),'backup must be byte-exact');
        assert.ok(fs.readFileSync(file).subarray(-tail.length).equals(tail),'unmodified bytes must survive the patch');
    }
    assert.deepEqual(repair(root,true),{jobs:[],backup:null});
});

test('local code dry-run leaves missing or unfamiliar Dashboard assets alone', async (t) => {
    const http = require('node:http'), crypto = require('node:crypto');
    const { deploy } = require('../tools/gx/deploy-local');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'gx-local-assets-'));
    t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
    const assets = path.join(dir,'.node-red','node_modules','node-red-dashboard');
    fs.mkdirSync(path.join(assets,'dist','js'),{recursive:true});
    fs.writeFileSync(path.join(assets,'package.json'),'{"version":"3.6.6"}');
    fs.writeFileSync(path.join(assets,'dist','js','app.min.js'),dashboardBundle);
    const index = path.join(assets,'dist','index.html');
    fs.writeFileSync(index,'owner-customized index');
    const original = {rev:'rev-1',flows:[
        {id:'tab',type:'tab',label:'d#187 Test',info:''},
        {id:'base',type:'ui_base',site:{name:'Dashboard'}},
        {id:'page',type:'ui_tab',name:'Page'},
        {id:'dv-fn-01',type:'function',wires:[]}
    ]};
    const originalText = JSON.stringify(original.flows);
    fs.writeFileSync(path.join(dir,'.node-red','flows.json'),originalText);
    let posts = 0;
    const server = http.createServer((req,res) => {
        if (req.method === 'POST') posts++;
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify(original));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>server.close());
    const files = {};
    for (const [name,data] of [
        ['tools/deploy-version.js',fs.readFileSync(path.join(__dirname,'..','tools','deploy-version.js'))],
        ['tools/gx/live-snapshot.js',Buffer.from('module.exports = {};')],
        ['tools/gx/window.js',Buffer.from('module.exports = {collect: async () => ({}), judge: () => ({safe:true}), format: () => "SAFE"};')],
        ['tools/gx/dashboard-assets.js',fs.readFileSync(path.join(__dirname,'..','tools','gx','dashboard-assets.js'))]
    ]) files[name] = {data:data.toString('base64'),hash:crypto.createHash('sha256').update(data).digest('hex')};
    const content = {files,patch:{},newNodes:[],recorder:null,label:'d#187 Test',wire:{id:'dv-fn-01',before:[],value:[]}};
    const plan = path.join(dir,'plan.json');
    fs.writeFileSync(plan,JSON.stringify({expectRev:'rev-1',source:'local:'+crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex'),content}));
    const names = ['VICTRON_HOME','VICTRON_API_PORT','DRY'];
    const previous = names.map(name=>process.env[name]);
    t.after(() => names.forEach((name,i) => {
        if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    }));
    process.env.VICTRON_HOME = dir;
    process.env.VICTRON_API_PORT = String(server.address().port);
    process.env.DRY = '1';
    await deploy(plan);
    assert.equal(fs.readFileSync(index,'utf8'),'owner-customized index');
    fs.unlinkSync(index);
    await deploy(plan);
    assert.ok(!fs.existsSync(index));
    assert.equal(fs.readFileSync(path.join(assets,'dist','js','app.min.js'),'utf8'),dashboardBundle);
    assert.equal(fs.readFileSync(path.join(dir,'.node-red','flows.json'),'utf8'),originalText);
    assert.equal(posts,0);
    assert.ok(!fs.readdirSync(dir).some(name=>name.startsWith('.gx-local-stage.')));
});

test('local source labels preserve the recorded automation commit without pretending to be Git', () => {
    const flows = [{id:'f',type:'tab',label:'d#183 Test',info:''},
        {id:'b',type:'ui_base',site:{name:'Dashboard'}},{id:'p',type:'ui_tab',name:'Temperatures'}];
    const live = stampDeployment(flows,{dashboard:'a'.repeat(40),automations:'a'.repeat(40)});
    const local = stampDeployment(live,{dashboard:'local:'+'b'.repeat(64)},live);
    assert.match(local[0].label,/\[UI local bbbbbbbbbbbb; Auto aaaaaaaaaaaa\]/);
    assert.deepEqual(stampDeployment(local,{dashboard:'local:'+'b'.repeat(64)},local),local);
});
