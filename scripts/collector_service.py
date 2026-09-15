"""Local, private lifecycle for the bundled browser-based article collector."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
from collector_browser import browser_name, default_runtime_directory, resolve_browser

CHINA = timezone(timedelta(hours=8))
ACTIVE = {"running", "cancelling"}
ACTIONS = {"initialize", "login", "open-browser", "check", "shelf", "resolve", "add", "update", "logout", "collect", "export", "resume"}


def read_json(file, default=None):
    try:
        return json.loads(Path(file).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default


def write_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(file)


def validate_range(payload):
    try:
        start = datetime.strptime(payload.get("start_date", ""), "%Y-%m-%d").date()
        end = datetime.strptime(payload.get("end_date", ""), "%Y-%m-%d").date()
        if start.isoformat() != payload["start_date"] or end.isoformat() != payload["end_date"] or start > end:
            raise ValueError()
        if (end - start).days > 366:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("请选择有效的起止日期，范围最长一年。") from None


class CollectorService:
    def __init__(self, config_file, *, runtime=None):
        self.config_file = Path(config_file)
        self.root = self.config_file.resolve().parent.parent
        local = read_json(self.config_file, {})
        fallback = default_runtime_directory()
        self.runtime = Path(runtime or os.environ.get("OPSLION_COLLECTOR_DATA_DIR") or local.get("weread_fetcher_data_dir") or fallback).resolve()
        if self.runtime.is_relative_to(self.root):
            raise ValueError("公众号采集资料必须保存在项目目录之外。")
        self.source = self.root / "integrations" / "weread-mp-fetcher"
        self.config_path = self.runtime / "config.json"
        self.lock = threading.RLock()
        self.active = None
        self._python_checked = False
        self._python_path = None
        self._ensure_config()

    def _ensure_config(self):
        if not self.config_path.exists():
            self.runtime.mkdir(parents=True, exist_ok=True)
            port = 9333
            for candidate in range(9333, 9399):
                with socket.socket() as probe:
                    try:
                        probe.bind(("127.0.0.1", candidate))
                        port = candidate
                        break
                    except OSError:
                        continue
            write_json(self.config_path, {"accounts": [], "readerUrl": "", "maxRunsPerDay": 2,
                "requestIntervalMs": 3000, "maxRequestsPerDay": 40, "maxPagesPerRun": 3, "chromePort": port,
                "chromeProfileDir": str(self.runtime / "chrome-profile"), "outDir": str(self.runtime / "exports"), "statePath": str(self.runtime / "quota.json")})
        config = read_json(self.config_path)
        for key in ("chromeProfileDir", "outDir", "statePath"):
            if not Path(config[key]).is_absolute() or not Path(config[key]).resolve().is_relative_to(self.runtime):
                raise ValueError("采集配置包含运行目录之外的路径。")
        Path(config["outDir"]).mkdir(parents=True, exist_ok=True)

    def _browser(self):
        return resolve_browser(read_json(self.config_file, {}))

    def _select_profile(self, browser):
        """Separate browser families; never open a Chrome profile in Edge or vice versa."""
        config = read_json(self.config_path)
        marker_file = self.runtime / "browser.json"
        marker = read_json(marker_file, {})
        key = Path(browser).stem.lower()
        profiles = marker.get("profiles", {})
        if not marker and (Path(config["chromeProfileDir"]) / "Local State").is_file():
            previous = read_json(self.config_file, {}).get("weread_fetcher_chrome")
            if previous:
                profiles[Path(previous).stem.lower()] = config["chromeProfileDir"]
        selected = Path(profiles.get(key) or self.runtime / "browser-profiles" / key).resolve()
        if not selected.is_relative_to(self.runtime):
            raise ValueError("采集浏览器目录必须位于本机运行目录。")
        profiles[key] = str(selected)
        if Path(config["chromeProfileDir"]).resolve() != selected:
            config["chromeProfileDir"] = str(selected)
            for candidate in range(9333, 9400):
                with socket.socket() as probe:
                    try:
                        probe.bind(("127.0.0.1", candidate))
                        config["chromePort"] = candidate
                        break
                    except OSError:
                        continue
            else:
                raise ValueError("没有可用的本机采集端口。")
            write_json(self.config_path, config)
            write_json(self.runtime / "session.json", {"state": "unknown", "message": f"已选择默认浏览器 {browser_name(browser)}，请在此扫码登录。"})
        write_json(marker_file, {"browser": key, "profiles": profiles})

    def login_status(self):
        login = read_json(self.runtime / "login.json")
        if not login:
            return None
        if login.get("state") in {"loading", "waiting"} and (self.active != login.get("id") or login.get("expires_at", 0) <= time.time() * 1000):
            return {**login, "state": "expired", "qr_available": False, "message": "二维码已过期或任务已中断，请重新获取。"}
        return login

    def login_image(self, identifier):
        login = self.login_status()
        file = self.runtime / "login-qr.png"
        if not login or login.get("id") != identifier or not login.get("qr_available") or login.get("state") != "waiting" or not file.is_file() or not file.resolve().is_relative_to(self.runtime) or file.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("二维码已失效，请重新获取。")
        return file

    def _python(self):
        if self._python_checked:
            return self._python_path if self._python_path and Path(self._python_path).is_file() else None
        self._python_checked = True
        marker = read_json(self.runtime / "environment.json", {})
        local = read_json(self.config_file, {})
        candidates = [marker.get("python"), local.get("collector_python"), local.get("rss_python"), sys.executable]
        for executable in dict.fromkeys(candidate for candidate in candidates if candidate and Path(candidate).is_file()):
            try:
                result = subprocess.run([executable, "-c", "import bs4,markdownify,requests"], capture_output=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if result.returncode == 0:
                    self._python_path = executable
                    return executable
            except (OSError, subprocess.TimeoutExpired):
                pass
        return None

    def _exports(self):
        directory = Path(read_json(self.config_path)["outDir"]).resolve()
        output = []
        for folder in directory.iterdir():
            if not folder.is_dir() or folder.is_symlink() or not folder.resolve().is_relative_to(directory):
                continue
            manifest_file = folder / "package" / "manifest.json"
            if not manifest_file.is_file():
                continue
            try:
                manifest = read_json(manifest_file)
                if manifest.get("schema") != "opslion-rss/archive-v1":
                    continue
                start, end = manifest["start_date"], manifest["end_date"]
                validate_range({"start_date": start, "end_date": end})
                suffix = "" if manifest.get("archive_complete") else "_含缺失项"
                archive = folder / f"推文资料_{start}_{end}{suffix}.zip"
                if not archive.is_file():
                    continue
                output.append({"id": hashlib.sha256(folder.name.encode()).hexdigest()[:24], "start_date": start, "end_date": end,
                    "article_count": manifest["article_count"], "body_count": manifest["body_count"], "image_count": manifest["image_count"],
                    "complete": bool(manifest["archive_complete"]), "created_at": manifest["created_at"], "size": archive.stat().st_size,
                    "issues": manifest.get("issues", [])[:80], "_folder": folder, "_archive": archive})
            except (ValueError, KeyError, OSError):
                continue
        return sorted(output, key=lambda item: item["created_at"], reverse=True)

    def download(self, export_id, kind):
        if not re.fullmatch(r"[a-f0-9]{24}", export_id or "") or kind not in {"zip", "text", "index"}:
            raise ValueError("无效的下载请求。")
        item = next((item for item in self._exports() if item["id"] == export_id), None)
        if item is None:
            raise ValueError("资料包不存在，请重新打包。")
        file = item["_archive"] if kind == "zip" else item["_folder"] / "package" / ("all-text.md" if kind == "text" else "index.json")
        if not file.resolve().is_relative_to(item["_folder"].resolve()) or not file.is_file():
            raise ValueError("下载文件不可用。")
        return file, {"zip": "application/zip", "text": "text/markdown; charset=utf-8", "index": "application/json; charset=utf-8"}[kind]

    def status(self):
        with self.lock:
            config = read_json(self.config_path)
            job = read_json(self.runtime / "job.json")
            if job and job.get("state") in ACTIVE and self.active is None:
                job.update(state="paused", message="上次任务已中断，可继续下载；已保存的内容会复用。")
                write_json(self.runtime / "job.json", job)
            work = read_json(self.runtime / "last-collection.json")
            if work and work.get("state") in ACTIVE and self.active is None:
                work.update(state="paused", message="上次采集已中断，可以继续。")
                write_json(self.runtime / "last-collection.json", work)
            quota = read_json(config["statePath"], {})
            if quota.get("date") != datetime.now(CHINA).date().isoformat():
                quota = {}
            indexes = [folder / "articles.json" for folder in Path(config["outDir"]).iterdir() if folder.is_dir() and (folder / "articles.json").is_file()]
            browser = self._browser()
            return {"protocol": "opslion-collector/v1", "prepared": bool(self._python()), "browser_available": bool(browser), "browser_name": browser_name(browser), "login": self.login_status(),
                "module_available": (self.source / "lib" / "cdp.mjs").is_file(), "node_available": bool(shutil.which("node")),
                "session": read_json(self.runtime / "session.json", {"state": "unknown", "message": "点击扫码登录，在排版台完成授权。"}),
                "accounts": [{"bookId": row["bookId"], "name": row["name"], "enabled": row.get("enabled", True)} for row in config["accounts"]],
                "has_index": bool(indexes), "job": {key: value for key, value in job.items() if key != "payload"} if job else None,
                "resume_job": {key: value for key, value in work.items() if key != "payload"} if work and work.get("state") in {"paused", "failed", "cancelled"} else None,
                "exports": [{key: value for key, value in item.items() if not key.startswith("_")} for item in self._exports()[:10]],
                "quota": {"used": sum(int(value or 0) for value in quota.get("requests", {}).values()), "max": config["maxRequestsPerDay"], "runs": quota.get("count", 0), "max_runs": config["maxRunsPerDay"]}}

    def start(self, payload):
        action = payload.get("action")
        if action not in ACTIONS:
            raise ValueError("不支持的采集操作。")
        with self.lock:
            if self.active is not None:
                raise ValueError("当前有操作正在进行，请等待完成或先停止。")
            if action == "resume":
                old = read_json(self.runtime / "last-collection.json") or read_json(self.runtime / "job.json", {})
                if old.get("id") != payload.get("job_id") or old.get("action") not in {"collect", "export"} or old.get("state") not in {"paused", "failed", "cancelled"}:
                    raise ValueError("该任务不能继续，请重新选择日期。")
                payload = {**old["payload"], "resume": True}
                action = payload["action"]
            if action in {"collect", "export"}:
                validate_range(payload)
                if not self._python():
                    raise ValueError("请先初始化采集环境。")
            safe_payload = {key: value for key, value in payload.items() if key in {"action", "start_date", "end_date", "url", "bookId", "operation", "resume"}}
            if action in {"add", "update"} and not re.fullmatch(r"MP_WXS_\d+", str(payload.get("bookId", ""))):
                raise ValueError("公众号标识无效。")
            if action == "update" and payload.get("operation") not in {"pause", "resume", "remove"}:
                raise ValueError("不支持的公众号操作。")
            if action == "resolve" and (not isinstance(payload.get("url"), str) or len(payload["url"]) > 4096):
                raise ValueError("请填写公众号文章链接。")
            job = {"id": uuid.uuid4().hex, "action": action, "payload": safe_payload, "state": "running", "stage": action,
                "message": "正在准备…", "started_at": datetime.now(CHINA).isoformat(), "completed": 0, "total": 0, "result": None}
            write_json(self.runtime / "job.json", job)
            if action in {"collect", "export"}:
                write_json(self.runtime / "last-collection.json", job)
            self.active = job["id"]
            threading.Thread(target=self._run, args=(job,), daemon=True).start()
            return {"job_id": job["id"]}

    def cancel(self, job_id):
        with self.lock:
            job = read_json(self.runtime / "job.json", {})
            if not self.active or job.get("id") != job_id:
                raise ValueError("当前任务已经结束。")
            (self.runtime / (job_id + ".cancel")).touch()
            job.update(state="cancelling", message="正在停止，已保存的内容会保留。")
            write_json(self.runtime / "job.json", job)
            return {"ok": True}

    def _progress(self, job, **patch):
        with self.lock:
            current = read_json(self.runtime / "job.json", {})
            if current.get("id") == job["id"]:
                current.update(patch)
                write_json(self.runtime / "job.json", current)
                if current.get("action") in {"collect", "export"}:
                    write_json(self.runtime / "last-collection.json", current)

    def _command(self, args, job, *, payload=None, env=None, json_events=False, timeout=1200):
        messages = queue.Queue()
        cancel_file = self.runtime / (job["id"] + ".cancel")
        with subprocess.Popen(args, cwd=self.root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as process:
            if payload is not None:
                process.stdin.write(json.dumps(payload, ensure_ascii=False))
            process.stdin.close()
            def drain(stream, error=False):
                for line in stream:
                    messages.put((error, line))
                stream.close()
            readers = [threading.Thread(target=drain, args=(process.stdout,), daemon=True), threading.Thread(target=drain, args=(process.stderr, True), daemon=True)]
            for reader in readers:
                reader.start()
            deadline = time.monotonic() + timeout
            result = None
            output = []
            while process.poll() is None or not messages.empty() or any(reader.is_alive() for reader in readers):
                if time.monotonic() > deadline or (cancel_file.exists() and job["action"] == "initialize"):
                    process.terminate()
                    raise ValueError("操作已停止，稍后可重试。")
                try:
                    is_error, line = messages.get(timeout=.2)
                except queue.Empty:
                    continue
                output.append(line)
                output = output[-12:]
                if json_events and not is_error:
                    try:
                        event = json.loads(line)
                        if event.get("event") == "progress":
                            self._progress(job, **{key: event[key] for key in ("stage", "message", "completed", "total") if key in event})
                        elif event.get("event") == "result":
                            result = event
                    except ValueError:
                        pass
            if process.returncode:
                if result and result.get("message"):
                    raise ValueError(result["message"])
                detail = "".join(output)[-600:].strip()
                raise ValueError("操作未完成。" + (detail if json_events else "请检查网络和运行环境后重试。"))
            return result if json_events else "".join(output)

    def _open_verification(self, job, browser, env, *, already_visible=False):
        cancel_file = self.runtime / (job["id"] + ".cancel")
        if cancel_file.exists():
            return {"state": "cancelled"}
        file = self.runtime / "verification.json"
        verification = read_json(file, {})
        if verification.get("auto_job_id") == job["id"]:
            return verification.get("outcome", {"state": "paused", "code": "verification"})
        verification["auto_job_id"] = job["id"]
        write_json(file, verification)
        self._progress(job, stage="verification", message="检测到人机验证，正在打开默认浏览器…")
        opened = False
        try:
            if not browser:
                raise ValueError("没有受支持的默认浏览器。")
            if not already_visible:
                command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.root / "scripts" / "collector-browser.ps1"),
                    "-Action", "Start", "-ConfigFile", str(self.config_path), "-Mode", "Visible", "-Browser", browser, "-SwitchMode"]
                state = json.loads(self._command(command, job, timeout=45))
                if not state.get("running"):
                    raise ValueError("浏览器未启动。")
            if cancel_file.exists():
                return {"state": "cancelled"}
            self._command([shutil.which("node") or "node", str(self.root / "scripts" / "collector-verification.mjs"), str(self.config_path)], job, env=env, timeout=45)
            opened = True
        except Exception:
            # Keep the checkpoint and a retry control even if window activation fails.
            pass
        continuation = "继续上次任务" if job["action"] in {"collect", "export"} else "检查登录"
        message = (f"已自动打开默认浏览器 {browser_name(browser)}，请在窗口中完成验证；如需重新扫码，请在该窗口完成。随后回到排版台点击“{continuation}”。"
            if opened else "检测到人机验证，进度已保存。默认浏览器未能自动打开，请点击“重新打开验证页面”重试。")
        outcome = {"state": "paused", "code": "verification", "browser_opened": opened, "message": message}
        write_json(file, {**read_json(file, verification), "auto_job_id": job["id"], "outcome": outcome})
        write_json(self.runtime / "session.json", {"state": "verification", "message": message})
        write_json(self.runtime / "login.json", {"id": job["id"], "state": "verification", "qr_available": False, "message": message})
        (self.runtime / "login-qr.png").unlink(missing_ok=True)
        return outcome

    def _run(self, job):
        cancel_file = self.runtime / (job["id"] + ".cancel")
        try:
            browser = self._browser()
            action = job["action"]
            if action == "initialize":
                if not (self.source / "lib" / "cdp.mjs").is_file() or not shutil.which("node"):
                    raise ValueError("项目缺少采集模块或 Node.js，请检查项目安装。")
                if not browser:
                    raise ValueError("默认浏览器暂不支持采集，请将 Windows 默认浏览器设为 Edge、Chrome、Brave、Vivaldi 或 Chromium 后重试。")
                executable = self._python()
                if not executable:
                    environment = self.runtime / "python-env"
                    executable = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
                    self._progress(job, message="正在创建独立采集环境…")
                    self._command([sys.executable, "-m", "venv", str(environment)], job)
                    self._progress(job, message="正在安装正文解析依赖，首次使用需要联网…")
                    self._command([str(executable), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(self.root / "scripts" / "collector-requirements.txt")], job)
                    self._command([str(executable), "-c", "import bs4,markdownify,requests"], job)
                self._python_path, self._python_checked = str(executable), True
                write_json(self.runtime / "environment.json", {"python": str(executable), "version": 1})
                result = {"message": "采集环境已就绪，可以在此扫码登录。"}
            else:
                env = {**os.environ, "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1", "OPSLION_COLLECTOR_DATA_DIR": str(self.runtime),
                    "OPSLION_COLLECTOR_SOURCE": str(self.source), "OPSLION_COLLECTOR_PYTHON": str(self._python() or sys.executable)}
                if action != "update" and (browser or action == "export"):
                    if browser:
                        self._select_profile(browser)
                    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.root / "scripts" / "collector-browser.ps1"),
                        "-Action", "Start" if browser else "Check", "-ConfigFile", str(self.config_path), "-Mode", "Visible" if action == "open-browser" else "Background"]
                    if browser:
                        command.extend(["-Browser", browser])
                    if action in {"login", "open-browser"}:
                        command.append("-SwitchMode")
                    check = self._command(command, job, timeout=45)
                    state = json.loads(check)
                    if not state.get("running") and action != "export":
                        raise ValueError("采集会话未启动，请点击扫码登录后重试。")
                elif action not in {"update", "export"}:
                    raise ValueError("默认浏览器暂不支持采集，请检查 Windows 默认应用设置。")
                if action == "open-browser":
                    verification = read_json(self.runtime / "verification.json", {})
                    if verification.get("state") in {"pending", "opened"} and time.time() * 1000 - verification.get("created_at", 0) < 30 * 60 * 1000:
                        result = self._open_verification(job, browser, env, already_visible=True)
                    else:
                        session = {"state": "unknown", "message": f"已打开默认浏览器 {browser_name(browser)}，完成登录或验证后回到这里检查登录。"}
                        write_json(self.runtime / "session.json", session)
                        write_json(self.runtime / "login.json", {"id": job["id"], "state": "external", "qr_available": False, "message": session["message"]})
                        (self.runtime / "login-qr.png").unlink(missing_ok=True)
                        result = {"message": session["message"]}
                else:
                    request = {**job["payload"], "cancel_file": str(cancel_file), "job_id": job["id"]}
                    result = self._command([shutil.which("node") or "node", str(self.root / "scripts" / "collector-worker.mjs")], job, payload=request, env=env, json_events=True)
                    if result and result.get("code") == "verification" and not cancel_file.exists():
                        result = {**result, **self._open_verification(job, browser, env)}
                    elif (result or {}).get("state", "complete") == "complete" and action in {"login", "check", "shelf", "collect", "export"}:
                        (self.runtime / "verification.json").unlink(missing_ok=True)
            self._progress(job, state="cancelled" if cancel_file.exists() else (result or {}).get("state", "complete"), result=result,
                message="已停止，已保存的内容可继续使用。" if cancel_file.exists() else (result or {}).get("message", "操作完成。"))
        except Exception as error:
            self._progress(job, state="cancelled" if cancel_file.exists() else "failed", message=str(error)[:900])
        finally:
            with self.lock:
                self.active = None
