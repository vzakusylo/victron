// The deployment stamper keeps the Git source in the suffix of the editor flow label.
const label = env.get('NR_FLOW_NAME');
const version = typeof label === 'string' && label.match(/d#\d+/);
const source = version && label.match(/ \[(?:git ([a-f0-9]{12})|UI ([a-f0-9]{12}); Auto (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded))\]$/);
const sha = source && (source[1] || source[2]);

msg.headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
msg.payload = { text: version ? version[0] + (sha ? ' \u00b7 ' + sha.slice(0, 7) : '') : '' };
return msg;
