"""Build a private article archive from bodies obtained by the WeRead session."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
import zipfile

from bs4 import BeautifulSoup
from markdownify import markdownify
import requests

CHINA = timezone(timedelta(hours=8))
IMAGE_HOSTS = {"mmbiz.qpic.cn", "mmecoa.qpic.cn", "mmbiz.qlogo.cn", "res.wx.qq.com", "res.weread.qq.com"}
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif"}


def read_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def write_json(file, value):
    Path(file).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_image_url(url):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == "https" and parsed.hostname in IMAGE_HOSTS
                and not parsed.username and not parsed.password and parsed.port in (None, 443))
    except ValueError:
        return False


def clean_body(content, rejected_images=None):
    soup = BeautifulSoup(content, "html.parser")
    for node in soup.select("script,style,noscript,iframe,object,embed,form,base,meta,link"):
        node.decompose()
    for node in soup.find_all(True):
        for attr in list(node.attrs):
            if attr.lower().startswith("on") or attr in ("srcdoc", "srcset", "poster"):
                del node[attr]
        if node.name == "img":
            source = node.get("data-src") or node.get("src") or ""
            supported = safe_image_url(source)
            node["src"] = source if supported else ""
            if not supported and rejected_images is not None:
                rejected_images.append({"type": "image", "source_url": source, "message": "图片地址为空或不属于受支持的微信图片服务"})
            node.attrs.pop("data-src", None)
            node.attrs.pop("loading", None)
        elif node.has_attr("src"):
            del node["src"]
        if node.has_attr("href"):
            try:
                if urlsplit(node["href"]).scheme not in ("http", "https", "mailto"):
                    del node["href"]
            except ValueError:
                del node["href"]
    return soup


def download_image(url, cache_dir):
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()
    if not safe_image_url(url):
        return {"source_url": url, "path": None, "error": "图片地址不属于受支持的微信图片服务"}
    for suffix in IMAGE_TYPES.values():
        existing = cache_dir / (key + suffix)
        if existing.is_file() and existing.stat().st_size:
            return {"source_url": url, "path": "assets/" + existing.name}
    try:
        with requests.get(url, timeout=(5, 20), stream=True, allow_redirects=False) as response:
            response.raise_for_status()
            if response.is_redirect:
                raise ValueError("图片服务返回重定向")
            suffix = IMAGE_TYPES.get(response.headers.get("Content-Type", "").split(";")[0].strip().lower())
            if not suffix:
                raise ValueError("图片服务未返回受支持的图片格式")
            target = cache_dir / (key + suffix)
            temporary = target.with_suffix(target.suffix + ".tmp")
            try:
                total = 0
                with temporary.open("wb") as stream:
                    for chunk in response.iter_content(64 * 1024):
                        total += len(chunk)
                        if total > 20 * 1024 * 1024:
                            raise ValueError("单张图片超过 20 MB")
                        stream.write(chunk)
                if total == 0:
                    raise ValueError("图片为空")
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
            return {"source_url": url, "path": "assets/" + target.name}
    except (requests.RequestException, OSError, ValueError) as error:
        return {"source_url": url, "path": None, "error": str(error).split("\n")[0][:180]}


def convert_markdown(soup, assets, prefix="", text_only=False):
    document = BeautifulSoup(str(soup), "html.parser")
    for image in document.find_all("img"):
        if text_only:
            image.decompose()
            continue
        entry = assets.get(image.get("src", ""))
        if entry and entry["path"]:
            image["src"] = prefix + entry["path"]
    return re.sub(r"\n{3,}", "\n\n", markdownify(str(document), heading_style="ATX")).strip()


def pack(manifest_file, image_fetch=download_image, *, cancel_file=None, on_progress=None):
    manifest_file = Path(manifest_file).resolve()
    report = read_json(manifest_file)
    output = manifest_file.parent / "package"
    output.mkdir(exist_ok=True)
    (output / "articles").mkdir(exist_ok=True)
    (output / "assets").mkdir(exist_ok=True)
    issues = list(report.get("index_issues", []))
    documents = []
    image_articles = {}
    for article in report["articles"]:
        body = None
        body_error = ""
        if article["status"] == "complete":
            try:
                body = read_json(article["body_file"])
                if not body.get("ok") or body.get("rid") != article["id"] or body.get("originalUrl") != article["source_url"]:
                    raise ValueError("正文缓存与文章不匹配")
            except (OSError, ValueError) as error:
                body_error = str(error)
                body = None
        if body is None:
            issues.append({"type": "body", "id": article["id"], "message": body_error or article.get("error") or report.get("stop_reason") or "正文尚未下载"})
        rejected = []
        soup = clean_body(body["html"], rejected) if body else BeautifulSoup("", "html.parser")
        issues.extend({**issue, "id": article["id"]} for issue in rejected)
        for image in soup.find_all("img"):
            url = image.get("src", "")
            if url:
                image_articles.setdefault(url, set()).add(article["id"])
        documents.append((article, body, soup))
    assets = {}
    notify = on_progress or (lambda message, completed=0, total=0: print(message, flush=True))
    notify(f"正文整理完成，正在保存 {len(image_articles)} 张去重配图。", 0, len(image_articles))
    def fetch_one(url):
        if cancel_file and Path(cancel_file).exists():
            return {"source_url": url, "path": None, "error": "已停止配图下载"}
        return image_fetch(url, output / "assets")
    with ThreadPoolExecutor(max_workers=3) as executor:
        pending = {executor.submit(fetch_one, url): url for url in image_articles}
        for future in as_completed(pending):
            url = pending[future]
            entry = future.result()
            entry["article_ids"] = sorted(image_articles[url])
            assets[url] = entry
            if not entry["path"]:
                issues.append({"type": "image", "source_url": url, "message": entry.get("error", "图片下载失败")})
            if len(assets) % 25 == 0 or len(assets) == len(image_articles):
                notify(f"配图进度：{len(assets)}/{len(image_articles)}", len(assets), len(image_articles))
    merged = [f"# 推文资料：{report['start_date']} 至 {report['end_date']}\n\n北京时间，包含起止两天。\n"]
    text_merged = list(merged)
    index = []
    exported_files = {"manifest.json", "index.json", "asset-index.json", "all-articles.md", "all-text.md", "README.md"}
    for number, (article, body, soup) in enumerate(documents, 1):
        base = f"articles/{number:04d}-{hashlib.sha256(article['id'].encode()).hexdigest()[:12]}"
        stamp = datetime.fromtimestamp(article["publish_time"], CHINA).isoformat(timespec="seconds")
        metadata = f"# {article['title']}\n\n- 公众号：{article['account_name']}\n- 发布时间：{stamp}\n- 原文：{article['source_url']}\n\n"
        message = "> 正文尚未取得，详见 manifest.json。\n"
        article_md = convert_markdown(soup, assets, "../") if body else message
        (output / (base + ".md")).write_text(metadata + article_md + "\n", encoding="utf-8")
        merged.append(metadata + (convert_markdown(soup, assets) if body else message) + "\n\n---\n")
        text_merged.append(metadata + (convert_markdown(soup, assets, text_only=True) if body else message) + "\n\n---\n")
        for image in soup.find_all("img"):
            entry = assets.get(image.get("src", ""))
            if entry and entry["path"]:
                image["src"] = "../" + entry["path"]
        image_origins = " ".join("https://" + host for host in sorted(IMAGE_HOSTS))
        csp = f"default-src 'none'; img-src 'self' {image_origins}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
        page = (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{html.escape(csp, quote=True)}">'
                f'<title>{html.escape(article["title"])}</title><style>body{{max-width:760px;margin:32px auto;padding:0 20px;line-height:1.8}}img{{max-width:100%;height:auto}}</style></head><body>'
                f'<h1>{html.escape(article["title"])}</h1><p>{html.escape(article["account_name"])} · {stamp}</p>'
                f'<p><a href="{html.escape(article["source_url"], quote=True)}">原文链接</a></p>{soup if body else "<p>正文缺失。</p>"}</body></html>')
        (output / (base + ".html")).write_text(page, encoding="utf-8")
        exported_files.update({base + ".md", base + ".html"})
        index.append({**{key: article[key] for key in ("id", "account_id", "account_name", "title", "publish_time", "source_url")}, "body_present": body is not None, "body_source": "weread", "characters": len(body["text"]) if body else 0, "markdown": base + ".md", "html": base + ".html"})
    manifest = {"schema": "opslion-rss/archive-v1", "created_at": datetime.now(CHINA).isoformat(), "start_date": report["start_date"], "end_date": report["end_date"], "timezone": "Asia/Shanghai", "scope": "all_indexed_accounts", "article_count": len(index), "body_count": sum(row["body_present"] for row in index), "image_count": sum(bool(row["path"]) for row in assets.values()), "archive_complete": not issues, "collection_coverage_confirmed": False, "coverage_note": "包含所选目录中该日期范围内的文章。正文通过已登录的微信读书会话取得；微信读书是否漏收或延迟收录仍需对照公众号核验。", "directory_coverage": report["coverage"], "issues": issues}
    write_json(output / "manifest.json", manifest)
    write_json(output / "index.json", index)
    write_json(output / "asset-index.json", sorted(assets.values(), key=lambda row: row["source_url"]))
    (output / "all-articles.md").write_text("\n".join(merged), encoding="utf-8")
    (output / "all-text.md").write_text("\n".join(text_merged), encoding="utf-8")
    (output / "README.md").write_text(
        f"# 推文正文资料包\n\n日期：{report['start_date']} 至 {report['end_date']}，北京时间。\n\n"
        "- all-text.md：全部文章的文字正文汇总，可交给生成文案的 Skill。\n"
        "- all-articles.md：包含配图引用的正文汇总。\n- articles/：逐篇 Markdown 和 HTML。\n"
        "- assets/ 与 asset-index.json：配图文件、原始图片地址与文章对应关系。\n"
        "- index.json 与 manifest.json：文章索引、覆盖说明与缺失项。\n\n"
        + manifest["coverage_note"] + f"\n\n已取得正文 {manifest['body_count']}/{len(index)} 篇，配图 {manifest['image_count']} 张，缺失或待核对项 {len(issues)}。\n",
        encoding="utf-8")
    exported_files.update(row["path"] for row in assets.values() if row["path"])
    suffix = "_含缺失项" if issues else ""
    archive = manifest_file.parent / f"推文资料_{report['start_date']}_{report['end_date']}{suffix}.zip"
    temporary = archive.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=5) as zipped:
        for relative in sorted(exported_files):
            zipped.write(output / relative, relative)
    temporary.replace(archive)
    notify(f"正文 {manifest['body_count']}/{len(index)} 篇，配图 {manifest['image_count']} 张。", len(index), len(index))
    if on_progress is None:
        print(f"ZIP：{archive}\n纯文字：{output / 'all-text.md'}", flush=True)
    return manifest, archive


if __name__ == "__main__":
    arguments = argparse.ArgumentParser()
    arguments.add_argument("manifest")
    arguments.add_argument("--json-progress", action="store_true")
    arguments.add_argument("--cancel-file")
    options = arguments.parse_args()
    def report_progress(message, completed=0, total=0):
        print(json.dumps({"event": "progress", "stage": "images", "message": message, "completed": completed, "total": total}, ensure_ascii=False), flush=True)
    result, _ = pack(options.manifest, cancel_file=options.cancel_file, on_progress=report_progress if options.json_progress else None)
    if options.json_progress:
        print(json.dumps({"event": "result", "manifest": result}, ensure_ascii=False), flush=True)
    sys.exit(0 if result["archive_complete"] else 1)
