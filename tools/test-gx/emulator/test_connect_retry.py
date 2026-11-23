import contextlib
import io
import socket
import unittest
from unittest.mock import Mock, call

from mqtt_connect import connect_mqtt


class ConnectRetryTest(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        self.now = 0
        self.sleeps = []
        self.output = io.StringIO()

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    def connect(self, deadline_s=60):
        with contextlib.redirect_stdout(self.output):
            return connect_mqtt(self.client, 'mosquitto', 1883, 30, deadline_s,
                                sleep=self.sleep, clock=lambda: self.now)

    def test_dns_failure_twice_then_success(self):
        self.client.connect.side_effect = [
            socket.gaierror('Temporary failure in name resolution'),
            socket.gaierror('Temporary failure in name resolution'),
            0,
        ]
        self.assertEqual(self.connect(), 0)
        self.assertEqual(self.client.connect.call_args_list, [call('mosquitto', 1883, 30)] * 3)
        self.assertEqual(self.sleeps, [1, 2])
        self.assertIn('attempt 2, gaierror: Temporary failure in name resolution); retrying in 2 s',
                      self.output.getvalue())

    def test_unreachable_broker_reports_last_error_with_bounded_backoff(self):
        self.client.connect.side_effect = [
            OSError('network unreachable'), TimeoutError('timed out'),
            ConnectionRefusedError('connection refused'), OSError('still unavailable'),
            socket.gaierror('last DNS error'),
        ]
        with self.assertRaisesRegex(RuntimeError, r'mosquitto:1883 unreachable after 15 s: last DNS error'):
            self.connect(deadline_s=15)
        self.assertEqual(self.client.connect.call_count, 5)
        self.assertEqual(self.sleeps, [1, 2, 4, 5, 3])
        self.assertNotIn('retrying', self.output.getvalue().splitlines()[-1])

    def test_success_without_sleep(self):
        self.client.connect.return_value = 0
        self.assertEqual(self.connect(), 0)
        self.client.connect.assert_called_once_with('mosquitto', 1883, 30)
        self.assertEqual(self.sleeps, [])
        self.assertEqual(self.output.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
