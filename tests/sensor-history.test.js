'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { build, read, validateDay } = require('../tools/sensor-history');
const { loadNode } = require('./harness');
const { prepare } = require('../tools/gx/dashboard-assets');
const { stampDeployment } = require('../tools/deploy-version');
const day = '2026-11-12', t = Date.parse('2026-11-12T12:00:00Z');
const base = '#day ' + day + '\n#hp1 ' + day + ' 13 cols=t,st,102\n0,CCCCCC,30\n30,,,,31\n';

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
    assert.match(ambiguous.warnings[0],/multiple PIR/);
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
});

test('existing heat-pump and air archives are read without fabricating other sensor history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'sensor-history-'));
    try {
        fs.mkdirSync(path.join(dir,'heatpump',day),{recursive:true});
        fs.mkdirSync(path.join(dir,'air'));
        fs.writeFileSync(path.join(dir,'heatpump',day,'13.csv'),'#hp1 '+day+' 13 cols=t,st,102,104,atemp\n0,CCCCCC,30,55,42\n30,,,,56,\n');
        fs.writeFileSync(path.join(dir,'air',day+'.csv'),'13:00:00,800,1,2,3,22,40\n');
        const r = read(day,dir);
        assert.equal(r.series.length,4);
        assert.ok(r.series.some(s=>s.key==='hp:104'));
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
        fs.writeFileSync(file,'g.menu.length>0&&e("left")&&e("left").close()');
        const jobs = prepare(dir);
        assert.equal(jobs.length,2);
        assert.match(jobs[0].data,/waitFor/);
        for (const job of jobs) fs.writeFileSync(job.dest,job.data);
        assert.equal(prepare(dir).length,0);
        fs.writeFileSync(file,'unexpected');
        assert.throws(()=>prepare(dir),/refusing/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('local source labels preserve the recorded automation commit without pretending to be Git', () => {
    const flows = [{id:'f',type:'tab',label:'d#183 Test',info:''},
        {id:'b',type:'ui_base',site:{name:'Dashboard'}},{id:'p',type:'ui_tab',name:'Temperatures'}];
    const live = stampDeployment(flows,{dashboard:'a'.repeat(40),automations:'a'.repeat(40)});
    const local = stampDeployment(live,{dashboard:'local:'+'b'.repeat(64)},live);
    assert.match(local[0].label,/\[UI local bbbbbbbbbbbb; Auto aaaaaaaaaaaa\]/);
    assert.deepEqual(stampDeployment(local,{dashboard:'local:'+'b'.repeat(64)},local),local);
});
