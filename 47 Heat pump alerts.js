// ==========================
// LOGIC SUMMARY / CHANGE NOTES
// ==========================
// Sync rule:
// - `47 Heat pump alerts.js` and the embedded `func` for "Heat pump alerts" in `flows.json`
//   must always stay synchronized.
// Purpose:
// - E-mail alerts when something goes wrong with the heat pump automation (d#145, owner request:
//   "send email in case of errors"). Collects alert events, waits a little so that one problem
//   gives one mail, and sends a digest through `tools/send-mail.js` (SMTP over TLS, settings and
//   app password in grid-control-config/email.json on the GX, not in the repo).
// Input:
// - msg.event (from "Heat pump automations" (40), output 6 = every automation log event)
// - msg.payload.devices (from "Heat pump state" (34), output 1 = page model): connection of the
//   heat pump, valve and bypass
// - msg.topic 'tick'    (inject, every 60 s): send the digest when it is due
// - msg.topic 'test'    (inject "Send test alert mail"): a test mail at once
// - msg.topic 'result'  (exec stdout of send-mail.js): { ok, error }
// Output (1):
// - output 1 -> file node "Write alert mail" (/tmp/hp-alert-mail.json) -> exec "Send alert mail"
// Alerts:
// - device write NOT confirmed (kind 'fail');
// - DHW controller warnings (Er03 end, valve ON outside a cycle, pump curve restored, state reset);
// - HP Er03 restart started; compressor protection steps and ends; DHW hard limit;
// - lost sequences / stuck write queue / unreadable settings;
// - heat pump, valve or bypass not connected or stale for 10 min (and when it is back).
// Throttling: a digest is sent 2 min after its first alert, at most one mail per 15 min; repeated
// identical texts are counted, not repeated. Without email.json the node shows the error and drops
// nothing (the digest waits, max 50 lines).
// Change notes:
// 1. Initial version (d#145).
// ==========================

const MAIL_FILE = '/tmp/hp-alert-mail.json';
const GATHER_MS = 2 * 60 * 1000;
const MIN_GAP_MS = 15 * 60 * 1000;
const DEVICE_DOWN_MS = 10 * 60 * 1000;
const MAX_LINES = 50;
const WATCH = { hp: 'heat pump', valve: 'boiler valve relay', bypass: 'bypass relay' };

const now = Date.now();
const st = context.get('st') || { pending: [], firstAt: 0, lastMailAt: 0, lastResult: null, down: {}, sentCount: 0 };
const hhmm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

function add(text, t) {
    const line = String(text).slice(0, 300);
    const same = st.pending.find((p) => p.text === line);
    if (same) { same.n++; same.last = t || now; }
    else if (st.pending.length < MAX_LINES) st.pending.push({ t: t || now, text: line, n: 1, last: t || now });
    if (!st.firstAt) st.firstAt = now;
}

function isAlert(e) {
    const tx = String(e.text || '');
    if (e.kind === 'fail' || e.kind === 'error') return true;
    if (e.rule === 'dhw' && (e.kind === 'warn' || (e.kind === 'stop' && !/controller Off|local control OFF/.test(tx)))) return true;
    if (e.rule === 'hp_fault' || e.rule === 'hp_device') return true;   // 'info' when a fault / device is back
    if (e.rule === 'hp_er03_restart' && e.kind === 'start') return true;
    if (/compressor protection|hard limit/.test(tx) && e.rule === 'dhw') return true;
    if (e.kind === 'warn' && /sequence dropped|write queue released|settings file unreadable/.test(tx)) return true;
    return false;
}

function mailMsg(subject, lines) {
    const flowModel = flow.get('heatPumpModel');
    const s = flowModel && flowModel.summary;
    const dv = flow.get('dhwView');
    const status = s ? ['', 'Now: tank ' + s.tank + ' °C, supply ' + s.supply + ' / return ' + s.ret + ' °C, outdoor ' + s.outdoor + ' °C, compressor '
        + s.compressorHz + ' Hz, valve ' + (s.valveToDhw ? 'DHW' : 'heating') + ', bypass ' + (s.bypassOn ? 'ON' : 'OFF')
        + (dv ? ', DHW controller ' + dv.state + ' (' + String(dv.why || '').slice(0, 120) + ')' : '')] : [];
    const text = lines.concat(status, ['', 'Automation log: dashboard → Automation log. Sent by the Cerbo GX (Heat pump alerts, 47).']).join('\n');
    return { topic: 'result', payload: JSON.stringify({ subject, text }), filename: MAIL_FILE };   // exec answers with topic 'result'
}

let send = null;

if (msg.topic === 'result') {
    let r = null; try { r = JSON.parse(String(msg.payload || '').trim().split('\n').pop()); } catch (e) { r = { ok: false, error: 'no answer from send-mail.js' }; }
    st.lastResult = { t: now, ok: !!(r && r.ok), error: r && r.error ? String(r.error).slice(0, 120) : '' };
    if (!st.lastResult.ok) node.warn('Heat pump alerts: mail not sent: ' + st.lastResult.error);
} else if (msg.topic === 'test') {
    send = mailMsg('Heat pump: test alert mail', ['Test mail from the Cerbo GX at ' + new Date(now).toString() + '.', 'If you read this, e-mail alerts work.']);
} else if (msg.event && typeof msg.event === 'object') {
    if (isAlert(msg.event)) add((msg.event.cloud ? msg.event.cloud + ': ' : '') + msg.event.text, msg.event.t);
} else if (msg.payload && Array.isArray(msg.payload.devices)) {
    for (const d of msg.payload.devices) {
        if (!WATCH[d.role]) continue;
        const bad = d.state !== 'CONNECTED' || d.stale;
        const rec = st.down[d.role] || { since: 0, alerted: false };
        if (bad) {
            if (!rec.since) rec.since = now;
            if (!rec.alerted && now - rec.since >= DEVICE_DOWN_MS) { add(WATCH[d.role] + ' ' + (d.stale ? 'stale' : d.state) + ' since ' + hhmm(rec.since)); rec.alerted = true; }
        } else {
            if (rec.alerted) add(WATCH[d.role] + ' connected again (was down since ' + hhmm(rec.since) + ')');
            rec.since = 0; rec.alerted = false;
        }
        st.down[d.role] = rec;
    }
}

// digest
if (!send && st.pending.length && now - st.firstAt >= GATHER_MS && now - st.lastMailAt >= MIN_GAP_MS) {
    const lines = st.pending.map((p) => hhmm(p.t) + '  ' + p.text + (p.n > 1 ? '  (×' + p.n + ', last ' + hhmm(p.last) + ')' : ''));
    const subject = 'Heat pump alert: ' + st.pending[0].text.slice(0, 80) + (st.pending.length > 1 ? ' (+' + (st.pending.length - 1) + ' more)' : '');
    send = mailMsg(subject, lines);
    st.pending = []; st.firstAt = 0;
}
if (send) { st.lastMailAt = now; st.sentCount++; }

context.set('st', st);
const lr = st.lastResult;
node.status({ fill: lr && !lr.ok ? 'red' : (st.pending.length ? 'yellow' : 'green'), shape: 'dot',
    text: (st.pending.length ? st.pending.length + ' waiting · ' : '') + 'mails ' + st.sentCount + (lr ? ' · last ' + hhmm(lr.t) + (lr.ok ? ' ok' : ' ERROR ' + lr.error.slice(0, 40)) : '') });
return send;
