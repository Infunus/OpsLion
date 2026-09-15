import json
import os
import sys
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from local_bridge import Handler
from rss_connector import RssConnector


class PublicBridgeTests(unittest.TestCase):
    def test_unconfigured_release_has_optional_rss_routes_without_an_external_provider(self):
        environment = patch.dict(os.environ, {"OPSLION_RSS_PROVIDER":"", "OPSLION_RSS_PYTHON":""})
        environment.start()
        self.addCleanup(environment.stop)
        connector = patch("local_bridge.rss", RssConnector(Path(__file__).resolve().parent / "fixtures" / "unconfigured-rss.json"))
        connector.start()
        self.addCleanup(connector.stop)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = HTTPConnection(*server.server_address, timeout=3)
            connection.request("GET", "/health")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"ok": True, "collector_version": 3})
            connection.request("GET", "/status")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())["available"], False)
            connection.request("GET", "/articles")
            response = connection.getresponse()
            self.assertEqual(json.loads(response.read())["articles"], [])
            for method, route in [("GET", "/articles/test"), ("GET", "/rss/management"), ("POST", "/refresh"), ("POST", "/rss/auth/start")]:
                with self.subTest(method=method, route=route):
                    connection.request(method, route, body="{}" if method == "POST" else None, headers={"Content-Type":"application/json"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    self.assertIn("尚未接入", json.loads(response.read())["message"])
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
