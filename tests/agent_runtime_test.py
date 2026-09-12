from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


RUNTIME_PATH = Path(__file__).resolve().parents[1] / "scripts" / "agent_runtime.py"
SPEC = importlib.util.spec_from_file_location("opslion_agent_runtime", RUNTIME_PATH)
assert SPEC and SPEC.loader
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class AgentRuntimeTest(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows DPAPI only")
    def test_windows_dpapi_round_trip(self) -> None:
        protected = RUNTIME._run_dpapi("opslion-test-secret", True)
        self.assertNotIn("opslion-test-secret", protected)
        self.assertEqual(RUNTIME._run_dpapi(protected, False), "opslion-test-secret")

    def test_restricts_plain_http_to_local_models(self) -> None:
        self.assertEqual(RUNTIME._validate_base_url("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1")
        self.assertEqual(RUNTIME._validate_base_url("https://api.example.com/v1"), "https://api.example.com/v1")
        with self.assertRaises(RUNTIME.AgentRuntimeError):
            RUNTIME._validate_base_url("http://api.example.com/v1")

    def test_saves_non_secret_config_outside_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=False):
            root = Path(directory)
            with mock.patch.object(RUNTIME, "CONFIG_ROOT", root), mock.patch.object(RUNTIME, "CONFIG_FILE", root / "agent-config.json"):
                os.environ.pop("OPSLION_AGENT_API_KEY", None)
                config = RUNTIME.save_agent_config({
                    "base_url": "http://localhost:11434/v1",
                    "model": "local-model",
                    "temperature": 0,
                    "api_key": "",
                })
                self.assertTrue(config["configured"])
                self.assertFalse(config["api_key_saved"])
                stored = json.loads((root / "agent-config.json").read_text(encoding="utf-8"))
                self.assertNotIn("api_key", stored)
                self.assertNotIn("api_key_protected", stored)

    def test_loads_skill_and_validates_model_plan(self) -> None:
        request = {
            "task": "analyze_content",
            "policy": {"rewrite_level": "none", "allow_merge": True, "allow_split": True, "target_section_count": None, "preserve_order": True},
            "source": {
                "document_name": "demo.docx",
                "blocks": [{"id": "b1", "kind": "title", "text": "标题", "order": 0, "image_anchor_ids": []}],
                "images": [],
            },
        }
        plan = {
            "schema": "opslion/content-plan/v1",
            "title": {"text": "标题", "source_block_ids": ["b1"], "confidence": 1},
            "subtitle": {"text": "", "source_block_ids": [], "confidence": 1},
            "lead": {"text": "", "source_block_ids": [], "confidence": 1},
            "sections": [],
            "ending": {"text": "", "source_block_ids": [], "confidence": 1},
            "unused_source_blocks": [],
            "unplaced_image_anchors": [],
            "warnings": [],
            "confidence": 1,
        }
        response = {"choices": [{"message": {"content": json.dumps(plan, ensure_ascii=False)}}]}
        with mock.patch.object(RUNTIME, "_request_chat", return_value=(response, 12)), mock.patch.object(RUNTIME, "get_agent_config", return_value={"model": "test-model"}), mock.patch.object(RUNTIME, "_read_stored_config", return_value={"layout_ai_enabled": True, "policy_generation": 1}):
            result = RUNTIME.create_agent_plan({**request, "_execution": {"run_id": "test", "generation": 1}})
        self.assertEqual(result["plan"], plan)
        self.assertEqual(result["model"], "test-model")
        self.assertIn("文案分析规范", RUNTIME._skill_prompt("analyze_content"))


if __name__ == "__main__":
    unittest.main()
