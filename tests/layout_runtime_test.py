import copy
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("layout_runtime_test", ROOT / "scripts" / "agent_runtime.py")
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class LayoutRuntimeTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        for field, value in [("CONFIG_ROOT", root), ("CONFIG_FILE", root / "agent-config.json")]:
            patch = mock.patch.object(RUNTIME, field, value); patch.start(); self.addCleanup(patch.stop)
        self.config = RUNTIME.save_agent_config({"base_url": "http://localhost:11434/v1", "model": "synthetic-test", "temperature": 0})
        self.request = {"task": "plan_layout", "schema": "opslion/layout-request/v1", "baseRevision": "revision-1", "template": {"id": "t", "version": "1", "name": "合成模板", "imageGroups": True}, "nodes": [
            {"id": "p", "type": "paragraph", "text": "已审文字", "components": ["body", "card"], "componentLocked": False, "groupLocked": False},
            *[{"id": i, "type": "image", "text": "", "components": ["image"], "componentLocked": False, "groupLocked": False} for i in ["i1", "i2"]],
        ], "requirements": [{"id": "r", "text": "并排图片"}], "observation": {"kind": "structural", "compiled": True, "visualReview": "not-run"}}
        self.plan = {"schema": "opslion/layout-decisions/v1", "id": "d", "baseRevision": "revision-1", "decisions": [{"kind": "component_variant", "nodeId": "p", "componentId": "card"}, {"kind": "image_group", "nodeIds": ["i1", "i2"], "requirementIds": ["r"]}], "unresolved": []}
        self.run_id = str(id(self))

    def enable(self):
        self.config = RUNTIME.set_agent_policy({"enabled": True})

    def run_request(self):
        return RUNTIME.create_agent_plan({**self.request, "_execution": {"run_id": self.run_id, "generation": self.config["policy_generation"]}})

    def response(self, plan=None, usage=True):
        response = mock.MagicMock()
        value = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(plan or self.plan)}}]}
        if usage:
            value["usage"] = {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
        response.__enter__.return_value.read.return_value = json.dumps(value).encode()
        return response

    def test_configured_does_not_enable_model_and_local_gateway_never_calls_supplier(self):
        self.assertTrue(self.config["configured"])
        self.assertFalse(self.config["layout_ai_enabled"])
        with mock.patch.object(RUNTIME, "urlopen") as supplier:
            with self.assertRaises(RUNTIME.AgentRuntimeError): self.run_request()
            with self.assertRaises(RUNTIME.AgentRuntimeError): RUNTIME.create_agent_plan(self.request)
            supplier.assert_not_called()

    def test_strict_layout_contract_and_no_forged_authority(self):
        validator = RUNTIME._layout_validator
        self.assertEqual(validator.validate_request(self.request), [])
        self.assertEqual(validator.validate_plan(self.request, self.plan), [])
        invalid = [dict(self.plan, approved=True), dict(self.plan, reviews=[]), dict(self.plan, baseRevision="stale")]
        for extra in [{"origin": "human"}, {"locked": False}, {"content": [{"text": "改写"}]}, {"nodeId": "unknown"}, {"componentId": "unknown"}]:
            p = copy.deepcopy(self.plan); p["decisions"][0].update(extra); invalid.append(p)
        p = copy.deepcopy(self.plan); p["decisions"][1]["nodeIds"] = ["i2", "i1"]; invalid.append(p)
        p = copy.deepcopy(self.plan); p["decisions"][1]["requirementIds"] = ["unknown"]; invalid.append(p)
        for plan in invalid:
            self.assertTrue(validator.validate_plan(self.request, plan), plan)
        self.request["nodes"][0]["componentLocked"] = True
        self.assertTrue(validator.validate_plan(self.request, self.plan))

    def test_shared_browser_and_gateway_decision_fixtures(self):
        self.request["nodes"][0]["components"].append("body-other")
        cases = json.loads((ROOT / "tests" / "fixtures" / "layout-decisions.json").read_text(encoding="utf-8"))
        for case in cases:
            plan = {**self.plan, "decisions": case["decisions"], **case.get("extra", {})}
            self.assertEqual(not RUNTIME._layout_validator.validate_plan(self.request, plan), case["valid"], case["name"])

    def test_actual_attempts_and_supplier_usage_are_reported_without_inventing_cost(self):
        self.enable()
        with mock.patch.object(RUNTIME, "urlopen", return_value=self.response()) as supplier:
            result = self.run_request()
        self.assertEqual(supplier.call_count, result["requests"])
        self.assertEqual(result["requests"], 1)
        self.assertEqual(result["usage"]["provider_responses"][0]["total_tokens"], 30)
        self.assertIsNone(result["usage"]["cost"])
        payload = json.loads(supplier.call_args.args[0].data)
        self.assertEqual(payload["max_tokens"], RUNTIME.MAX_OUTPUT_TOKENS)
        self.assertNotIn("_execution", payload["messages"][1]["content"])

    def test_missing_usage_remains_unknown(self):
        self.enable()
        with mock.patch.object(RUNTIME, "urlopen", return_value=self.response(usage=False)):
            result = self.run_request()
        self.assertFalse(result["usage"]["complete"])
        self.assertEqual(result["usage"]["provider_responses"], [None])

    def test_compatibility_and_business_repairs_share_one_bounded_budget(self):
        self.enable()
        def incompatible(): return HTTPError("http://localhost", 400, "Bad Request", {}, io.BytesIO(b"response_format"))
        with mock.patch.object(RUNTIME, "urlopen", side_effect=[incompatible(), self.response({"bad": True}), incompatible(), self.response()]) as supplier:
            result = self.run_request()
        self.assertEqual(result["requests"], 4); self.assertEqual(supplier.call_count, 4)
        self.assertFalse(result["usage"]["complete"])
        with mock.patch.object(RUNTIME, "MAX_PROVIDER_REQUESTS", 1), mock.patch.object(RUNTIME, "urlopen", return_value=self.response({"bad": True})) as supplier:
            with self.assertRaisesRegex(RUNTIME.AgentRuntimeError, "预算"): self.run_request()
            self.assertEqual(supplier.call_count, 1)

    def test_turning_local_during_compatibility_error_prevents_retry(self):
        self.enable()
        def stop(*args, **kwargs):
            RUNTIME.set_agent_policy({"enabled": False})
            raise HTTPError("http://localhost", 400, "Bad Request", {}, io.BytesIO(b"temperature"))
        with mock.patch.object(RUNTIME, "urlopen", side_effect=stop) as supplier:
            with self.assertRaisesRegex(RUNTIME.AgentRuntimeError, "本地排版"): self.run_request()
            self.assertEqual(supplier.call_count, 1)

    def test_cancelled_late_response_cannot_repair_or_apply(self):
        self.enable()
        def stop(*args, **kwargs):
            RUNTIME.cancel_agent_run({"run_id": self.run_id})
            return self.response({"bad": True})
        with mock.patch.object(RUNTIME, "urlopen", side_effect=stop) as supplier:
            with self.assertRaisesRegex(RUNTIME.AgentRuntimeError, "取消"): self.run_request()
            self.assertEqual(supplier.call_count, 1)

    def test_refusal_or_truncation_is_terminal(self):
        self.enable()
        for message, finish in [({"refusal": "refused"}, "stop"), ({"content": "{}"}, "length")]:
            response = mock.MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps({"choices": [{"message": message, "finish_reason": finish}]}).encode()
            with mock.patch.object(RUNTIME, "urlopen", return_value=response) as supplier:
                with self.assertRaises(RUNTIME.AgentRuntimeError): self.run_request()
                self.assertEqual(supplier.call_count, 1)

    def test_saving_credentials_preserves_opt_in_but_invalidates_running_generation(self):
        self.enable()
        RUNTIME.save_agent_config({"base_url": "http://localhost:11434/v1", "model": "changed"})
        self.assertTrue(RUNTIME.get_agent_config()["layout_ai_enabled"])
        with mock.patch.object(RUNTIME, "urlopen") as supplier:
            with self.assertRaises(RUNTIME.AgentRuntimeError): self.run_request()
            supplier.assert_not_called()


if __name__ == "__main__": unittest.main()
