import json
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import weekly_settings
from local_bridge import Handler


class WeeklySettingsTests(unittest.TestCase):
    def test_private_settings_round_trip_and_invalid_writes_preserve_previous_values(self):
        with tempfile.TemporaryDirectory() as directory, patch("weekly_settings.settings_path", return_value=Path(directory) / "weekly-template.json"):
            self.assertEqual(weekly_settings.get_weekly_settings(), dict.fromkeys(weekly_settings.FIELDS, ""))
            settings = {"email": "weekly@example.com", "contactPerson": "Example contact", "organization": "Example team"}
            self.assertEqual(weekly_settings.save_weekly_settings(settings), settings)
            self.assertEqual(weekly_settings.get_weekly_settings(), settings)
            for bad in [{**settings, "email": "invalid"}, {**settings, "contactPerson": "first\nsecond"}, {**settings, "organization": "x" * 301}, {**settings, "unexpected": True}]:
                with self.assertRaises(ValueError):
                    weekly_settings.save_weekly_settings(bad)
                self.assertEqual(weekly_settings.get_weekly_settings(), settings)
            weekly_settings.settings_path().write_text("{broken", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "无法读取"):
                weekly_settings.get_weekly_settings()
            weekly_settings.save_weekly_settings(settings)
            self.assertEqual(weekly_settings.get_weekly_settings(), settings)

    def test_http_requires_local_app_origin_and_never_exposes_settings_to_extensions(self):
        with tempfile.TemporaryDirectory() as directory, patch("weekly_settings.settings_path", return_value=Path(directory) / "weekly-template.json"):
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            connection = HTTPConnection(*server.server_address, timeout=3)
            try:
                settings = {"email": "weekly@example.com", "contactPerson": "Example contact", "organization": "Example team"}
                for method in ["GET", "POST"]:
                    for origin in ["https://example.com", "chrome-extension://example"]:
                        connection.request(method, "/weekly/template-settings", body=json.dumps(settings), headers={"Origin": origin, "Content-Type": "application/json"})
                        response = connection.getresponse()
                        self.assertEqual(response.status, 403)
                        self.assertNotIn("settings", json.loads(response.read()))
                for method in ["POST", "GET"]:
                    connection.request(method, "/weekly/template-settings", body=json.dumps(settings) if method == "POST" else None, headers={"Origin": "http://127.0.0.1:3000", "Content-Type": "application/json"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read())["settings"], settings)
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
