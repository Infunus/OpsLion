"""Apply reviewed upstream fixes and rebuild the complete Vue UI."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


PATCH = Path(__file__).resolve().parent.parent / 'integrations/we-mp-rss/manual-refresh.patch'
PATCHES = (PATCH, PATCH.with_name('wechat-authorization.patch'))


def apply_patch(source: Path, patch: Path = PATCH, *, check_only=False):
    source = source.resolve()
    if not (source / 'apis/mps.py').is_file() or not (source / 'web_ui/package.json').is_file():
        raise ValueError('请指定完整 we-mp-rss 源码目录')
    environment = os.environ.copy()
    # An archive nested inside OpsLion must not inherit its parent's Git root.
    environment['GIT_CEILING_DIRECTORIES'] = str(source.parent)
    content = patch.read_bytes()

    def git_apply(*args):
        return subprocess.run(['git', 'apply', '--ignore-space-change', *args, '-'], input=content,
                              cwd=source, env=environment, capture_output=True)

    if git_apply('--reverse', '--check').returncode == 0:
        return False
    check = git_apply('--check')
    if check.returncode:
        raise ValueError(f'RSS 源码与 {patch.name} 补丁不兼容，未改动文件；请使用 docs/rss-integration.md 指定的上游版本')
    if check_only:
        return True
    result = git_apply()
    if result.returncode:
        raise RuntimeError('RSS 补丁应用失败，请检查源码目录的写入权限')
    return True


def apply_patches(source: Path, patches=PATCHES):
    # These patches touch separate files. Check every patch before changing any.
    pending = [patch for patch in patches if apply_patch(source, patch, check_only=True)]
    for patch in pending:
        apply_patch(source, patch)
    return bool(pending)


def build_frontend(source: Path):
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not npm:
        raise ValueError('重建原版 RSS 前端需要 Node.js 与 npm，请安装后重新运行接入脚本')
    frontend = source / 'web_ui'
    environment = {**os.environ, 'VITE_API_BASE_URL': '/', 'VITE_DEBUG_MODE': 'false'}

    def run(*arguments):
        command = [npm, *arguments]
        if os.name == 'nt':
            command = [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', *command]
        subprocess.run(command, cwd=frontend, env=environment, check=True)

    # The upstream lockfile fixes dependency versions for this supported snapshot.
    run('ci', '--no-fund', '--no-audit')
    run('run', 'build')
    if not (frontend / 'dist/index.html').is_file():
        raise RuntimeError('原版 RSS 前端构建未产生入口文件')
    # Keep older bundles available to already-open pages during the upgrade.
    shutil.copytree(frontend / 'dist', source / 'static', dirs_exist_ok=True)
    marker = source / 'OPSLION-UPSTREAM.json'
    metadata = json.loads(marker.read_text(encoding='utf-8-sig')) if marker.exists() else {}
    metadata.setdefault('repository', 'https://github.com/rachelos/we-mp-rss')
    metadata['source'] = 'complete upstream with reviewed refresh progress and WeChat authorization fixes'
    metadata['patches'] = {patch.name: hashlib.sha256(patch.read_bytes()).hexdigest() for patch in PATCHES}
    marker.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    changed = apply_patches(source)
    print('RSS 采集进度与微信授权补丁已应用。' if changed else 'RSS 采集进度与微信授权补丁已存在。', flush=True)
    build_frontend(source)
    print('完整 RSS 前端已重建；服务重启后生效。')


if __name__ == '__main__':
    main()
