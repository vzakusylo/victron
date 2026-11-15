"""Qingping test messages only; acknowledge success after a QoS 1 broker acknowledgement."""
import json
import re
import threading


def validate_message(body):
    if not isinstance(body, dict):
        raise ValueError('request must be a JSON object')
    topic = body.get('topic')
    match = re.fullmatch(r'qingping/(02:00:(?:[0-9a-f]{2}:){3}[0-9a-f]{2}|0200[0-9a-f]{8})/up', topic or '', re.I)
    if not match:
        raise ValueError('topic must be qingping/<fake 02:00 MAC>/up without wildcards')
    payload = body.get('payload')
    if not isinstance(payload, dict):
        raise ValueError('payload must be a Qingping JSON object')
    if 'mac' in payload:
        mac = payload['mac']
        if not isinstance(mac, str) or mac.replace(':', '').lower() != match[1].replace(':', '').lower():
            raise ValueError('payload.mac must match the fake MAC in topic')
    data = json.dumps(payload, allow_nan=False)
    if len(data.encode('utf8')) > 262144:
        raise ValueError('payload exceeds 256 KiB')
    return topic, data


def publish_message(topic, data):
    import paho.mqtt.client as mqtt

    connected = threading.Event()
    result = []
    try:
        client = mqtt.Client()
    except ValueError as error:
        raise RuntimeError('incompatible paho MQTT client') from error

    def on_connect(client, userdata, flags, rc):
        result.append(rc)
        connected.set()

    client.on_connect = on_connect
    try:
        client.connect('mosquitto', 1883, keepalive=10)
        client.loop_start()
        if not connected.wait(5):
            raise TimeoutError('MQTT connection acknowledgement timed out')
        if result[0] != 0:
            raise RuntimeError('MQTT broker refused connection')
        message = client.publish(topic, data, qos=1, retain=False)
        if message.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError('MQTT publish failed')
        message.wait_for_publish(timeout=5)
        if not message.is_published():
            raise TimeoutError('MQTT publish acknowledgement timed out')
    finally:
        client.disconnect()
        client.loop_stop()
