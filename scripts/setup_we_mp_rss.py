"""Initialize private upstream runtime; optionally copy an old instance read-only."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3


def initialize(source: Path, runtime: Path, import_from: Path | None = None):
    import yaml
    source, runtime = source.resolve(), runtime.resolve()
    project = Path(__file__).resolve().parent.parent
    if runtime.is_relative_to(project) or runtime.is_relative_to(source):
        raise ValueError("运行数据须放在 OpsLion 和 we-mp-rss 源码目录之外")
    for name in ("main.py", "web.py", "requirements.txt", "static/index.html", "config.example.yaml"):
        if not (source / name).is_file():
            raise ValueError(f"we-mp-rss 源码不完整：缺少 {name}")
    runtime.mkdir(parents=True, exist_ok=True)
    config_path = runtime / "config.yaml"
    if config_path.exists():
        if import_from:
            raise ValueError("运行目录已有配置，未覆盖已有数据库；迁移请使用新的运行目录")
        return
    (runtime / "data").mkdir(exist_ok=True)
    template = source / "config.example.yaml"
    if import_from:
        import_from = import_from.resolve()
        if import_from == runtime or not (import_from / "config.yaml").is_file():
            raise ValueError("ImportFrom 须指向原版 we-mp-rss 实例目录")
        template = import_from / "config.yaml"
        original_config = yaml.safe_load(template.read_text(encoding="utf-8-sig")) or {}
        original_db = original_config.get("db", "")
        if original_db not in ("sqlite:///./data/db.db", "sqlite:///data/db.db", "${DB:-sqlite:///./data/db.db}") or not (import_from / "data/db.db").is_file():
            raise ValueError("自动迁移仅支持原版 data/db.db SQLite 实例；其他数据库请按上游方式迁移")
        old_data = import_from / "data"
        if old_data.is_dir():
            for item in old_data.iterdir():
                if item.is_symlink() or item.suffix in (".lock", ".pid") or item.name.endswith(("-wal", "-shm", "-journal")):
                    continue
                target = runtime / "data" / item.name
                if item.is_file() and item.suffix == ".db":
                    with sqlite3.connect(item.as_uri() + "?mode=ro", uri=True) as old, sqlite3.connect(target) as new:
                        old.backup(new)
                elif item.is_dir():
                    shutil.copytree(item, target, symlinks=False)
                else:
                    shutil.copy2(item, target)
    config = yaml.safe_load(template.read_text(encoding="utf-8-sig")) or {}
    # The runtime owns its database. Do not point writes back at the old instance.
    config["db"] = "sqlite:///./data/db.db"
    # Preserve original functionality. Redis remains optional in a local install.
    config.setdefault("redis", {})["url"] = ""
    config["redis"].setdefault("server", {})["enabled"] = False
    config["secret"] = secrets.token_urlsafe(48)
    config.setdefault("server", {})["web_name"] = "WeRSS 微信公众号订阅助手"
    config["server"]["threads"] = 1
    config["server"]["auto_reload"] = False
    config.setdefault("gather", {})["content"] = True
    config_path.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
    (runtime / "opslion-admin.json").write_text(json.dumps({"username": "admin", "password": secrets.token_urlsafe(18)}, indent=2), encoding="utf-8")
    (runtime / "opslion-token.txt").write_text(secrets.token_urlsafe(32), encoding="utf-8")
    if os.name != "nt":
        for path in (config_path, runtime / "opslion-admin.json", runtime / "opslion-token.txt"):
            path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--import-from", type=Path)
    args = parser.parse_args()
    initialize(args.source, args.runtime, args.import_from)
    print("完整 RSS 运行目录已就绪；原实例的文件仅作读取。")


if __name__ == "__main__":
    main()
