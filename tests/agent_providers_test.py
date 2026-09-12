from __future__ import annotations

import base64
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("providers_runtime_test", ROOT / "scripts" / "agent_runtime.py")
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)
PROVIDERS = RUNTIME._providers
TEST_KEY = "synthetic-provider-test-key"
PLAN = {"schema": "opslion/layout-decisions/v1", "id": "d", "baseRevision": "revision-1", "decisions": [], "unresolved": []}
TASK = {"task": "plan_layout", "schema": "opslion/layout-request/v1", "baseRevision": "revision-1",
        "template": {"id": "t", "version": "1", "name": "合成模板", "imageGroups": False},
        "nodes": [{"id": "p", "type": "paragraph", "text": "已审文字", "components": ["body"], "componentLocked": False, "groupLocked": False}],
        "requirements": [], "observation": {"kind": "structural", "compiled": True, "visualReview": "not-run"}}


def supplier_response(protocol, plan):
    text = json.dumps(plan, ensure_ascii=False)
    if protocol == "anthropic":
        return {"type": "message", "stop_reason": "end_turn", "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 10, "output_tokens": 20}}
    if protocol == "gemini":
        return {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"thought": True, "text": "synthetic thought"}, {"text": text, "thoughtSignature": "synthetic-signature"}]}}],
                "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 20, "thoughtsTokenCount": 3}}
    if protocol == "openai-responses":
        return {"status": "completed", "output": [{"type": "reasoning", "id": "unstored-reasoning-id", "summary": []}, {"type": "message", "content": [{"type": "output_text", "text": text}]}],
                "usage": {"input_tokens": 10, "output_tokens": 20}}
    return {"choices": [{"finish_reason": "stop", "message": {"content": text, "reasoning_content": "synthetic thought", "reasoning_details": [{"type": "reasoning.text", "text": "synthetic thought"}]}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20}}


class AgentProvidersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.replies, cls.requests = [], []
        class Supplier(BaseHTTPRequestHandler):
            def do_POST(self):
                cls.requests.append({"path": self.path, "headers": dict(self.headers.items()), "body": json.loads(self.rfile.read(int(self.headers["Content-Length"])))})
                status, body = cls.replies.pop(0) if cls.replies else (500, {"error": "unexpected request"})
                encoded = json.dumps(body).encode()
                self.send_response(status)
                if status == 302:
                    self.send_header("Location", f"http://127.0.0.1:{cls.server.server_port}/credential-trap")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            def do_GET(self):
                cls.requests.append({"path": self.path})
                self.send_response(500); self.end_headers()
            def log_message(self, *args):
                pass
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Supplier)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        self.replies.clear(); self.requests.clear()
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for field, value in [("CONFIG_ROOT", self.root), ("CONFIG_FILE", self.root / "agent-config.json")]:
            patch = mock.patch.object(RUNTIME, field, value); patch.start(); self.addCleanup(patch.stop)
        patch = mock.patch.dict(os.environ, {}, clear=True); patch.start(); self.addCleanup(patch.stop)
        def synthetic_protect(value, protect):
            return base64.b64encode(value.encode()).decode() if protect else base64.b64decode(value).decode()
        patch = mock.patch.object(RUNTIME, "_run_dpapi", side_effect=synthetic_protect); patch.start(); self.addCleanup(patch.stop)

    def configure(self, protocol="openai-chat", **changes):
        return RUNTIME.save_agent_config({"profile_id": "", "name": "合成连接", "provider": "custom", "protocol": protocol, "base_url": self.base,
                                          "model": "synthetic-model", "api_key": TEST_KEY, "send_temperature": False, **changes})

    def run_plan(self):
        config = RUNTIME.set_agent_policy({"enabled": True})
        return RUNTIME.create_agent_plan({**TASK, "_execution": {"run_id": f"run-{len(self.requests)}", "generation": config["policy_generation"]}})

    def test_all_protocols_send_real_http_and_validate_the_same_plan(self):
        for protocol in PROVIDERS.PROTOCOLS:
            with self.subTest(protocol=protocol):
                self.requests.clear()
                self.configure(protocol, max_output_tokens=8192)
                self.replies.append((200, supplier_response(protocol, PLAN)))
                result = self.run_plan()
                self.assertEqual(result["plan"], PLAN)
                self.assertEqual(result["requests"], 1)
                self.assertTrue(result["usage"]["complete"])
                self.assertEqual(result["usage"]["provider_responses"][0]["prompt_tokens"], 10)
                self.assertEqual(result["usage"]["provider_responses"][0]["completion_tokens"], 20)
                wire = self.requests[0]
                body, headers = wire["body"], {k.lower(): v for k, v in wire["headers"].items()}
                self.assertNotIn("_execution", json.dumps(body))
                self.assertNotIn(TEST_KEY, wire["path"])
                if protocol == "anthropic":
                    self.assertEqual(wire["path"], "/v1/messages")
                    self.assertEqual(headers["x-api-key"], TEST_KEY)
                    self.assertEqual(headers["anthropic-version"], "2023-06-01")
                    self.assertTrue(body["system"])
                    self.assertNotIn("response_format", body)
                    self.assertEqual(body["max_tokens"], 8192)
                elif protocol == "gemini":
                    self.assertEqual(wire["path"], "/v1/models/synthetic-model:generateContent")
                    self.assertEqual(headers["x-goog-api-key"], TEST_KEY)
                    self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")
                    self.assertEqual(body["generationConfig"]["maxOutputTokens"], 8192)
                    self.assertTrue(body["systemInstruction"])
                elif protocol == "openai-responses":
                    self.assertEqual(wire["path"], "/v1/responses")
                    self.assertFalse(body["store"])
                    self.assertEqual(body["max_output_tokens"], 8192)
                    self.assertTrue(body["instructions"])
                    self.assertEqual(headers["authorization"], f"Bearer {TEST_KEY}")
                else:
                    self.assertEqual(wire["path"], "/v1/chat/completions")
                    self.assertEqual(headers["authorization"], f"Bearer {TEST_KEY}")
                    self.assertEqual(body["max_tokens"], 8192)
                    self.assertEqual(body["messages"][0]["role"], "system")
                self.assertNotIn("temperature", body)

    def test_native_connection_checks_do_not_send_article_content(self):
        for protocol in PROVIDERS.PROTOCOLS:
            self.configure(protocol)
            self.replies.append((200, supplier_response(protocol, {"ok": True})))
            self.assertTrue(RUNTIME.test_agent_connection()["ok"])
            serialized = json.dumps(self.requests[-1]["body"])
            self.assertIn("connection_test", serialized)
            self.assertNotIn("已审文字", serialized)

    def test_validation_repair_preserves_native_history_and_shared_budget(self):
        for protocol in PROVIDERS.PROTOCOLS:
            self.requests.clear()
            self.configure(protocol)
            self.replies.extend([(200, supplier_response(protocol, {"bad": True})), (200, supplier_response(protocol, PLAN))])
            result = self.run_plan()
            self.assertEqual(result["requests"], 2)
            body = self.requests[-1]["body"]
            self.assertEqual(self.requests[0]["path"], self.requests[1]["path"])
            if protocol == "gemini":
                self.assertEqual(body["contents"][1]["role"], "model")
                self.assertEqual(body["contents"][1]["parts"][1]["thoughtSignature"], "synthetic-signature")
            elif protocol == "anthropic":
                self.assertEqual(body["messages"][1]["content"][0]["type"], "text")
            elif protocol == "openai-responses":
                self.assertNotIn("unstored-reasoning-id", json.dumps(body))
                self.assertEqual(body["input"][1]["role"], "assistant")
            else:
                self.assertEqual(body["messages"][2]["reasoning_details"][0]["text"], "synthetic thought")

    def test_native_refusal_truncation_empty_and_malformed_output_are_terminal(self):
        cases = [
            ("anthropic", {"stop_reason": "max_tokens", "content": [{"type": "text", "text": "{}"}]}),
            ("anthropic", {"stop_reason": "refusal", "content": []}),
            ("gemini", {"promptFeedback": {"blockReason": "SAFETY"}}),
            ("gemini", {"candidates": [{"finishReason": "MAX_TOKENS"}]}),
            ("gemini", {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"thought": True, "text": "not a plan"}]}}]}),
            ("openai-responses", {"status": "incomplete", "output": []}),
            ("openai-responses", {"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "denied"}]}]}),
            ("openai-chat", {"error": {"message": "invalid key"}}),
            ("openai-chat", {"choices": [{"finish_reason": "stop", "message": {"content": ""}}]}),
        ]
        for protocol, response in cases:
            self.requests.clear(); self.configure(protocol); self.replies.append((200, response))
            with self.assertRaises(RUNTIME.AgentRuntimeError): self.run_plan()
            self.assertEqual(len(self.requests), 1)

    def test_retry_unsupported_json_and_temperature_and_output_token_parameter(self):
        for protocol, error in [("gemini", "Unsupported responseMimeType"), ("openai-responses", "Unsupported text.format"), ("anthropic", "temperature is not supported"), ("openai-chat", "Use max_completion_tokens instead of max_tokens")]:
            self.requests.clear(); self.configure(protocol, send_temperature=True)
            self.replies.extend([(400, {"error": {"message": error}}), (200, supplier_response(protocol, PLAN))])
            self.assertEqual(self.run_plan()["requests"], 2)
            body = self.requests[1]["body"]
            target = body.get("generationConfig", body)
            self.assertNotIn("temperature", target)
            if protocol == "openai-chat": self.assertEqual(body["max_completion_tokens"], 4096)

    def test_auth_failures_are_not_retried_and_keys_are_redacted(self):
        self.configure("anthropic")
        self.replies.append((401, {"error": {"message": f"invalid key: {TEST_KEY}"}}))
        with self.assertRaises(RUNTIME.AgentRuntimeError) as error: self.run_plan()
        self.assertNotIn(TEST_KEY, str(error.exception))
        self.assertEqual(len(self.requests), 1)

    def test_redirect_never_forwards_credentials(self):
        self.configure("gemini")
        self.replies.append((302, {}))
        with self.assertRaisesRegex(RUNTIME.AgentRuntimeError, "重定向"): self.run_plan()
        self.assertEqual(len(self.requests), 1)

    def test_missing_native_usage_remains_unknown(self):
        self.configure("anthropic")
        response = supplier_response("anthropic", PLAN); response.pop("usage")
        self.replies.append((200, response))
        result = self.run_plan()
        self.assertFalse(result["usage"]["complete"])
        self.assertEqual(result["usage"]["provider_responses"], [None])

    def test_legacy_config_preserves_endpoint_protocol_key_and_opt_in(self):
        encrypted = base64.b64encode(TEST_KEY.encode()).decode()
        RUNTIME._write_config({"schema": "opslion/agent-config/v1", "base_url": "https://api.example.com/custom/chat/completions", "model": "legacy-model",
                               "api_key_protected": encrypted, "temperature": 0.7, "layout_ai_enabled": True, "policy_generation": 9})
        original = RUNTIME.CONFIG_FILE.read_bytes()
        config = RUNTIME.get_agent_config()
        self.assertEqual(original, RUNTIME.CONFIG_FILE.read_bytes())
        self.assertEqual(config["protocol"], "openai-chat")
        self.assertEqual(config["provider"], "custom")
        self.assertEqual(config["profile_id"], "default")
        self.assertTrue(config["api_key_saved"])
        self.assertNotIn(encrypted, json.dumps(config))
        self.assertNotIn(TEST_KEY, json.dumps(config))
        RUNTIME.save_agent_config({**config, "api_key": ""})
        self.assertEqual(RUNTIME.get_agent_config(True)["api_key"], TEST_KEY)
        self.assertEqual(RUNTIME.get_agent_config()["policy_generation"], 10)
        self.assertTrue(RUNTIME.get_agent_config()["layout_ai_enabled"])
        self.assertEqual(json.loads(RUNTIME.CONFIG_FILE.read_text(encoding="utf-8"))["schema"], "opslion/agent-config/v2")

    def test_saved_connections_keep_independent_keys_and_switch_without_reentry(self):
        first = self.configure("anthropic", provider="anthropic")
        second = self.configure("gemini", provider="gemini", api_key="synthetic-gemini-key")
        self.assertEqual(len(second["profiles"]), 2)
        RUNTIME.save_agent_config({**first, "api_key": ""})
        self.assertEqual(RUNTIME.get_agent_config(True)["api_key"], TEST_KEY)
        RUNTIME.save_agent_config({**second, "api_key": ""})
        self.assertEqual(RUNTIME.get_agent_config(True)["api_key"], "synthetic-gemini-key")
        self.assertNotIn("api_key_protected", json.dumps(RUNTIME.get_agent_config()))

    def test_endpoint_or_provider_changes_do_not_inherit_saved_keys(self):
        for changed in [{"base_url": self.base + "/another-account"}, {"provider": "gemini"}]:
            first = self.configure()
            RUNTIME.save_agent_config({**first, **changed, "api_key": ""})
            self.assertEqual(RUNTIME.get_agent_config(True)["api_key"], "")
        first = self.configure()
        second = self.configure(api_key="")
        self.assertNotEqual(first["profile_id"], second["profile_id"])
        self.assertFalse(second["api_key_saved"])

    def test_environment_key_is_bound_to_the_explicit_profile(self):
        os.environ["OPSLION_AGENT_API_KEY"] = "synthetic-legacy-env"
        RUNTIME._write_config({"base_url": self.base, "model": "legacy"})
        self.assertEqual(RUNTIME.get_agent_config(True)["api_key"], "synthetic-legacy-env")
        self.configure("gemini", api_key="")
        self.assertEqual(RUNTIME.get_agent_config(True)["api_key"], "")
        os.environ["GEMINI_API_KEY"] = "synthetic-gemini-env"
        self.configure("gemini", api_key="", api_key_env="GEMINI_API_KEY")
        self.assertEqual(RUNTIME.get_agent_config(True)["api_key"], "synthetic-gemini-env")
        self.assertEqual(RUNTIME.get_agent_config()["api_key_source"], "environment")
        os.environ.pop("GEMINI_API_KEY")
        self.assertFalse(RUNTIME.get_agent_config()["api_key_saved"])
        with self.assertRaisesRegex(RUNTIME.AgentRuntimeError, "未读取到"):
            RUNTIME.test_agent_connection()
        self.assertEqual(self.requests, [])

    def test_switch_invalidates_old_run_and_deleting_active_returns_to_local_mode(self):
        first = self.configure(); first = RUNTIME.set_agent_policy({"enabled": True})
        second = self.configure("gemini")
        with self.assertRaisesRegex(RUNTIME.AgentRuntimeError, "失效"):
            RUNTIME.create_agent_plan({**TASK, "_execution": {"run_id": "old", "generation": first["policy_generation"]}})
        self.assertEqual(self.requests, [])
        deleted = RUNTIME.delete_agent_profile({"profile_id": second["profile_id"]})
        self.assertFalse(deleted["layout_ai_enabled"])
        self.assertEqual(deleted["profile_id"], first["profile_id"])
        deleted = RUNTIME.delete_agent_profile({"profile_id": first["profile_id"]})
        self.assertFalse(deleted["configured"])
        self.assertEqual(deleted["profiles"], [])

    def test_settings_reject_unsafe_urls_and_invalid_options(self):
        for url in ["https://user:secret@api.example.com/v1", "https://api.example.com/v1?key=secret", "https://api.example.com/v1#secret", "https://api.example.com:wrong/v1", "http://api.example.com/v1", "https://api.example.com\\other"]:
            with self.assertRaises(RUNTIME.AgentRuntimeError): self.configure(base_url=url)
        for changes in [{"protocol": "unknown"}, {"max_output_tokens": 0}, {"max_output_tokens": True}, {"api_key_env": "A=B"}, {"api_key": "key\nheader"}, {"api_key": "非接口密钥"}, {"profile_id": []}, {"json_mode": {}}]:
            with self.assertRaises(RUNTIME.AgentRuntimeError): self.configure(**changes)

    def test_catalog_presets_and_complete_endpoints_use_the_same_adapter(self):
        self.assertEqual(len(PROVIDERS.PROVIDERS), 24)
        for preset in PROVIDERS.PROVIDERS.values():
            if not preset["base_url"]: continue
            url = RUNTIME._validate_base_url(preset["base_url"])
            config = {**preset, "model": "synthetic-model", "api_key": TEST_KEY}
            endpoint, _, body = PROVIDERS.build_request(config, [{"role": "system", "content": "JSON"}, {"role": "user", "content": "test"}], True)
            second, _, _ = PROVIDERS.build_request({**config, "base_url": endpoint}, [{"role": "user", "content": "test"}], True)
            self.assertEqual(endpoint, second)
            self.assertTrue(endpoint.startswith(url))
            self.assertNotIn(TEST_KEY, json.dumps(body))
        endpoint, _, _ = PROVIDERS.build_request({"base_url": self.base, "protocol": "gemini", "model": "models/special#?id"}, [{"role": "user", "content": "test"}], False)
        self.assertIn("special%23%3Fid:generateContent", endpoint)


if __name__ == "__main__":
    unittest.main()
