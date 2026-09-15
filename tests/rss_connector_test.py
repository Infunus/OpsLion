import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from rss_connector import RssConnector


class RssConnectorTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"OPSLION_RSS_PROVIDER": "", "OPSLION_RSS_PYTHON": ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        work = Path(__file__).resolve().parents[1] / "work" / "rss-tests"
        work.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=work)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "paths.json"
        self.connector = RssConnector(self.config)

    def install_fake(self, source):
        provider = self.root / "synthetic provider.py"
        provider.write_text(source, encoding="utf-8")
        self.config.write_text(json.dumps({"rss_provider": str(provider), "rss_python": sys.executable}), encoding="utf-8")

    def test_unconfigured_install_reads_empty_sources_without_a_collector(self):
        self.assertFalse(self.connector.call("status")["available"])
        self.assertEqual(self.connector.call("articles")["articles"], [])
        with self.assertRaisesRegex(ValueError, "尚未接入"):
            self.connector.call("refresh", {"start_date": "2026-09-01", "end_date": "2026-09-11"})

    def test_range_and_account_are_forwarded_without_platform_dependencies(self):
        self.install_fake("import json,sys\nprint(json.dumps({'operation':sys.argv[1],'payload':json.load(sys.stdin)}))")
        payload = {"start_date": "2026-09-01", "end_date": "2026-09-11", "mp_ids": ["synthetic"]}
        self.assertEqual(self.connector.call("refresh", payload), {"operation": "refresh", "payload": payload})

    def test_provider_error_is_reported_without_dumping_stderr(self):
        self.install_fake("import json,sys\nprint('private-secret',file=sys.stderr)\nprint(json.dumps({'error':True,'message':'需要重新登录'}))\nsys.exit(1)")
        with self.assertRaisesRegex(ValueError, "需要重新登录") as result:
            self.connector.call("refresh")
        self.assertNotIn("private-secret", str(result.exception))

    def test_invalid_provider_output_is_not_silently_treated_as_success(self):
        self.install_fake("print('not json')")
        with self.assertRaisesRegex(ValueError, "有效 JSON"):
            self.connector.call("status")

    def test_configuration_is_reread_and_accepts_utf8_bom(self):
        self.assertFalse(self.connector.call("status")["available"])
        self.install_fake("import json\nprint(json.dumps({'protocol':'opslion-rss/v1','available':True,'feeds':[]}))")
        self.config.write_text(self.config.read_text(encoding="utf-8"), encoding="utf-8-sig")
        self.assertTrue(self.connector.call("status")["available"])
        self.config.write_text("{}", encoding="utf-8")
        self.assertFalse(self.connector.call("status")["available"])

    def test_malformed_config_and_wrong_paths_have_actionable_errors(self):
        for value in ["{bad json", "[]"]:
            self.config.write_text(value, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "JSON"):
                self.connector.call("status")
        self.config.write_text(json.dumps({"rss_provider": "relative.py"}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "rss_provider"):
            self.connector.call("status")
        self.install_fake("print('{}')")
        config = json.loads(self.config.read_text(encoding="utf-8"))
        config["rss_python"] = str(self.root / "missing-python.exe")
        self.config.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "rss_python"):
            self.connector.call("status")

    def test_protocol_and_status_shape_are_checked(self):
        for payload, message in [({"protocol":"other/v1","available":True}, "协议不兼容"), ({"protocol":"opslion-rss/v1","available":"yes"}, "状态格式"), ([], "JSON 对象")]:
            self.install_fake("print(" + repr(json.dumps(payload)) + ")")
            with self.assertRaisesRegex(ValueError, message):
                self.connector.call("status")

    def test_environment_overrides_config_and_provider_runs_in_its_own_directory(self):
        self.install_fake("import json,os,sys\nprint(json.dumps({'cwd':os.getcwd(),'payload':json.load(sys.stdin),'op':sys.argv[1]}))")
        provider = self.root / "synthetic provider.py"
        self.config.write_text("{}", encoding="utf-8")
        with patch.dict(os.environ, {"OPSLION_RSS_PROVIDER":str(provider), "OPSLION_RSS_PYTHON":sys.executable}):
            value = self.connector.call("article", {"id":"含空格的文章"})
        self.assertEqual(Path(value["cwd"]), self.root)
        self.assertEqual(value["payload"], {"id":"含空格的文章"})
        self.assertEqual(value["op"], "article")

    def test_timeout_launch_errors_and_unknown_operations_are_bounded(self):
        self.install_fake("print('{}')")
        with patch("rss_connector.subprocess.run", side_effect=subprocess.TimeoutExpired("synthetic", 30)):
            with self.assertRaisesRegex(ValueError, "超时"):
                self.connector.call("status")
        with patch("rss_connector.subprocess.run", side_effect=OSError("private details")):
            with self.assertRaisesRegex(ValueError, "无法启动") as result:
                self.connector.call("status")
            self.assertNotIn("private details", str(result.exception))
        with patch("rss_connector.subprocess.run") as run:
            with self.assertRaisesRegex(ValueError, "不支持"):
                self.connector.call("arbitrary")
            run.assert_not_called()


class RssHttpTests(unittest.TestCase):
    def setUp(self):
        import local_bridge
        self.fake = patch.object(local_bridge.rss, "call", side_effect=lambda operation, payload=None: {"operation":operation,"payload":payload or {}})
        self.provider = self.fake.start()
        self.addCleanup(self.fake.stop)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), local_bridge.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, method, route, payload=None, origin="http://127.0.0.1:3000"):
        client = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            client.request(method, route, body=json.dumps(payload) if payload is not None else None, headers={"Origin":origin, "Content-Type":"application/json"})
            response = client.getresponse()
            return response.status, json.loads(response.read()), response.getheader("Cache-Control")
        finally:
            client.close()

    def test_management_routes_forward_only_the_declared_operations(self):
        for route, operation in [("auth/start","auth_start"),("auth/check","auth_check"),("auth/cancel","auth_cancel"),("auth/logout","auth_logout"),("feeds/resolve","feed_resolve"),("feeds/add","feed_add"),("feeds/update","feed_update")]:
            status, value, cache = self.request("POST", "/rss/"+route, {"synthetic":"payload"})
            self.assertEqual(status,200)
            self.assertEqual(value,{"operation":operation,"payload":{"synthetic":"payload"}})
            self.assertEqual(cache,"no-store")
        self.assertEqual(self.request("GET","/rss/management")[1]["operation"],"management")
        self.assertEqual(self.request("GET","/rss/auth/poll?session_id=synthetic")[1],{"operation":"auth_poll","payload":{"session_id":"synthetic"}})

    def test_cross_origin_unknown_and_oversized_mutations_never_reach_provider(self):
        for route, payload, origin, expected in [
            ("/rss/auth/logout",{},"https://untrusted.invalid",403),
            ("/rss/arbitrary",{},"http://127.0.0.1:3000",404),
            ("/rss/feeds/add",{"text":"a"*8200},"http://127.0.0.1:3000",400),
            ("/rss/feeds/add",[],"http://127.0.0.1:3000",400),
        ]:
            self.assertEqual(self.request("POST",route,payload,origin)[0],expected)
        self.provider.assert_not_called()

    def test_status_pagination_jobs_and_cancel_forward_through_http(self):
        self.assertEqual(self.request("GET", "/status")[1], {"operation":"status","payload":{}})
        self.assertEqual(self.request("GET", "/articles?start_date=2026-09-01&end_date=2026-09-02&offset=500&limit=500")[1], {"operation":"articles","payload":{"start_date":"2026-09-01","end_date":"2026-09-02","offset":"500","limit":"500"}})
        payload = {"start_date":"2026-09-01","end_date":"2026-09-02","mp_ids":[]}
        code, value, cache = self.request("POST", "/refresh", payload)
        self.assertEqual(code, 202)
        self.assertEqual(value, {"operation":"refresh","payload":payload})
        self.assertEqual(cache, "no-store")
        self.assertEqual(self.request("GET", "/refresh/status")[1]["operation"], "refresh_status")
        self.assertEqual(self.request("POST", "/refresh/cancel", {})[1]["operation"], "cancel")

    def test_foreign_origin_cannot_query_auth_or_fetch_missing_content(self):
        for route in ["/rss/auth/poll?session_id=example", "/articles/example?ensure_content=1", "/status"]:
            self.assertEqual(self.request("GET", route, origin="https://untrusted.invalid")[0], 403)
        self.provider.assert_not_called()

    def test_full_article_export_passes_the_optional_body_request(self):
        self.request("GET","/articles/synthetic?ensure_content=1")
        self.provider.assert_called_with("article", {"id":"synthetic","ensure_content":True})
        self.request("GET","/articles/synthetic")
        self.provider.assert_called_with("article", {"id":"synthetic"})


if __name__ == "__main__":
    unittest.main()
