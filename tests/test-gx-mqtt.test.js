const test = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('Qingping publisher validates fake identities and requires a broker acknowledgement', () => {
    const script = `
import json, sys, types
from unittest.mock import Mock, patch
sys.path.insert(0, sys.argv[1])
from mqtt_publish import validate_message, publish_message

topic = 'qingping/02:00:aa:bb:cc:dd/up'
payload = {'type': 12, 'mac': '0200AABBCCDD', 'sensorData': [{'co2': {'value': 678}}]}
assert json.loads(validate_message({'topic': topic, 'payload': payload})[1]) == payload
for body in [
    [], {'topic': 'qingping/+/up', 'payload': payload},
    {'topic': 'qingping/aa:bb:cc:dd:ee:ff/up', 'payload': payload},
    {'topic': topic, 'payload': []},
    {'topic': topic, 'payload': {'mac': '020000000000'}},
    {'topic': topic, 'payload': {'co2': float('nan')}},
    {'topic': topic, 'payload': {'large': 'x' * 262145}},
]:
    try:
        validate_message(body)
    except ValueError:
        pass
    else:
        raise AssertionError('invalid message accepted')

client = Mock()
message = client.publish.return_value
message.rc = 0
message.is_published.return_value = True
client.loop_start.side_effect = lambda: client.on_connect(client, None, {}, 0)
mqtt = types.ModuleType('paho.mqtt.client')
mqtt.Client = Mock(return_value=client)
mqtt.MQTT_ERR_SUCCESS = 0
paho = types.ModuleType('paho')
paho.mqtt = types.ModuleType('paho.mqtt')
paho.mqtt.client = mqtt
with patch.dict(sys.modules, {'paho': paho, 'paho.mqtt': paho.mqtt, 'paho.mqtt.client': mqtt}):
    publish_message(topic, '{}')
    client.connect.assert_called_with('mosquitto', 1883, keepalive=10)
    client.publish.assert_called_with(topic, '{}', qos=1, retain=False)
    message.wait_for_publish.assert_called_with(timeout=5)
    client.disconnect.assert_called()
    client.loop_stop.assert_called()
    message.is_published.return_value = False
    try:
        publish_message(topic, '{}')
    except TimeoutError:
        pass
    else:
        raise AssertionError('unacknowledged publish reported success')
    client.connect.side_effect = OSError('broker unavailable')
    try:
        publish_message(topic, '{}')
    except OSError:
        pass
    else:
        raise AssertionError('connection failure reported success')
    mqtt.Client.side_effect = ValueError('callback API incompatible')
    try:
        publish_message(topic, '{}')
    except RuntimeError as error:
        assert 'incompatible paho' in str(error)
    else:
        raise AssertionError('incompatible client treated as bad request')
with patch.dict(sys.modules, {'paho.mqtt.client': None}):
    try:
        publish_message(topic, '{}')
    except ImportError:
        pass
    else:
        raise AssertionError('missing paho was not surfaced to the API 503 handler')
`;
    execFileSync(process.platform === 'win32' ? 'py' : 'python3',
        ['-B', '-c', script, path.join(__dirname, '..', 'tools', 'test-gx', 'emulator')], { stdio: 'pipe' });
});
