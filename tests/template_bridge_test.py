import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import local_bridge


class TemplateBridgeTests(unittest.TestCase):
    def setUp(self):
        local_bridge._pending_templates.clear()

    def test_captures_are_consumed_by_id_and_preserve_provenance(self):
        source = {"url": "https://xiumi.us/studio/v5#/paper/for/123/cube/0", "paperId": "123", "capturedAt": "2026-09-09T00:00:00Z", "modules": []}
        first = local_bridge.store_template({"schema": "opslion-template/v2", "title": "first", "html": "<p>synthetic first</p>", "source": source})
        second = local_bridge.store_template({"schema": "opslion-template/v2", "title": "second", "html": "<p>synthetic second</p>"})
        self.assertIsNone(local_bridge.pending_template(True, "unknown"))
        self.assertEqual(local_bridge.pending_template(True, first["id"])["source"], source)
        self.assertEqual(local_bridge.pending_template(False, second["id"])["title"], "second")
        self.assertIsNone(local_bridge.pending_template(True, first["id"]))
        self.assertEqual(local_bridge.pending_template(True)["id"], second["id"])

    def test_expired_capture_does_not_consume_another_capture(self):
        first = local_bridge.store_template({"html": "<p>synthetic stale</p>"})
        _, value = local_bridge._pending_templates[first["id"]]
        local_bridge._pending_templates[first["id"]] = (0, value)
        second = local_bridge.store_template({"html": "<p>synthetic fresh</p>"})
        self.assertIsNone(local_bridge.pending_template(True, first["id"]))
        self.assertIsNotNone(local_bridge.pending_template(False, second["id"]))
