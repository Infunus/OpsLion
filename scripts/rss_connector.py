"""Full we-mp-rss service connector with optional opslion-rss/v1 process support."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PROTOCOL = "opslion-rss/v1"
OPERATIONS = frozenset({
    "status", "articles", "article", "refresh", "refresh_status", "cancel",
    "management", "auth_start", "auth_poll", "auth_check", "auth_cancel", "auth_logout",
    "feed_resolve", "feed_add", "feed_update", "legacy_weeks", "legacy_week",
})


class RssConnector:
    def __init__(self, config_path: Path):
        self.config_path = config_path

    def config(self) -> dict:
        try:
            config = json.loads(self.config_path.read_text(encoding="utf-8-sig")) if self.config_path.exists() else {}
        except (OSError, ValueError):
            raise ValueError("无法读取 config/local.paths.json，请检查文件权限和 JSON 格式（Windows 路径可使用 /）") from None
        if not isinstance(config, dict):
            raise ValueError("config/local.paths.json 必须是 JSON 对象")
        for key in ("rss_backend", "rss_root", "rss_data_dir", "rss_url", "rss_token_file", "rss_provider", "rss_python"):
            if os.environ.get(f"OPSLION_{key.upper()}"):
                config[key] = os.environ[f"OPSLION_{key.upper()}"]
        return config

    def command(self, config=None) -> list[str] | None:
        config = self.config() if config is None else config
        provider = os.environ.get("OPSLION_RSS_PROVIDER") or config.get("rss_provider")
        if provider is None or provider == "":
            return None
        if not isinstance(provider, str):
            raise ValueError("rss_provider 必须是适配脚本的绝对路径")
        path = Path(provider).expanduser()
        if not path.is_absolute() or not path.is_file():
            raise ValueError("RSS 适配脚本不存在，请检查 rss_provider 的绝对路径")
        python = os.environ.get("OPSLION_RSS_PYTHON") or config.get("rss_python") or sys.executable
        if not isinstance(python, str) or not Path(python).expanduser().is_absolute() or not Path(python).expanduser().is_file():
            raise ValueError("RSS Python 程序不存在，请检查 rss_python 的绝对路径")
        return [str(Path(python).expanduser()), str(path)]

    def call(self, operation: str, payload: dict | None = None) -> dict:
        if operation not in OPERATIONS:
            raise ValueError("不支持这个 RSS 操作")
        config = self.config()  # Read configuration on every request, including after edits.
        if config.get("rss_backend") == "we-mp-rss" or config.get("rss_root") or config.get("rss_url"):
            from we_mp_rss_runtime import WeMpRssClient
            from rss_legacy import read_legacy
            if operation in ("legacy_week", "legacy_weeks"):
                return read_legacy(config, operation, payload)
            result = WeMpRssClient(config).call(operation, payload)
            if operation == "status" and config.get("rss_legacy_portal_db"):
                result["legacy"] = read_legacy(config, "legacy_weeks")
            return result
        command = self.command(config)
        if command is None:
            if operation == "status":
                return {"protocol": PROTOCOL, "available": False, "message": "尚未接入 RSS", "feeds": [], "totals": {}}
            if operation == "articles":
                return {"articles": [], "count": 0, "total": 0, "next_offset": None}
            if operation == "refresh_status":
                return {"running": False, "return_code": None}
            if operation == "legacy_weeks":
                return {"available": False, "weeks": []}
            if operation == "legacy_week":
                return {}
            raise ValueError("尚未接入 RSS，请配置 config/local.paths.json 后重新连接")
        try:
            result = subprocess.run(
                [*command, operation], input=json.dumps(payload or {}, ensure_ascii=False),
                capture_output=True, text=True, encoding="utf-8", timeout=30,
                cwd=str(Path(command[1]).parent), env={**os.environ, "PYTHONUTF8": "1"},
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        except subprocess.TimeoutExpired:
            raise ValueError("RSS 接口响应超时；采集操作应在后台运行并立即返回任务编号") from None
        except OSError:
            raise ValueError("无法启动 RSS 适配程序，请检查 Python 路径和模块依赖") from None
        except UnicodeError:
            raise ValueError("RSS 接口未返回有效 UTF-8 JSON，请检查模块编码") from None
        try:
            response = json.loads(result.stdout)
        except (ValueError, TypeError):
            raise ValueError("RSS 接口未返回有效 JSON，请检查独立模块的依赖，并将日志写入 stderr") from None
        if not isinstance(response, dict):
            raise ValueError("RSS 接口返回格式错误：需要 JSON 对象")
        if result.returncode or response.get("error"):
            # Provider messages are part of the public contract; raw stderr may contain secrets.
            raise ValueError(str(response.get("message") or "RSS 接口调用失败"))
        if operation == "status":
            if response.get("protocol") != PROTOCOL:
                raise ValueError("RSS 协议不兼容：适配程序须声明 opslion-rss/v1；完整 we-mp-rss 请使用仓库内置接入器")
            if not isinstance(response.get("available"), bool) or not isinstance(response.get("feeds", []), list):
                raise ValueError("RSS 状态格式错误：需要 available 布尔值与 feeds 数组")
        return response
