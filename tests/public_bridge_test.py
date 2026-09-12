import json
import sys
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from local_bridge import Handler


class PublicBridgeTests(unittest.TestCase):
    def test_removed_collection_routes_are_unavailable_but_health_works(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = HTTPConnection(*server.server_address, timeout=3)
            connection.request("GET", "/health")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"ok": True})
            for method, route in [("GET", "/status"), ("GET", "/articles"), ("GET", "/articles/test"), ("GET", "/rss/management"), ("GET", "/legacy/weeks"), ("POST", "/refresh"), ("POST", "/rss/auth/start")]:
                with self.subTest(method=method, route=route):
                    connection.request(method, route)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 404)
                    response.read()
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
