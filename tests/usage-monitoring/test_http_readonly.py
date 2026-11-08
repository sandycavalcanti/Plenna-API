import importlib.util
import json
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

path = Path(__file__).resolve().parents[2] / 'scripts' / 'usage-monitoring-http-readonly.py'
spec = importlib.util.spec_from_file_location('rf017_http_readonly', path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class Response:
    status = 503
    headers = {'Content-Type': 'application/json'}
    def __init__(self, body): self.body = json.dumps(body).encode()
    def read(self, limit): return self.body[:limit]
    def __enter__(self): return self
    def __exit__(self, *args): pass

class ProbeTests(TestCase):
    def inspect(self, body):
        with patch.object(probe, 'build_opener') as factory:
            factory.return_value.open.return_value = Response(body)
            return probe.inspect('http://localhost:1', '/v2/tempo-uso/summary?month=2026-11', True)

    def test_codes_with_digits_are_not_silently_removed(self):
        result = self.inspect({'schemaVersion': 2, 'error': {'code': 'RF017_V2_NOT_ENABLED', 'message': 'Monitoramento v2 indisponível.'}})
        self.assertEqual(result['code'], 'RF017_V2_NOT_ENABLED')
        self.assertEqual(result['schemaVersion'], 2)

    def test_unknown_error_text_and_credentials_are_not_printed(self):
        result = self.inspect({'error': {'code': 'unexpected private-token', 'message': 'postgresql://user:private-password@private-host/db'}})
        self.assertNotIn('code', result)
        self.assertNotIn('message', result)
        self.assertNotIn('private-', json.dumps(result))

if __name__ == '__main__': main()
