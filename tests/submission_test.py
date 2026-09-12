import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("submission_runtime_test", ROOT / "scripts" / "agent_runtime.py")
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class SubmissionTest(unittest.TestCase):
    def test_rich_text_color_is_retained_but_arbitrary_style_is_rejected(self):
        self.plan["article"]["nodes"][0]["content"] = [{"text": "日期", "marks": ["bold"], "color": "#cc2244"}]
        self.assertEqual(RUNTIME._submission_validator.validate_plan(self.request, self.plan), [])
        self.plan["article"]["nodes"][0]["content"][0]["color"] = "url(https://example.com)"
        self.assertTrue(RUNTIME._submission_validator.validate_plan(self.request, self.plan))

    def setUp(self):
        policy = mock.patch.object(RUNTIME, "_read_stored_config", return_value={"layout_ai_enabled": True, "policy_generation": 1})
        policy.start(); self.addCleanup(policy.stop)
        self.request = {"task": "prepare_submission", "submission_id": "task1", "context": {"mode": "new", "user_instructions": "组装交稿", "main_document_ids": ["doc1"]}, "documents": [{"id": "doc1", "blocks": [{"id": "title", "kind": "paragraph"}, {"id": "marker", "kind": "paragraph"}, {"id": "appendix", "kind": "paragraph"}], "annotations": []}], "asset_catalog": [{"id": "photo"}]}
        self.plan = {"schema": "opslion/submission-plan/v1", "mode": "new", "article": {"nodes": [{"id": "t", "type": "article_title", "source_ids": ["title"]}, {"id": "i", "type": "image_ref", "request_id": "r", "source_ids": ["marker"]}]}, "image_requests": [{"id": "r", "purpose": "现场", "selector": {"kind": "file", "relative_path": "待补/photo.png"}, "source_ids": ["marker"]}], "excluded_sources": [{"source_id": "appendix", "role": "reference", "reason": "附录素材不重复发表"}], "pending": []}

    def test_new_route_accepts_pending_assets_and_intentional_nonpublication(self):
        self.assertEqual(RUNTIME._submission_validator.validate_plan(self.request, self.plan), [])
        response = {"choices": [{"message": {"content": json.dumps(self.plan)}}]}
        with mock.patch.object(RUNTIME, "_request_chat", return_value=(response, 7)) as chat, mock.patch.object(RUNTIME, "get_agent_config", return_value={"model": "mock"}):
            result = RUNTIME.create_agent_plan({**self.request, "_execution": {"run_id": "test", "generation": 1}})
        self.assertEqual(result["plan"], self.plan)
        self.assertEqual(chat.call_count, 1)
        self.assertIn("编辑指示", chat.call_args.args[0][0]["content"])
        self.assertNotIn("opslion/semantic-plan/v1", chat.call_args.args[0][0]["content"])

    def test_unknown_targets_mode_changes_and_unexplained_missing_text_are_rejected(self):
        wrong = copy.deepcopy(self.plan); wrong["mode"] = "update"
        self.assertTrue(RUNTIME._submission_validator.validate_plan(self.request, wrong))
        missing = copy.deepcopy(self.plan); missing["excluded_sources"] = []
        self.assertTrue(RUNTIME._submission_validator.validate_plan(self.request, missing))
        request = {**self.request, "context": {"mode": "update", "base_article_id": "base"}, "base_article": {"id": "base", "nodes": [{"id": "p", "type": "paragraph"}]}}
        plan = {"schema": "opslion/submission-plan/v1", "mode": "update", "base_article_id": "base", "changes": [{"op": "set_content", "target_node_id": "absent", "content": [{"text": "新文字"}]}], "image_requests": [], "pending": []}
        self.assertTrue(RUNTIME._submission_validator.validate_plan(request, plan))
        plan["changes"][0]["target_node_id"] = "p"
        self.assertEqual(RUNTIME._submission_validator.validate_plan(request, plan), [])

    def test_malformed_model_fields_are_errors_and_ambiguous_target_is_not_auto_applied(self):
        wrong = copy.deepcopy(self.plan); wrong["article"]["nodes"][0]["type"] = []
        self.assertTrue(RUNTIME._submission_validator.validate_plan(self.request, wrong))
        request = {**self.request, "context": {"mode": "update", "base_article_id": "base"}, "base_article": {"id": "base", "nodes": [{"id": "p1"}, {"id": "p2"}]}}
        plan = {"schema": "opslion/submission-plan/v1", "mode": "update", "base_article_id": "base", "changes": [], "image_requests": [], "pending": [{"id": "choose", "kind": "select_target", "message": "请选择要修改的报名段落", "candidate_ids": ["p1", "p2"], "source_ids": ["user:instructions"]}]}
        self.assertEqual(RUNTIME._submission_validator.validate_plan(request, plan), [])


if __name__ == "__main__":
    unittest.main()
