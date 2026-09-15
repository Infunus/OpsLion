"""Resolve the Windows default browser without executing its registry command."""
import os
from pathlib import Path
import re
import shutil

SUPPORTED = {"msedge.exe": "Microsoft Edge", "chrome.exe": "Google Chrome", "brave.exe": "Brave", "vivaldi.exe": "Vivaldi", "chromium.exe": "Chromium"}


def default_runtime_directory():
    if os.name == "nt":
        import ctypes
        directory = ctypes.create_unicode_buffer(32768)
        # Resolve the user's real Local AppData, independent of a packaged host's environment.
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x001C, None, 0, directory) == 0 and directory.value:
            return Path(directory.value) / "OpsLion" / "collector"
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "OpsLion" / "collector"


def executable_from_command(command):
    match = re.match(r'^\s*(?:"([^"\r\n]+\.exe)"|([^"\r\n]+?\.exe))(?:\s|$)', command or "", re.I)
    return match.group(1) or match.group(2) if match else None


def default_browser():
    if os.name != "nt":
        return None
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice") as key:
            program = winreg.QueryValueEx(key, "ProgId")[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, program + r"\shell\open\command") as key:
            executable = executable_from_command(winreg.QueryValue(key, None))
        return {"executable": executable, "program": program}
    except OSError:
        return None


def resolve_browser(local):
    preferred = default_browser()
    if os.name == "nt" and preferred is None:
        return None
    if preferred:
        candidate = preferred["executable"]
        if not candidate or Path(candidate).name.lower() not in SUPPORTED or not Path(candidate).is_file():
            return None
        return str(Path(candidate).resolve())
    candidates = [local.get("weread_fetcher_chrome"), shutil.which("msedge"), shutil.which("chrome")]
    for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
        if base:
            candidates.extend(str(Path(base) / relative) for relative in ("Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe"))
    return next((str(Path(candidate).resolve()) for candidate in candidates if candidate and Path(candidate).name.lower() in SUPPORTED and Path(candidate).is_file()), None)


def browser_name(executable):
    return SUPPORTED.get(Path(executable).name.lower(), "系统默认浏览器") if executable else "系统默认浏览器"
