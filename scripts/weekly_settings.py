"""Machine-local weekly template details, shared by both editions and excluded from release bundles."""
import json
import re
import threading
from pathlib import Path

from collector_browser import default_runtime_directory

_lock = threading.RLock()
FIELDS = ("email", "contactPerson", "organization")


def settings_path():
    # Use the same native Local AppData resolver as the collector, outside its browser/session directory.
    return default_runtime_directory().parent / "weekly-template.json"


def validate_settings(payload):
    if not isinstance(payload, dict) or set(payload) != set(FIELDS):
        raise ValueError("请填写邮箱、联系人和落款组织")
    result = {}
    for key in FIELDS:
        value = payload[key]
        if not isinstance(value, str) or len(value) > 300 or re.search(r"[\x00-\x1f\x7f]", value):
            raise ValueError("固定信息应为不超过 300 字的单行文本")
        result[key] = value.strip()
    if result["email"] and not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", result["email"]):
        raise ValueError("请填写有效的邮箱地址")
    return result


def get_weekly_settings():
    with _lock:
        path = settings_path()
        if not path.exists():
            return dict.fromkeys(FIELDS, "")
        try:
            return validate_settings(json.loads(path.read_text(encoding="utf-8-sig")))
        except (ValueError, OSError) as error:
            raise ValueError("本机周报固定信息无法读取，请重新保存模板设置") from error


def save_weekly_settings(payload):
    settings = validate_settings(payload)
    with _lock:
        path = settings_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(str(path) + ".tmp")
        temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    return settings
