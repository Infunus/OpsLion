from __future__ import annotations

import json
import secrets
import threading
import time
from collections import OrderedDict
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


from agent_runtime import AgentRuntimeError, create_agent_plan, get_agent_config, save_agent_config, test_agent_connection, set_agent_policy, cancel_agent_run, delete_agent_profile


HOST = "127.0.0.1"
PORT = 4319

_template_lock = threading.RLock()
_pending_templates: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_asset_cache_lock = threading.RLock()
_asset_cache: OrderedDict[str, tuple[bytes, str]] = OrderedDict()
_asset_cache_bytes = 0
_asset_hosts = (
    "statics.xiumi.us",
    "img.xiumi.us",
    "mmbiz.qpic.cn",
    "mmbiz.qlogo.cn",
    "wx.qlogo.cn",
    "thirdwx.qlogo.cn",
)
_asset_max_bytes = 12 * 1024 * 1024
_asset_cache_max_bytes = 48 * 1024 * 1024


def normalize_asset_url(value: str) -> str:
    parsed = urlparse(value.strip())
    host = (parsed.hostname or "").lower()
    allowed = any(host == candidate or host.endswith(f".{candidate}") for candidate in _asset_hosts)
    if parsed.scheme not in {"http", "https"} or not allowed or parsed.username or parsed.password:
        raise ValueError("不允许代理这个素材地址")
    if parsed.port not in {None, 443}:
        raise ValueError("不允许代理这个素材端口")
    return parsed._replace(scheme="https").geturl()


def fetch_preview_asset(value: str) -> tuple[bytes, str]:
    global _asset_cache_bytes
    source = normalize_asset_url(value)
    with _asset_cache_lock:
        cached = _asset_cache.get(source)
        if cached:
            _asset_cache.move_to_end(source)
            return cached

    host = (urlparse(source).hostname or "").lower()
    referer = "https://mp.weixin.qq.com/" if "qpic.cn" in host or "qlogo.cn" in host else "https://xiumi.us/"
    request = Request(source, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": referer,
    })
    with urlopen(request, timeout=20) as response:
        normalize_asset_url(response.geturl())
        content_type = response.headers.get_content_type()
        if not content_type.startswith("image/"):
            raise ValueError("远端地址返回的不是图片")
        body = response.read(_asset_max_bytes + 1)
    if len(body) > _asset_max_bytes:
        raise ValueError("远端图片超过 12 MB 限制")

    with _asset_cache_lock:
        _asset_cache[source] = (body, content_type)
        _asset_cache.move_to_end(source)
        _asset_cache_bytes += len(body)
        while _asset_cache and _asset_cache_bytes > _asset_cache_max_bytes:
            _, (expired, _) = _asset_cache.popitem(last=False)
            _asset_cache_bytes -= len(expired)
    return body, content_type


def store_template(payload: dict) -> dict:
    source = payload.get("template") if isinstance(payload.get("template"), dict) else payload
    html_source = source.get("html") if isinstance(source, dict) else None
    if not isinstance(html_source, str) or len(html_source.strip()) < 10:
        raise ValueError("模板包缺少有效 HTML")
    if len(html_source.encode("utf-8")) > 8 * 1024 * 1024:
        raise ValueError("模板 HTML 超过 8MB，请改用文件导入")
    template = {
        "id": secrets.token_hex(8),
        "schema": "opslion-template/v2" if source.get("schema") == "opslion-template/v2" else "opslion-template/v1",
        "title": str(source.get("title") or "抓取的排版模板")[:200],
        "source_url": str(source.get("sourceUrl") or source.get("source_url") or "")[:2048],
        "source_type": str(source.get("sourceType") or source.get("source_type") or "unknown")[:40],
        "captured_at": str(source.get("capturedAt") or source.get("captured_at") or datetime.now().isoformat(timespec="seconds"))[:40],
        "html": html_source,
        "stats": source.get("stats") if isinstance(source.get("stats"), dict) else {},
        **({"source": source["source"]} if isinstance(source.get("source"), dict) else {}),
    }
    with _template_lock:
        # Multiple captures can be sent before their browser tabs finish opening.
        _pending_templates[template["id"]] = (time.monotonic(), template)
        while len(_pending_templates) > 8:
            _pending_templates.popitem(last=False)
    return {key: value for key, value in template.items() if key not in ("html", "source")} | {"html_length": len(html_source)}


def pending_template(consume: bool, capture_id: str = "") -> dict | None:
    with _template_lock:
        for key, (created, _) in list(_pending_templates.items()):
            if time.monotonic() - created > 1800:
                del _pending_templates[key]
        key = capture_id or next(reversed(_pending_templates), "")
        entry = _pending_templates.get(key)
        template = entry[1] if entry else None
        if consume and entry:
            del _pending_templates[key]
        return template


class Handler(BaseHTTPRequestHandler):
    server_version = "WechatStudioBridge/1.0"

    def log_message(self, format: str, *args) -> None:
        return

    def allowed_origin(self) -> str:
        origin = self.headers.get("Origin", "")
        if not origin:
            return "http://127.0.0.1:3000"
        if origin == "http://127.0.0.1:3000" or origin.startswith("chrome-extension://"):
            return origin
        return ""

    def read_json(self, maximum_bytes: int = 9 * 1024 * 1024) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > maximum_bytes:
            raise ValueError("请求体为空或超过大小限制")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return payload

    def send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def send_binary(self, body: bytes, content_type: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        origin = self.allowed_origin()
        if not origin:
            return self.send_json({"message": "Origin not allowed"}, HTTPStatus.FORBIDDEN)
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/health":
                return self.send_json({"ok": True})
            if parsed.path == "/agent/config":
                return self.send_json({"config": get_agent_config()})
            if parsed.path == "/assets/proxy":
                source = parse_qs(parsed.query).get("url", [""])[0]
                body, content_type = fetch_preview_asset(source)
                return self.send_binary(body, content_type)
            if parsed.path == "/templates/pending":
                consume = parse_qs(parsed.query).get("consume", ["0"])[0] == "1"
                capture_id = parse_qs(parsed.query).get("id", [""])[0]
                template = pending_template(consume, capture_id)
                return self.send_json({"template": template})
            return self.send_json({"message": "Not found"}, HTTPStatus.NOT_FOUND)
        except ValueError as error:
            return self.send_json({"message": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            return self.send_json({"message": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if not self.allowed_origin():
                return self.send_json({"message": "Origin not allowed"}, HTTPStatus.FORBIDDEN)
            if parsed.path == "/agent/config":
                return self.send_json({"ok": True, "config": save_agent_config(self.read_json(64 * 1024))})
            if parsed.path == "/agent/test":
                return self.send_json(test_agent_connection())
            if parsed.path == "/agent/profiles/delete":
                return self.send_json({"config": delete_agent_profile(self.read_json(1024))})
            if parsed.path == "/agent/policy":
                return self.send_json({"config": set_agent_policy(self.read_json(1024))})
            if parsed.path == "/agent/cancel":
                return self.send_json(cancel_agent_run(self.read_json(1024)))
            if parsed.path == "/agent/plan":
                return self.send_json(create_agent_plan(self.read_json(512 * 1024)))
            if parsed.path == "/templates/import":
                imported = store_template(self.read_json())
                return self.send_json({"ok": True, "template": imported}, HTTPStatus.ACCEPTED)
            return self.send_json({"message": "Not found"}, HTTPStatus.NOT_FOUND)
        except (AgentRuntimeError, ValueError) as error:
            return self.send_json({"message": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            return self.send_json({"message": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
