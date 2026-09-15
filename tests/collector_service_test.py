import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from collector_service import CollectorService, read_json, validate_range, write_json
from collector_browser import default_runtime_directory, executable_from_command, resolve_browser


class CollectorServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="opslion-collector-test-")
        self.runtime = Path(self.temporary.name).resolve()
        self.assertEqual(self.runtime.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.runtime.name.startswith("opslion-collector-test-"))
        self.service = CollectorService(ROOT / "config" / "local.paths.json", runtime=self.runtime)

    def tearDown(self):
        self.temporary.cleanup()

    def test_fresh_install_never_imports_existing_rss_credentials_or_accounts(self):
        with patch.object(self.service, "_python", return_value=sys.executable), patch.object(self.service, "_browser", return_value=None):
            status = self.service.status()
        self.assertEqual(status["accounts"], [])
        self.assertEqual(status["session"]["state"], "unknown")
        self.assertEqual(status["exports"], [])
        serialized = json.dumps(status)
        self.assertNotIn(str(self.runtime), serialized)
        self.assertNotIn("rss_python", serialized)
        self.assertFalse((self.runtime / "chrome-profile").exists())

    def test_rejects_path_traversal_dates_and_stale_resume(self):
        for payload in ({"start_date": "2026-02-30", "end_date": "2026-03-01"}, {"start_date": "2026-09-20", "end_date": "2026-09-01"}):
            with self.assertRaises(ValueError):
                validate_range(payload)
        for identifier, kind in (("../../config", "zip"), ("a" * 24, "../../config")):
            with self.assertRaises(ValueError):
                self.service.download(identifier, kind)
        with self.assertRaises(ValueError):
            self.service.start({"action": "resume", "job_id": "stale"})

    def test_verification_opens_default_browser_once_and_preserves_resume(self):
        job = {"id": "verification-job", "action": "collect", "state": "running", "payload": {"action": "collect", "start_date": "2026-09-07", "end_date": "2026-09-13"}}
        write_json(self.runtime / "job.json", job)
        write_json(self.runtime / "last-collection.json", job)
        write_json(self.runtime / "verification.json", {"id": "challenge", "state": "pending", "url": "https://weread.qq.com/", "created_at": time.time() * 1000})
        with patch.object(self.service, "_command", return_value='{"running":true}') as command:
            outcome = self.service._open_verification(job, "C:/Browser/msedge.exe", {})
            repeated = self.service._open_verification(job, "C:/Browser/msedge.exe", {})
        self.assertTrue(outcome["browser_opened"])
        self.assertEqual(repeated, outcome)
        self.assertEqual(command.call_count, 2)
        args = command.call_args_list[0].args[0]
        self.assertEqual(args[args.index("-Browser") + 1], "C:/Browser/msedge.exe")
        self.assertEqual(args[args.index("-Mode") + 1], "Visible")
        self.assertIn("-SwitchMode", args)
        self.service._progress(job, state="paused", result=outcome)
        self.assertEqual(read_json(self.runtime / "last-collection.json")["payload"], job["payload"])
        self.assertNotIn("url", json.dumps(outcome))
        self.assertEqual(read_json(self.runtime / "session.json")["state"], "verification")

    def test_verification_open_failure_stays_paused_and_cancel_never_opens(self):
        job = {"id": "challenge", "action": "login", "state": "running", "payload": {"action": "login"}}
        write_json(self.runtime / "job.json", job)
        with patch.object(self.service, "_command", side_effect=OSError("window unavailable")):
            result = self.service._open_verification(job, "C:/Browser/msedge.exe", {})
        self.assertEqual(result["state"], "paused")
        self.assertFalse(result["browser_opened"])
        self.assertIn("重新打开验证页面", result["message"])
        (self.runtime / "challenge.cancel").touch()
        with patch.object(self.service, "_command") as command:
            self.assertEqual(self.service._open_verification(job, "C:/Browser/msedge.exe", {})["state"], "cancelled")
            command.assert_not_called()

    def test_only_structured_verification_result_triggers_handoff(self):
        for result in ({"state": "paused", "code": "verification"}, {"state": "paused", "message": "网络超时"}, {"state": "paused", "message": "预算已用完"}, {"state": "paused", "message": "二维码已过期"}):
            with self.subTest(result=result):
                job = {"id": "worker", "action": "login", "state": "running", "payload": {"action": "login"}}
                write_json(self.runtime / "job.json", job)
                with patch.object(self.service, "_browser", return_value="C:/Browser/msedge.exe"), patch.object(self.service, "_python", return_value=sys.executable), patch.object(self.service, "_select_profile"), patch.object(self.service, "_command", side_effect=['{"running":true}', result]), patch.object(self.service, "_open_verification", return_value=result) as handoff:
                    self.service._run(job)
                self.assertEqual(handoff.call_count, 1 if result.get("code") == "verification" else 0)

    def test_default_browser_takes_precedence_and_unsupported_defaults_are_not_replaced(self):
        edge, chrome, firefox = [self.runtime / name for name in ("msedge.exe", "chrome.exe", "firefox.exe")]
        for file in (edge, chrome, firefox):
            file.touch()
        self.assertEqual(executable_from_command('"C:\\Program Files\\Browser\\msedge.exe" --single-argument %1'), r"C:\Program Files\Browser\msedge.exe")
        with patch("collector_browser.default_browser", return_value={"executable": str(edge)}):
            self.assertEqual(resolve_browser({"weread_fetcher_chrome": str(chrome)}), str(edge))
        with patch("collector_browser.default_browser", return_value={"executable": str(firefox)}):
            self.assertIsNone(resolve_browser({"weread_fetcher_chrome": str(chrome)}))

    @unittest.skipUnless(os.name == "nt", "Windows known folders")
    def test_runtime_does_not_change_with_a_packaged_hosts_local_appdata(self):
        expected = default_runtime_directory()
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.runtime / "host-sandbox")}):
            self.assertEqual(default_runtime_directory(), expected)

    def test_switching_browser_uses_a_separate_profile_and_preserves_previous_data(self):
        config = read_json(self.service.config_path)
        previous = Path(config["chromeProfileDir"])
        previous.mkdir(parents=True)
        (previous / "Local State").write_text("fixture", encoding="utf-8")
        write_json(self.runtime / "browser.json", {"browser": "chrome", "profiles": {"chrome": str(previous)}})
        self.service._select_profile(str(self.runtime / "msedge.exe"))
        selected = read_json(self.service.config_path)
        self.assertEqual(Path(selected["chromeProfileDir"]), self.runtime / "browser-profiles" / "msedge")
        self.assertEqual((previous / "Local State").read_text(encoding="utf-8"), "fixture")
        self.assertEqual(read_json(self.runtime / "session.json")["state"], "unknown")
        self.service._select_profile(str(self.runtime / "chrome.exe"))
        self.assertEqual(read_json(self.service.config_path)["chromeProfileDir"], str(previous))

    def test_qr_download_requires_the_current_live_login_and_expires(self):
        identifier = "a" * 32
        self.service.active = identifier
        write_json(self.runtime / "login.json", {"id": identifier, "state": "waiting", "qr_available": True, "expires_at": time.time() * 1000 + 60000})
        (self.runtime / "login-qr.png").write_bytes(b"fixture")
        self.assertEqual(self.service.login_image(identifier), self.runtime / "login-qr.png")
        with self.assertRaises(ValueError):
            self.service.login_image("stale")
        self.service.active = None
        self.assertFalse(self.service.login_status()["qr_available"])
        with self.assertRaises(ValueError):
            self.service.login_image(identifier)

    def test_restart_marks_unfinished_job_paused_and_preserves_payload(self):
        write_json(self.runtime / "job.json", {"id": "test", "action": "collect", "state": "running", "payload": {"action": "collect", "start_date": "2026-09-07", "end_date": "2026-09-13"}})
        with patch.object(self.service, "_python", return_value=None), patch.object(self.service, "_browser", return_value=None):
            status = self.service.status()
        self.assertEqual(status["job"]["state"], "paused")
        self.assertNotIn("payload", status["job"])
        self.assertIn("payload", read_json(self.runtime / "job.json"))

    def test_duplicate_job_and_stale_cancellation_are_rejected(self):
        self.service.active = "active"
        write_json(self.runtime / "job.json", {"id": "active", "state": "running"})
        with self.assertRaises(ValueError):
            self.service.start({"action": "check"})
        with self.assertRaises(ValueError):
            self.service.cancel("stale")
        self.service.cancel("active")
        self.assertTrue((self.runtime / "active.cancel").is_file())

    def test_login_checks_do_not_replace_the_resumable_collection(self):
        work = {"id": "collection", "action": "collect", "state": "failed", "payload": {"action": "collect", "start_date": "2026-09-07", "end_date": "2026-09-13"}}
        write_json(self.runtime / "last-collection.json", work)
        write_json(self.runtime / "job.json", {"id": "login-check", "action": "check", "state": "complete", "message": "已登录"})
        with patch.object(self.service, "_python", return_value=sys.executable), patch.object(self.service, "_browser", return_value=None):
            status = self.service.status()
        self.assertEqual(status["resume_job"]["id"], "collection")
        self.assertEqual(status["job"]["id"], "login-check")
        self.assertNotIn("payload", status["resume_job"])
        with patch.object(self.service, "_python", return_value=sys.executable), patch("threading.Thread.start"):
            self.service.start({"action": "resume", "job_id": "collection"})
        payload = read_json(self.runtime / "job.json")["payload"]
        self.assertTrue(payload["resume"])
        self.assertEqual(payload["start_date"], "2026-09-07")

    def test_http_routes_reject_foreign_origins_and_arbitrary_paths(self):
        import importlib.util
        import threading
        from http.server import ThreadingHTTPServer
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        spec = importlib.util.spec_from_file_location("collector_bridge_routes", ROOT / "scripts" / "local_bridge.py")
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        bridge._collector = self.service
        server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            with patch.object(self.service, "_python", return_value=None), patch.object(self.service, "_browser", return_value=None):
                with urlopen(origin + "/collector/status", timeout=5) as response:
                    self.assertEqual(json.load(response)["accounts"], [])
            for request in (Request(origin + "/collector/status", headers={"Origin": "https://untrusted.test"}), Request(origin + "/collector/status", headers={"Host": "untrusted.test"}), Request(origin + "/collector/actions", data=b'{"action":"login"}', headers={"Content-Type": "text/plain"})):
                with self.assertRaises(HTTPError) as raised:
                    urlopen(request, timeout=5)
                self.assertEqual(raised.exception.code, 403)
            with self.assertRaises(HTTPError) as raised:
                urlopen(origin + "/collector/download?id=../../config&kind=zip", timeout=5)
            self.assertEqual(raised.exception.code, 400)
            identifier = "d" * 32
            self.service.active = identifier
            write_json(self.runtime / "login.json", {"id": identifier, "state": "waiting", "qr_available": True, "expires_at": time.time() * 1000 + 60000})
            png = bytes.fromhex("89504e470d0a1a0a") + b"test fixture"
            (self.runtime / "login-qr.png").write_bytes(png)
            with urlopen(origin + "/collector/login-qr?id=" + identifier, timeout=5) as response:
                self.assertEqual(response.headers["Content-Type"], "image/png")
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertIsNone(response.headers.get("Content-Disposition"))
                self.assertEqual(response.read(), png)
            with self.assertRaises(HTTPError) as raised:
                urlopen(Request(origin + "/collector/login-qr?id=" + identifier, headers={"Sec-Fetch-Site": "cross-site"}), timeout=5)
            self.assertEqual(raised.exception.code, 403)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_cached_export_completes_without_browser_or_rss_service(self):
        import importlib.util
        if not all(importlib.util.find_spec(name) for name in ("bs4", "markdownify", "requests")):
            self.skipTest("正文打包测试需要已安装采集依赖的 Python")
        config = read_json(self.service.config_path)
        config["accounts"] = [{"bookId": "MP_WXS_123", "name": "测试公众号"}]
        write_json(self.service.config_path, config)
        rid = "MP_WXS_123_demo"
        index = {"sources": [{"bookId": "MP_WXS_123", "name": "测试公众号", "items": [{"rid": rid, "title": "测试正文", "t": 1789000000, "url": "https://mp.weixin.qq.com/s/demo"}], "pageMeta": [{"reviews": 0}]}]}
        write_json(Path(config["outDir"]) / "fixture" / "articles.json", index)
        write_json(self.runtime / "body-cache" / (hashlib.sha256(rid.encode()).hexdigest() + ".json"), {"ok": True, "rid": rid, "originalUrl": "https://mp.weixin.qq.com/s/demo", "title": "测试正文", "html": "<p>用于测试的完整正文</p>", "text": "用于测试的完整正文", "images": []})
        self.service._python_checked, self.service._python_path = True, sys.executable
        with patch.object(self.service, "_browser", return_value=None):
            self.service.start({"action": "export", "start_date": "2026-09-07", "end_date": "2026-09-13"})
            deadline = time.monotonic() + 25
            while self.service.active is not None and time.monotonic() < deadline:
                time.sleep(.1)
            self.assertIsNone(self.service.active)
            status = self.service.status()
        self.assertEqual(status["job"]["state"], "complete", status["job"])
        self.assertEqual(status["exports"][0]["body_count"], 1)
        file, _ = self.service.download(status["exports"][0]["id"], "text")
        self.assertIn("用于测试的完整正文", file.read_text(encoding="utf-8"))
        self.assertFalse(Path(config["statePath"]).exists(), "缓存导出不得消耗采集请求")


if __name__ == "__main__":
    unittest.main()
