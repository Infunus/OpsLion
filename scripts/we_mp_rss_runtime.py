"""Connect to the complete upstream service, optionally starting a local instance.

This module is stdlib-only. All WeChat operations live in upstream we-mp-rss.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

PROTOCOL = "opslion-rss/v1"
_start_lock = threading.Lock()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise ValueError("RSS 服务返回重定向，已停止以保护接口密钥；请填写最终服务地址")


def process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 259)
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def absolute_path(value, label: str, *, directory=False) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"请配置 {label} 的绝对路径")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{label} 必须是绝对路径")
    if not (path.is_dir() if directory else path.is_file()):
        raise ValueError(f"{label} 指向的{'目录' if directory else '文件'}不存在")
    return path.resolve()


class WeMpRssClient:
    def __init__(self, config: dict):
        self.config = config
        self.source = None
        self.runtime = None
        self.python = None
        self.base_url = str(config.get("rss_url") or "http://127.0.0.1:8001").rstrip("/")
        url = urlsplit(self.base_url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("rss_url 必须是服务根地址，不能含用户名、密码、路径或查询参数")
        if url.scheme == "http" and url.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("远程 RSS 服务请使用 HTTPS")
        self.port = url.port or (443 if url.scheme == "https" else 80)
        if config.get("rss_root"):
            if url.scheme != "http" or url.hostname != "127.0.0.1":
                raise ValueError("自动启动的本地 RSS 服务请使用 http://127.0.0.1:端口")
            self.source = absolute_path(config["rss_root"], "rss_root", directory=True)
            for filename in ("main.py", "web.py", "requirements.txt", "static/index.html", "core/wx/base.py"):
                if not (self.source / filename).is_file():
                    raise ValueError("rss_root 须指向包含后端和 static/index.html 的完整 we-mp-rss")
            self.python = absolute_path(config.get("rss_python"), "rss_python")
            self.runtime = absolute_path(config.get("rss_data_dir"), "rss_data_dir", directory=True)
            if not (self.runtime / "config.yaml").is_file():
                raise ValueError("RSS 尚未初始化，请先运行 scripts/setup-rss.ps1")
            if self.runtime == self.source or self.runtime.is_relative_to(self.source):
                raise ValueError("rss_data_dir 请放在源码目录之外")
            self.token_path = self.runtime / "opslion-token.txt"
        else:
            self.token_path = absolute_path(config.get("rss_token_file"), "rss_token_file")
        # A system proxy must never capture local service credentials.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def token(self) -> str:
        if self.runtime:
            try:
                with self.token_path.open("x", encoding="utf-8") as handle:
                    handle.write(secrets.token_urlsafe(32))
                if os.name != "nt":
                    self.token_path.chmod(0o600)
            except FileExistsError:
                pass
        token = self.token_path.read_text(encoding="utf-8").strip()
        if len(token) < 32 or any(char.isspace() for char in token):
            raise ValueError("RSS 接口密钥文件无效，请检查 rss_token_file")
        return token

    def request(self, operation: str, payload=None, timeout=28) -> dict:
        request = Request(
            f"{self.base_url}/opslion/v1/{operation}",
            data=json.dumps(payload or {}, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token()}"},
            method="POST",
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(24 * 1024 * 1024 + 1)
                if len(raw) > 24 * 1024 * 1024:
                    raise ValueError("RSS 响应过大，请缩小分页")
                data = json.loads(raw)
        except HTTPError as error:
            if error.code in (401, 403):
                raise ValueError("RSS 接口密钥不匹配，请检查服务的 opslion-token.txt") from None
            if error.code == 404:
                raise ValueError("该服务未加载 OpsLion 接口，请用 scripts/we_mp_rss_server.py 启动完整 we-mp-rss") from None
            raise ValueError(f"RSS 服务返回 HTTP {error.code}") from None
        except (UnicodeError, json.JSONDecodeError):
            raise ValueError("RSS 服务没有返回有效 JSON") from None
        if not isinstance(data, dict):
            raise ValueError("RSS 服务返回格式错误")
        if data.get("error"):
            raise ValueError(str(data.get("message") or "RSS 操作失败"))
        return data

    def ensure_running(self):
        try:
            health = self.request("health", timeout=2)
            if health.get("protocol") != PROTOCOL or health.get("engine") != "we-mp-rss":
                raise ValueError("RSS 服务身份或协议不兼容")
            return
        except (URLError, TimeoutError, ConnectionError):
            if not self.runtime:
                raise ValueError("无法连接 RSS 服务，请检查 rss_url 和服务运行状态") from None
        with _start_lock:
            # The OS file lock also serializes starts from two OpsLion checkouts.
            lock_path = self.runtime / "opslion-start.lock"
            with lock_path.open("a+b") as lock:
                lock.seek(0)
                lock.write(b"0")
                lock.flush()
                lock.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                try:
                    self._start_locked()
                finally:
                    lock.seek(0)
                    if os.name == "nt":
                        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)

    def _start_locked(self):
        try:
            self.request("health", timeout=2)
            return
        except (URLError, TimeoutError, ConnectionError):
            pass
        marker = self.runtime / "opslion-starting.json"
        if marker.exists():
            try:
                pending = json.loads(marker.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pending = {}
            if process_alive(pending.get("pid")):
                raise ValueError("完整 RSS 的启动进程尚未就绪，请稍后重新连接；不会重复启动。日志见 rss_data_dir/opslion-service.log")
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", self.port)) == 0:
                raise ValueError(f"RSS 端口 {self.port} 已被其他服务占用，请修改 rss_url")
        script = Path(__file__).with_name("we_mp_rss_server.py")
        with (self.runtime / "opslion-service.log").open("ab") as output:
            try:
                child = subprocess.Popen(
                    [str(self.python), str(script), "--source", str(self.source), "--runtime", str(self.runtime), "--port", str(self.port)],
                    cwd=self.runtime, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                    env={**os.environ, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"},
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
            except OSError:
                raise ValueError("无法启动完整 RSS，请检查 rss_python 和依赖安装") from None
        marker.write_text(json.dumps({"pid": child.pid, "started_at": time.time()}), encoding="utf-8")
        deadline = time.monotonic() + 24
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise ValueError("完整 RSS 启动失败，请运行 scripts/setup-rss.ps1 检查依赖；日志位于 rss_data_dir/opslion-service.log")
            try:
                self.request("health", timeout=1)
                marker.unlink(missing_ok=True)
                return
            except (URLError, TimeoutError, ConnectionError):
                time.sleep(0.25)
        raise ValueError("完整 RSS 仍在启动，请稍后点击重新连接；启动日志位于 rss_data_dir/opslion-service.log")

    def call(self, operation: str, payload=None):
        self.ensure_running()
        try:
            result = self.request(operation, payload)
        except (URLError, TimeoutError, ConnectionError):
            raise ValueError("RSS 服务响应超时或已退出，请重新连接后检查任务状态") from None
        if operation == "status":
            result["management_url"] = self.base_url
            result["management_mode"] = "native"
        return result
