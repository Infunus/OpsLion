import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from we_mp_rss_adapter import CollectionFailure, PageObservation, UpstreamAdapter, date_range, run_upstream_page
from we_mp_rss_runtime import WeMpRssClient
from rss_connector import RssConnector


class WorkflowTests(unittest.TestCase):
    def test_beijing_inclusive_range_and_invalid_dates(self):
        _, _, lower, upper = date_range({"start_date": "2026-09-07", "end_date": "2026-09-13"})
        self.assertEqual(upper - lower, 7 * 86400)
        self.assertEqual(lower, 1788710400)
        for start, end in [("2026-02-30", "2026-03-02"), ("20260907", "2026-09-13"), ("2026-09-14", "2026-09-13")]:
            with self.subTest(start=start), self.assertRaises(ValueError):
                date_range({"start_date": start, "end_date": end})

    def observe(self, body):
        observer = PageObservation()
        observer(Mock(url="https://mp.weixin.qq.com/cgi-bin/appmsgpublish", json=Mock(return_value=body)))
        return observer

    def test_only_valid_empty_upstream_page_establishes_end_of_history(self):
        good = self.observe({"base_resp": {"ret": 0}, "publish_page": '{"publish_list": []}'})
        good.verify()
        self.assertTrue(good.empty)
        for body in ({}, {"base_resp": {"ret": 0}}, {"base_resp": {"ret": 0}, "publish_page": "invalid"}, {"base_resp": {"ret": 0}, "publish_page": '{"publish_list": null}'}):
            with self.subTest(body=body), self.assertRaises(CollectionFailure):
                self.observe(body).verify()

    def test_original_error_codes_are_not_reported_as_success(self):
        for code in (200013, 200003, 200002):
            with self.subTest(code=code), self.assertRaises(CollectionFailure) as caught:
                self.observe({"base_resp": {"ret": code}}).verify()
            self.assertEqual(caught.exception.code, code)

    def test_calls_actual_engine_entry_point_with_page_arguments_and_keeps_existing_hooks(self):
        existing = Mock()
        engine = Mock()
        engine.session.hooks = {"response": [existing]}
        def native_call(**kwargs):
            engine.session.hooks["response"][-1](Mock(url="https://mp.weixin.qq.com/cgi-bin/appmsg", json=Mock(return_value={"base_resp": {"ret": 0}, "app_msg_list": []})))
        engine.get_Articles.side_effect = native_call
        callback = Mock()
        self.assertTrue(run_upstream_page(engine, {"id": "test", "faker_id": "fake", "mp_name": "示例"}, 3, callback, 10))
        engine.get_Articles.assert_called_once_with(faker_id="fake", Mps_id="test", Mps_title="示例", CallBack=callback, start_page=3, MaxPage=4, interval=10)
        self.assertEqual(engine.session.hooks["response"], [existing])

    def test_silent_timeout_cannot_produce_success(self):
        engine = Mock()
        engine.session.hooks = {"response": []}
        with self.assertRaises(CollectionFailure):
            run_upstream_page(engine, {"id": "test", "faker_id": "fake", "mp_name": "示例"}, 0, Mock(), 10)
        self.assertEqual(engine.session.hooks["response"], [])

    def test_restart_marks_an_interrupted_job_without_changing_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "opslion-refresh.json").write_text(json.dumps({"job_id": "unfinished", "running": True, "start_date": "2026-09-01", "end_date": "2026-09-02"}))
            adapter = UpstreamAdapter(path)
            state = adapter.snapshot()
            self.assertEqual(state["job_id"], "unfinished")
            self.assertEqual(state["outcome"], "interrupted")
            self.assertEqual(state["return_code"], 1)
            self.assertFalse(state["running"])

    def test_cancel_is_scoped_to_job_and_queued_cancellation_is_immediate(self):
        with tempfile.TemporaryDirectory() as folder:
            adapter = UpstreamAdapter(Path(folder))
            adapter.update(job_id="wanted", running=True, outcome="queued")
            with self.assertRaises(ValueError):
                adapter.cancel({"job_id": "old"})
            self.assertFalse(adapter.cancelled.is_set())
            state = adapter.cancel({"job_id": "wanted"})
            self.assertFalse(state["running"])
            self.assertEqual(state["outcome"], "cancelled")
            adapter.run_job("wanted", [])  # A cancelled native queue entry is a no-op.
            self.assertEqual(adapter.snapshot()["outcome"], "cancelled")

    def test_running_cancellation_waits_for_original_call(self):
        with tempfile.TemporaryDirectory() as folder:
            adapter = UpstreamAdapter(Path(folder))
            adapter.update(job_id="running", running=True, outcome="running")
            self.assertTrue(adapter.cancel({"job_id": "running"})["running"])
            self.assertTrue(adapter.cancelled.is_set())


class ConnectionTests(unittest.TestCase):
    def test_bundled_service_is_used_and_config_changes_are_reloaded(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            path = Path(folder) / "paths.json"
            path.write_text(json.dumps({"rss_backend": "we-mp-rss", "rss_url": "http://127.0.0.1:8001"}), encoding="utf-8-sig")
            connector = RssConnector(path)
            with patch("we_mp_rss_runtime.WeMpRssClient") as client:
                client.return_value.call.return_value = {"available": True}
                self.assertEqual(connector.call("status"), {"available": True})
                client.assert_called_once_with({"rss_backend": "we-mp-rss", "rss_url": "http://127.0.0.1:8001"})
            path.write_text("{}")
            self.assertFalse(connector.call("status")["available"])

    def test_url_cannot_send_service_secret_to_insecure_or_embedded_credentials(self):
        for url in ("http://remote.example", "ftp://127.0.0.1", "http://user:pass@127.0.0.1", "https://rss.example/path", "https://rss.example?token=secret"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                WeMpRssClient({"rss_url": url})

    def test_remote_connection_requires_secret_file_and_checks_protocol(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "token.txt"
            path.write_text("synthetic-token-" * 3)
            client = WeMpRssClient({"rss_url": "https://rss.example", "rss_token_file": str(path)})
            with patch.object(client, "request", return_value={"engine": "other", "protocol": "opslion-rss/v1"}), self.assertRaises(ValueError):
                client.ensure_running()

    def test_token_is_not_returned_in_management_link(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "token.txt"
            path.write_text("synthetic-token-" * 3)
            client = WeMpRssClient({"rss_url": "https://rss.example", "rss_token_file": str(path)})
            with patch.object(client, "ensure_running"), patch.object(client, "request", return_value={"available": True}):
                result = client.call("status")
            self.assertEqual(result["management_url"], "https://rss.example")
            self.assertNotIn("synthetic-token", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
