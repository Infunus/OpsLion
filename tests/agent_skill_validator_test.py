from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path


VALIDATOR_PATH = Path(__file__).resolve().parents[1] / "agent" / "skills" / "wechat-layout-agent" / "scripts" / "validate_plan.py"
SPEC = importlib.util.spec_from_file_location("opslion_agent_validator", VALIDATOR_PATH)
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class AgentSkillValidatorTest(unittest.TestCase):
    def test_accepts_complete_content_plan(self) -> None:
        request = {
            "task": "analyze_content",
            "source": {
                "blocks": [
                    {"id": "b1", "kind": "title", "text": "活动标题", "order": 0, "image_anchor_ids": []},
                    {"id": "b2", "kind": "paragraph", "text": "活动正文", "order": 1, "image_anchor_ids": ["img1"]},
                ],
                "images": [{"id": "img1", "caption": "现场图", "after_block_id": "b2"}],
            },
        }
        plan = {
            "schema": "opslion/content-plan/v1",
            "title": {"text": "活动标题", "source_block_ids": ["b1"], "confidence": 1},
            "subtitle": {"text": "", "source_block_ids": [], "confidence": 1},
            "lead": {"text": "", "source_block_ids": [], "confidence": 1},
            "sections": [{
                "plan_id": "section-1",
                "title": "活动介绍",
                "paragraphs": [{"text": "活动正文", "source_block_ids": ["b2"]}],
                "image_anchor_ids": ["img1"],
                "reason": "正文板块",
            }],
            "ending": {"text": "", "source_block_ids": [], "confidence": 1},
            "unused_source_blocks": [],
            "unplaced_image_anchors": [],
            "warnings": [],
            "confidence": 0.98,
        }
        self.assertEqual(VALIDATOR.validate_plan(request, plan), [])

        incomplete = copy.deepcopy(plan)
        incomplete["sections"][0]["paragraphs"][0]["source_block_ids"] = []
        incomplete["sections"][0]["image_anchor_ids"] = []
        errors = VALIDATOR.validate_plan(request, incomplete)
        self.assertTrue(any("b2" in error and "not covered" in error for error in errors))
        self.assertTrue(any("img1" in error and "exactly once" in error for error in errors))

        missing_asset = copy.deepcopy(plan)
        missing_asset["warnings"] = [{
            "code": "missing_referenced_image",
            "message": "正文提到二维码，但 DOCX 未提供图片",
            "source_block_ids": ["b2"],
        }]
        missing_asset["confidence"] = 0.9
        errors = VALIDATOR.validate_plan(request, missing_asset)
        self.assertTrue(any("0.85" in error for error in errors))

    def test_protects_template_decorations_and_revisions(self) -> None:
        request = {
            "task": "plan_template_operations",
            "policy": {
                "allow_duplicate": True,
                "allow_hide": True,
                "allow_reorder": True,
                "allow_link_change": True,
                "allow_content_image_change": True,
                "allow_deferred_assets": True,
            },
            "article": {
                "blocks": [
                    {"id": "a1", "kind": "heading", "text": "活动介绍", "image_anchor_ids": []},
                    {"id": "a2", "kind": "paragraph", "text": "活动正文", "image_anchor_ids": ["img1"]},
                    {"id": "a3", "kind": "paragraph", "text": "", "image_anchor_ids": []},
                ],
                "images": [{"id": "img1", "caption": "现场图", "source": "user-document"}],
            },
            "template": {
                "revision": "rev-1",
                "modules": [{"id": "m1", "label": "正文卡片", "order": 0, "included": True, "can_duplicate": True, "slot_ids": ["t1", "i1", "d1"]}],
                "slots": [
                    {"id": "t1", "module_id": "m1", "index_in_module": 0, "kind": "text", "role": "content", "label": "正文", "current_value": "旧正文", "current_link": ""},
                    {"id": "i1", "module_id": "m1", "index_in_module": 1, "kind": "image", "role": "content_image", "label": "配图", "current_value": "old", "current_link": ""},
                    {"id": "d1", "module_id": "m1", "index_in_module": 2, "kind": "image", "role": "decoration", "label": "装饰", "current_value": "decor", "current_link": ""},
                ],
            },
        }
        plan = {
            "schema": "opslion/template-plan/v1",
            "base_revision": "rev-1",
            "operations": [
                {"op": "set_text", "slot_target": {"slot_id": "t1"}, "value": "活动介绍\n活动正文", "source_block_ids": ["a1", "a2"], "reason": "填入正文"},
                {"op": "set_image", "slot_target": {"slot_id": "i1"}, "image_anchor_id": "img1", "reason": "填入文案配图"},
            ],
            "coverage": [
                {"source_block_id": "a1", "operation_indexes": [0]},
                {"source_block_id": "a2", "operation_indexes": [0]},
            ],
            "unresolved": [],
            "warnings": [],
            "confidence": 0.95,
        }
        self.assertEqual(VALIDATOR.validate_plan(request, plan), [])

        unsafe = copy.deepcopy(plan)
        unsafe["base_revision"] = "stale-revision"
        unsafe["operations"][1]["slot_target"] = {"slot_id": "d1"}
        errors = VALIDATOR.validate_plan(request, unsafe)
        self.assertTrue(any("base_revision" in error for error in errors))
        self.assertTrue(any("content_image" in error for error in errors))

        deferred = copy.deepcopy(plan)
        deferred["operations"].append({
            "op": "clear_image",
            "slot_target": {"slot_id": "i1"},
            "reason": "清除往年二维码，等待今年素材",
        })
        deferred["deferred_assets"] = [{
            "kind": "image",
            "purpose": "报名二维码",
            "preferred_slot_id": "i1",
            "source_block_ids": ["a2"],
            "reason": "文案提到报名图，但当前未提供",
        }]
        deferred["warnings"] = [{
            "code": "deferred_asset",
            "message": "报名二维码稍后补充",
            "module_refs": ["m1"],
            "slot_ids": ["i1"],
        }]
        deferred["confidence"] = 0.85
        self.assertEqual(VALIDATOR.validate_plan(request, deferred), [])

        overconfident = copy.deepcopy(deferred)
        overconfident["confidence"] = 0.9
        errors = VALIDATOR.validate_plan(request, overconfident)
        self.assertTrue(any("assets are deferred" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
