"""Deterministic raw forecast.solar responses; no upstream requests."""
import datetime
import math


def forecast_fixture(query):
    day = query.get('date', [''])[0]
    parsed = datetime.datetime.strptime(day, '%Y-%m-%d')
    if parsed.strftime('%Y-%m-%d') != day:
        raise ValueError('date must use YYYY-MM-DD')
    watts = float(query.get('watts', ['0'])[0])
    if not math.isfinite(watts) or not 0 <= watts <= 20000:
        raise ValueError('watts must be finite and between 0 and 20000')
    return {
        'result': {f'{day} {hour:02d}:00:00': watts if 11 <= hour <= 17 else 0
                   for hour in range(24)},
        'message': {'code': 0, 'type': 'success', 'text': 'Test GX fixture',
                    'ratelimit': {'period': 3600, 'limit': 12, 'remaining': 11}}
    }
