"""Retry the emulator's initial broker connection before starting Paho's loop."""

import time


MQTT_READY_TIMEOUT = 30


def connect_mqtt(client, host, port, keepalive, deadline_s=60, *,
                 sleep=time.sleep, clock=time.monotonic):
    if deadline_s <= 0:
        raise ValueError('EMU_MQTT_CONNECT_TIMEOUT must be positive')

    deadline = clock() + deadline_s
    attempt = 0
    delay = 1
    while True:
        attempt += 1
        try:
            return client.connect(host, port, keepalive)
        except OSError as error:  # Includes DNS errors, connection refusals and timeouts.
            last_error = error

        failure = (f'MQTT connect to {host}:{port} failed '
                   f'(attempt {attempt}, {type(last_error).__name__}: {last_error})')
        # A synchronous connect can overrun the budget; don't start a new one after it.
        remaining = deadline - clock()
        if remaining <= delay:
            print(failure, flush=True)
            if remaining > 0:
                sleep(remaining)
            break
        print(f'{failure}; retrying in {delay} s', flush=True)
        sleep(delay)
        if clock() >= deadline:
            break
        delay = min(delay * 2, 5)

    raise RuntimeError(
        f'MQTT broker {host}:{port} unreachable after {deadline_s} s: {last_error}'
    ) from last_error
