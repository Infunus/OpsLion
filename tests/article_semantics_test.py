from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("semantic_runtime_test", ROOT / "scripts" / "agent_runtime.py")
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class ArticleSemanticsTest(unittest.TestCase):
    def setUp(self):
        policy = mock.patch.object(RUNTIME, "_read_stored_config", return_value={"layout_ai_enabled": True, "policy_generation": 1})
        policy.start(); self.addCleanup(policy.stop)
        self.request = {"task": "parse_article_semantics", "source": {
            "schema": "opslion/word-snapshot/v1", "document_name": "synthetic.docx", "warnings": [],
            "blocks": [
                {"id": "p1", "kind": "paragraph", "content": [{"text": "邀请函"}], "clues": {"style_name": "Heading 1"}},
                {"id": "p2", "kind": "paragraph", "content": [{"text": "介绍。", "marks": ["bold"]}], "clues": {}},
                {"id": "img1", "kind": "image", "image_anchor_id": "a1", "content": [], "clues": {}},
                {"id": "p3", "kind": "paragraph", "content": [{"text": "图片说明"}], "clues": {}},
            ]}}
        self.plan = {"schema": "opslion/semantic-plan/v1", "nodes": [
            {"type": "article_title", "source_ids": ["p1"]},
            {"type": "paragraph", "source_ids": ["p2"]},
            {"type": "image", "source_ids": ["img1", "p3"]},
        ]}

    def test_runtime_sends_new_prompt_and_repairs_source_loss(self):
        invalid = copy.deepcopy(self.plan)
        invalid["nodes"].pop()
        response = lambda plan: ({"choices": [{"message": {"content": json.dumps(plan)}}]}, 10)
        with mock.patch.object(RUNTIME, "_request_chat", side_effect=[response(invalid), response(self.plan)]) as chat, mock.patch.object(RUNTIME, "get_agent_config", return_value={"model": "synthetic-model"}):
            result = RUNTIME.create_agent_plan({**self.request, "_execution": {"run_id": "test", "generation": 1}})
        self.assertEqual(result["plan"], self.plan)
        self.assertEqual(result["latency_ms"], 20)
        self.assertEqual(chat.call_count, 2)
        prompt = chat.call_args_list[0].args[0][0]["content"]
        self.assertIn("禁止改写", prompt)
        self.assertIn("opslion/semantic-plan/v1", prompt)
        self.assertNotIn("opslion/content-plan/v1", prompt)
        self.assertIn("遗漏", chat.call_args_list[1].args[0][-1]["content"])

    def test_rejects_rewriting_reordering_false_lists_and_unknown_images(self):
        self.assertEqual(RUNTIME._semantic_validator.validate_plan(self.request, self.plan), [])
        variants = []
        extra = copy.deepcopy(self.plan); extra["nodes"][1]["content"] = [{"text": "模型改写"}]; variants.append(extra)
        order = copy.deepcopy(self.plan); order["nodes"].reverse(); variants.append(order)
        false_list = copy.deepcopy(self.plan); false_list["nodes"][1]["type"] = "ol"; variants.append(false_list)
        image = copy.deepcopy(self.plan); image["nodes"][-1]["source_ids"][0] = "missing"; variants.append(image)
        for value in variants:
            self.assertTrue(RUNTIME._semantic_validator.validate_plan(self.request, value))

    def test_persistent_bad_response_is_not_applied_and_invalid_input_never_calls_model(self):
        response = {"choices": [{"message": {"content": json.dumps({"schema": "opslion/semantic-plan/v1", "nodes": []})}}]}
        with mock.patch.object(RUNTIME, "_request_chat", return_value=(response, 1)) as chat:
            with self.assertRaises(RUNTIME.AgentRuntimeError):
                RUNTIME.create_agent_plan({**self.request, "_execution": {"run_id": "test", "generation": 1}})
            self.assertEqual(chat.call_count, 2)
        with mock.patch.object(RUNTIME, "_request_chat") as chat:
            with self.assertRaises(RUNTIME.AgentRuntimeError):
                RUNTIME.create_agent_plan({"task": "parse_article_semantics", "source": {}, "_execution": {"run_id": "test", "generation": 1}})
            chat.assert_not_called()

    def test_real_lists_keep_group_and_kind(self):
        request = copy.deepcopy(self.request)
        request["source"]["blocks"] = [
            {"id": f"p{i}", "kind": "paragraph", "content": [{"text": str(i)}], "clues": {"numbering": {"group": "list1", "level": 0, "ordered": True, "start": i}}}
            for i in [7, 8]
        ]
        plan = {"schema": "opslion/semantic-plan/v1", "nodes": [{"type": "ol", "source_ids": ["p7", "p8"]}]}
        self.assertEqual(RUNTIME._semantic_validator.validate_plan(request, plan), [])
        request["source"]["blocks"][1]["clues"]["numbering"]["group"] = "list2"
        self.assertTrue(RUNTIME._semantic_validator.validate_plan(request, plan))


if __name__ == "__main__":
    unittest.main()
