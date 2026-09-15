"""OpsLion workflow facade over upstream models, collectors, content and queue.

No WeChat login flow, article parser, scraper or parallel article store lives here.
The native we-mp-rss UI/API remains the authority for subscriptions and settings.
"""
from __future__ import annotations

import copy
from datetime import date, datetime, time as day_time, timedelta, timezone
import json
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit
import uuid

PROTOCOL = "opslion-rss/v1"
CHINA = timezone(timedelta(hours=8))


def now():
    return datetime.now(CHINA).isoformat(timespec="seconds")


def date_range(payload):
    try:
        end = date.fromisoformat(payload.get("end_date") or datetime.now(CHINA).date().isoformat())
        start = date.fromisoformat(payload.get("start_date") or (end - timedelta(days=int(payload.get("days", 30)) - 1)).isoformat())
        if start > end:
            raise ValueError()
        for field, value in (("start_date", start), ("end_date", end)):
            if payload.get(field) and payload[field] != value.isoformat():
                raise ValueError()
        return start.isoformat(), end.isoformat(), int(datetime.combine(start, day_time(), CHINA).timestamp()), int(datetime.combine(end + timedelta(days=1), day_time(), CHINA).timestamp())
    except (TypeError, ValueError, OverflowError):
        raise ValueError("日期须为 YYYY-MM-DD，且开始日期不能晚于结束日期") from None


class CollectionFailure(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


class Cancelled(Exception):
    pass


class PageObservation:
    """Observe the original Requests session; never parse or save articles.

    Older upstream collectors swallow errors, so a returned function alone is
    not proof of success. Only a valid list response establishes page coverage.
    """
    def __init__(self, *, stop_native_rate_retries=False):
        self.valid = False
        self.empty = False
        self.code = None
        self.stop_native_rate_retries = stop_native_rate_retries

    def __call__(self, response, *args, **kwargs):
        url = urlsplit(response.url)
        if url.hostname != "mp.weixin.qq.com" or url.path not in ("/cgi-bin/appmsgpublish", "/cgi-bin/appmsg"):
            return
        try:
            body = response.json()
            self.code = body["base_resp"]["ret"]
            if self.code == 200013 and self.stop_native_rate_retries:
                # The workflow owns its cancellable 60/120-second backoff.
                # Upstream 1.5.3 also retries internally; nesting both makes
                # nine requests and prevents cancellation during native waits.
                self.verify()
            if self.code != 0:
                return
            if "publish_page" in body:
                page = body["publish_page"]
                if isinstance(page, str):
                    page = json.loads(page)
                entries = page["publish_list"]
            else:
                entries = body["app_msg_list"]
            self.valid = isinstance(entries, list)
            self.empty = self.valid and not entries
        except (KeyError, TypeError, ValueError):
            self.valid = False

    def verify(self):
        if self.code == 200013:
            raise CollectionFailure("微信返回 200013：请求频率受限", 200013)
        if self.code == 200003:
            raise CollectionFailure("微信授权已失效，请在完整 RSS 中重新扫码", 200003)
        if self.code not in (None, 0):
            raise CollectionFailure(f"微信采集接口返回错误 {self.code}", self.code)
        if not self.valid:
            raise CollectionFailure("原版 RSS 未取得有效文章页，无法确认日期范围完整")


def run_upstream_page(engine, feed, page, callback, interval):
    observer = PageObservation(stop_native_rate_retries=True)
    hooks = engine.session.hooks.setdefault("response", [])
    hooks.append(observer)
    try:
        engine.get_Articles(
            faker_id=feed["faker_id"], Mps_id=feed["id"], Mps_title=feed["mp_name"],
            CallBack=callback, start_page=page, MaxPage=page + 1, interval=interval,
        )
    except Exception:
        # Preserve the useful WeChat error instead of an upstream wrapper error.
        observer.verify()
        raise
    finally:
        hooks.remove(observer)
    observer.verify()
    return observer.empty


class UpstreamAdapter:
    def __init__(self, runtime: Path):
        self.runtime = runtime
        self.state_path = runtime / "opslion-refresh.json"
        self.lock = threading.RLock()
        self.cancelled = threading.Event()
        self.state = json.loads(self.state_path.read_text(encoding="utf-8")) if self.state_path.exists() else {"running": False, "return_code": None, "log_tail": ""}
        if self.state.get("running"):
            self.update(running=False, return_code=1, outcome="interrupted", finished_at=now(), message="RSS 服务重启，上一采集任务已中断，请重新采集或导出已有推文")

    def update(self, **changes):
        with self.lock:
            self.state.update(changes)
            temporary = self.state_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(self.state_path)

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    def feeds(self):
        from core.db import DB
        from core.models.feed import Feed, FEATURED_MP_ID
        from core.models.article import Article
        from core.models.base import DATA_STATUS
        from sqlalchemy import func, case
        with DB.get_session() as session:
            stats = {
                row[0]: row[1:] for row in session.query(
                    Article.mp_id, func.count(Article.id),
                    func.sum(case((Article.url != "", 1), else_=0)),
                    func.sum(case((func.length(Article.content) > 0, 1), else_=0)),
                    func.max(Article.publish_time),
                ).filter(Article.status != DATA_STATUS.DELETED).group_by(Article.mp_id).all()
            }
            return [{
                "id": feed.id, "mp_name": feed.mp_name or "未命名公众号", "status": feed.status,
                "faker_id": feed.faker_id, "update_time": feed.update_time or 0,
                "sync_time": feed.sync_time or 0,
                "article_count": stats.get(feed.id, (0, 0, 0, 0))[0] or 0,
                "url_count": stats.get(feed.id, (0, 0, 0, 0))[1] or 0,
                "content_count": stats.get(feed.id, (0, 0, 0, 0))[2] or 0,
                "newest_publish_time": stats.get(feed.id, (0, 0, 0, 0))[3] or 0,
            } for feed in session.query(Feed).filter(Feed.id != FEATURED_MP_ID).order_by(Feed.mp_name).all()]

    def auth(self):
        from driver.token import _get_token_data, wx_cfg
        from driver.success import getStatus
        wx_cfg.reload()
        data = _get_token_data() or {}
        expiry = data.get("expiry") or {}
        stamp = expiry.get("expiry_timestamp") if isinstance(expiry, dict) else None
        if not data.get("token"):
            return {"state": "logged_out", "authenticated": False, "message": "请打开完整 RSS，扫码授权公众号"}
        if stamp and float(stamp) <= time.time():
            return {"state": "expired", "authenticated": False, "message": "微信授权已过期，请打开完整 RSS 重新扫码"}
        return {"state": "authorized" if getStatus() else "unverified", "authenticated": bool(getStatus()), "expires_at": stamp,
                "message": "沿用完整 RSS 的微信授权；授权和订阅在完整 RSS 中管理"}

    def status(self):
        from core.config import cfg
        from core.ver import VERSION
        feeds = self.feeds()
        return {"protocol": PROTOCOL, "available": True, "engine": "we-mp-rss", "engine_version": VERSION,
                "management_mode": "native", "management_version": 0,
                "gather_mode": cfg.get("gather.model", "web"), "auth": self.auth(), "feeds": feeds,
                "totals": {**{key: sum(feed[key] for feed in feeds) for key in ("article_count", "url_count", "content_count")},
                           "last_sync_time": max((feed["sync_time"] for feed in feeds), default=0)},
                "refresh": self.snapshot(), "legacy": {"available": False, "weeks": []},
                "message": "已连接完整 we-mp-rss，共用原版订阅、文章、授权及采集队列"}

    def _query(self, session, payload):
        from core.models.article import Article
        from core.models.base import DATA_STATUS
        _, _, lower, upper = date_range(payload)
        query = session.query(Article).filter(Article.status != DATA_STATUS.DELETED, Article.publish_time >= lower, Article.publish_time < upper)
        if payload.get("mp_id"):
            query = query.filter(Article.mp_id == payload["mp_id"])
        return query

    def _article(self, item, account_name, body=False):
        from bs4 import BeautifulSoup
        content = item.content or ""
        result = {"id": item.id, "mp_id": item.mp_id, "account_name": account_name, "title": item.title or "", "source_url": item.url or "",
                  "publish_time": item.publish_time or 0, "description": item.description or "", "pic_url": item.pic_url or "",
                  "has_content": int(bool(content.strip())), "content_preview": BeautifulSoup(content[:16000], "html.parser").get_text(" ", strip=True)[:360]}
        if body:
            result["content"] = content
        return result

    def articles(self, payload):
        from core.db import DB
        from core.models.article import Article
        from core.models.feed import Feed
        try:
            offset = int(payload.get("offset", 0))
            limit = int(payload.get("limit", 100))
            if offset < 0 or not 1 <= limit <= 500:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError("offset 须为非负整数，limit 须为 1 至 500") from None
        with DB.get_session() as session:
            query = self._query(session, payload)
            total = query.count()
            names = dict(session.query(Feed.id, Feed.mp_name).all())
            rows = query.order_by(Article.publish_time.desc(), Article.id).offset(offset).limit(limit).all()
            items = [self._article(row, names.get(row.mp_id, "")) for row in rows]
            return {"articles": items, "count": len(items), "total": total, "next_offset": offset + len(items) if offset + len(items) < total else None}

    def article(self, payload):
        from core.db import DB
        from core.models.article import Article
        from core.models.feed import Feed
        from core.models.base import DATA_STATUS
        from core.article_content import sync_article_content
        with DB.get_session() as session:
            item = session.query(Article).filter(Article.id == str(payload.get("id", "")), Article.status != DATA_STATUS.DELETED).first()
            if not item:
                return {"article": None}
            if payload.get("ensure_content") and not (item.content or "").strip():
                sync_article_content(session, item)
            if item.status == DATA_STATUS.DELETED:
                return {"article": None}
            feed = session.get(Feed, item.mp_id)
            return {"article": self._article(item, feed.mp_name if feed else "", body=True)}

    def refresh(self, payload):
        from core.queue import TaskQueue
        if not payload.get("start_date") or not payload.get("end_date"):
            raise ValueError("采集须指定开始日期和结束日期")
        start, end, _, _ = date_range(payload)
        with self.lock:
            if self.state.get("running"):
                raise ValueError("已有采集任务正在执行，请等待完成或停止后重试")
            if float(self.state.get("retry_after") or 0) > time.time():
                raise ValueError("微信限流冷却尚未结束，请稍后再采集")
            selected = payload.get("mp_ids", [])
            if not isinstance(selected, list) or any(not isinstance(value, str) for value in selected):
                raise ValueError("mp_ids 必须是公众号编号数组")
            enabled = [feed for feed in self.feeds() if feed["status"] == 1]
            if set(selected) - {feed["id"] for feed in enabled}:
                raise ValueError("所选公众号不存在或已停用，请刷新订阅")
            feeds = [feed for feed in enabled if not selected or feed["id"] in selected]
            if not feeds:
                raise ValueError("没有启用的公众号，请打开完整 RSS 添加订阅")
            if self.auth()["state"] in ("logged_out", "expired"):
                raise ValueError("微信尚未授权或授权已过期，请打开完整 RSS 扫码")
            self.cancelled.clear()
            self.state = {}
            job_id = uuid.uuid4().hex
            self.update(job_id=job_id, running=True, return_code=None, outcome="queued", started_at=now(),
                        start_date=start, end_date=end, mp_ids=[feed["id"] for feed in feeds], feed_total=len(feeds), feed_completed=0,
                        current_pages=0, current_matched=0, results=[], log_tail="", message="已加入原版 RSS 采集队列")
            try:
                accepted = TaskQueue.add_task(self.run_job, job_id, feeds, max_retries=0, task_name=f"OpsLion 周报 {start}—{end} {job_id[:6]}")
                if not accepted:
                    raise ValueError("原版 RSS 队列未接受任务，请稍后重试")
            except Exception:
                self.update(running=False, return_code=1, outcome="failed", message="加入原版 RSS 队列失败")
                raise
            return self.snapshot()

    def cancel(self, payload):
        with self.lock:
            if payload.get("job_id") and payload["job_id"] != self.state.get("job_id"):
                raise ValueError("采集任务已变化，请重新读取任务状态")
            if self.state.get("running"):
                self.cancelled.set()
                if self.state.get("outcome") == "queued":
                    self.update(running=False, return_code=1, outcome="cancelled", finished_at=now(), message="已取消排队中的采集任务", cancel_requested=True)
                else:
                    self.update(message="正在停止，当前原版采集调用结束后退出", cancel_requested=True)
            return self.snapshot()

    def check_cancel(self):
        if self.cancelled.is_set():
            raise Cancelled()

    def collect_feed(self, feed, lower, upper):
        from core.config import cfg
        from core.wx import WxGather
        from jobs.article import UpdateArticle
        engine = WxGather().Model()  # Original web / app / api implementation.
        interval = int(cfg.get("interval", 10))
        matched = set()
        previous = None
        max_pages = int(cfg.get("opslion.max_pages", 1000))
        page = 0
        try:
            for page in range(max_pages):
                rows = []
                self.check_cancel()
                self.update(current_feed=feed["mp_name"], current_pages=page, current_matched=len(matched), outcome="running",
                            message=f"{feed['mp_name']} · 原版 {cfg.get('gather.model', 'web')} 模式 · 第 {page + 1} 页")

                def save(article):
                    self.check_cancel()
                    stamp = int(article.get("publish_time") or article.get("create_time") or 0)
                    if not stamp:
                        raise CollectionFailure("原版 RSS 返回的文章缺少发布时间，无法确认日期范围")
                    rows.append((str(article["id"]), stamp))
                    if lower <= stamp < upper:
                        matched.add(str(article["id"]))
                    added = UpdateArticle(article)  # Original normalization and database write.
                    if lower <= stamp < upper:
                        from core.db import DB
                        from core.models.article import Article
                        expected_id = f"{feed['id']}-{article['id']}".replace("MP_WXS_", "")
                        with DB.get_session() as session:
                            stored = session.query(Article.id).filter((Article.id == expected_id) | (Article.url == article["url"])).first()
                        if stored is None:
                            raise CollectionFailure("原版 RSS 未能保存文章，无法确认本次采集完整")
                    return added

                for attempt in range(3):
                    try:
                        empty = run_upstream_page(engine, feed, page, save, interval)
                        break
                    except CollectionFailure as error:
                        if error.code != 200013 or attempt == 2:
                            raise
                        delay = 60 * (attempt + 1)
                        self.update(outcome="cooldown", message=f"微信限流，等待 {delay} 秒后重试当前页（{attempt + 1}/2）", retry_at=time.time() + delay)
                        if self.cancelled.wait(delay):
                            raise Cancelled()
                self.check_cancel()
                self.update(current_pages=page + 1, current_matched=len(matched), retry_at=None)
                if empty:
                    return {"id": feed["id"], "name": feed["mp_name"], "status": "complete", "pages": page + 1, "matched": len(matched), "coverage": "end_of_history"}
                if not rows:
                    raise CollectionFailure("原版 RSS 没有解析出文章，无法确认本页完整")
                signature = tuple(row[0] for row in rows)
                if signature == previous:
                    raise CollectionFailure("原版 RSS 返回重复文章页，已停止以免遗漏或重复采集")
                previous = signature
                if max(row[1] for row in rows) < lower:
                    return {"id": feed["id"], "name": feed["mp_name"], "status": "complete", "pages": page + 1, "matched": len(matched), "coverage": "before_start_date"}
            raise CollectionFailure(f"已达到 {max_pages} 页，尚未覆盖开始日期，请在完整 RSS 检查历史采集范围")
        finally:
            engine.session.close()

    def run_job(self, job_id, feeds):
        if job_id != self.state.get("job_id") or not self.state.get("running"):
            return
        results = []
        outcome = "partial"
        message = "采集未完整完成，请检查各公众号结果"
        try:
            _, _, lower, upper = date_range(self.state)
            for feed in feeds:
                self.check_cancel()
                try:
                    result = self.collect_feed(feed, lower, upper)
                    # Body completion uses the exact upstream web/API fallback.
                    from core.db import DB
                    from core.models.article import Article
                    with DB.get_session() as session:
                        ids = [row[0] for row in self._query(session, {**self.state, "mp_id": feed["id"]}).with_entities(Article.id).all()]
                    failures = []
                    for index, article_id in enumerate(ids):
                        self.check_cancel()
                        self.update(message=f"{feed['mp_name']} · 原版正文补全 · {index + 1}/{len(ids)}")
                        try:
                            item = self.article({"id": article_id, "ensure_content": True})["article"]
                            if not item or not item.get("content", "").strip():
                                failures.append({"id": article_id, "message": "原版 RSS 未取得完整正文"})
                        except Exception:
                            failures.append({"id": article_id, "message": "原版 RSS 正文补全失败"})
                    if failures:
                        result.update(status="partial", body_failures=failures, message="部分文章正文尚未取得")
                except CollectionFailure as error:
                    result = {"id": feed["id"], "name": feed["mp_name"], "status": "failed", "code": error.code, "message": str(error)}
                    results.append(result)
                    self.update(results=results, feed_completed=len(results))
                    if error.code in (200013, 200003):
                        if error.code == 200013:
                            self.update(retry_after=time.time() + 120)
                        message = str(error)
                        break
                    continue
                results.append(result)
                self.update(results=results, feed_completed=len(results))
            if len(results) == len(feeds) and all(result["status"] == "complete" for result in results):
                outcome = "complete"
                message = "原版 RSS 已完成所选日期范围采集和正文补全"
        except Cancelled:
            outcome, message = "cancelled", "已停止采集，已取得的文章保留在完整 RSS 中"
        except Exception as error:
            message = f"原版 RSS 执行异常（{type(error).__name__}），请在完整 RSS 管理界面检查"
        finally:
            self.update(running=False, return_code=0 if outcome == "complete" else 1, outcome=outcome, finished_at=now(),
                        results=results, feed_completed=len(results), message=message, log_tail=message, retry_at=None)
        if outcome not in ("complete", "cancelled"):
            # Native task history must not record partial collection as success.
            raise RuntimeError(message)

    def call(self, operation, payload):
        if operation == "health":
            return {"protocol": PROTOCOL, "engine": "we-mp-rss"}
        if operation == "status":
            return self.status()
        if operation == "articles":
            return self.articles(payload)
        if operation == "article":
            return self.article(payload)
        if operation == "refresh":
            return self.refresh(payload)
        if operation == "refresh_status":
            return self.snapshot()
        if operation == "cancel":
            return self.cancel(payload)
        if operation == "legacy_weeks":
            return {"available": False, "weeks": []}
        if operation == "legacy_week":
            return {}
        if operation == "management":
            return {"management_mode": "native", "message": "公众号管理、扫码授权、任务和设置均在完整 RSS 管理界面中"}
        raise ValueError("请在完整 RSS 管理界面中完成此操作")
