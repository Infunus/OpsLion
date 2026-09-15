"""Exercise the real upstream engine against synthetic HTTP and a temporary DB.

Run with the RSS venv. In a public checkout set OPSLION_TEST_WERSS_SOURCE to the
upstream source directory. Never read a user's config, cookies or article DB.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import AsyncMock, MagicMock, patch

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get("OPSLION_TEST_WERSS_SOURCE") or PROJECT / "we-mp-rss")
READY = (SOURCE / "core/wx/base.py").is_file() and all(importlib.util.find_spec(name) for name in ("yaml", "sqlalchemy", "playwright"))


@unittest.skipUnless(READY, "Run with the complete RSS venv and upstream source")
class NativeEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import requests
        import yaml
        cls.old_cwd, cls.old_argv = Path.cwd(), sys.argv[:]
        cls.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls.folder = Path(cls.temp.name)
        (cls.folder / "data").mkdir()
        (cls.folder / "data/wx.lic").write_text(yaml.safe_dump({"token_data": {"token": "synthetic", "cookie": "synthetic=only", "expiry": {"expiry_timestamp": 4102444800}}}))
        (cls.folder / "config.yaml").write_text(yaml.safe_dump({
            "db": "sqlite:///./data/test.db", "secret": "synthetic-testing-only", "debug": False,
            "redis": {"url": "", "server": {"enabled": False}},
            "gather": {"model": "web", "content": False, "content_auto_check": False},
            "server": {"enable_job": False}, "interval": 0, "opslion": {"max_pages": 5},
        }))
        os.chdir(cls.folder)
        sys.path.insert(0, str(SOURCE))
        sys.path.insert(0, str(PROJECT / "scripts"))
        sys.argv = [__file__, "-config", str(cls.folder / "config.yaml")]
        sys.dont_write_bytecode = True
        # The upstream import checks its latest release. Keep tests offline.
        response = requests.Response()
        response.status_code, response._content = 200, b'{"tag_name":"synthetic"}'
        with patch("requests.get", return_value=response), contextlib.redirect_stdout(io.StringIO()):
            from core.db import DB
            from core.models.feed import Feed
            from core.models.article import Article
            from core.config import cfg
            from we_mp_rss_adapter import UpstreamAdapter, date_range
            from we_mp_rss_manual import configure_manual_refresh
            configure_manual_refresh()
            DB.create_tables()
        cls.DB, cls.Feed, cls.Article, cls.cfg = DB, Feed, Article, cfg
        cls.Adapter, cls.range = UpstreamAdapter, staticmethod(date_range)

    @classmethod
    def tearDownClass(cls):
        cls.DB.engine.dispose()
        os.chdir(cls.old_cwd)
        sys.argv = cls.old_argv
        cls.temp.cleanup()

    def setUp(self):
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)
        with self.DB.get_session() as session:
            session.query(self.Article).delete()
            session.query(self.Feed).delete()
            session.add(self.Feed(id="MP_WXS_TEST", mp_name="合成订阅", faker_id="synthetic", status=1, update_time=0, sync_time=0))
            session.commit()
        self.cfg.config["gather"]["model"] = "web"
        self.cfg.save_config()
        self.feed = {"id": "MP_WXS_TEST", "faker_id": "synthetic", "mp_name": "合成订阅"}
        self.adapter = self.Adapter(self.folder)
        self.pages = []

    def item(self, aid, stamp):
        return {"aid": aid, "title": "合成文章", "link": f"https://mp.weixin.qq.com/s/synthetic-{aid}", "cover": "", "create_time": stamp, "update_time": stamp, "digest": "合成摘要"}

    def test_login_browser_uses_native_headers_and_supports_forced_chromium(self):
        import asyncio
        from driver.playwright_driver import PlaywrightController
        for browser_type in ('chromium', 'msedge'):
            with self.subTest(browser=browser_type):
                page, context, browser, playwright = MagicMock(), MagicMock(), MagicMock(), MagicMock()
                context.new_page = AsyncMock(return_value=page)
                browser.new_context = AsyncMock(return_value=context)
                playwright.chromium.launch = AsyncMock(return_value=browser)
                manager = MagicMock()
                manager.start = AsyncMock(return_value=playwright)
                with patch.dict(os.environ, {'BROWSER_TYPE': browser_type}), patch('playwright.async_api.async_playwright', return_value=manager):
                    controller = PlaywrightController(apply_anti_crawler=False, proxy_url='http://127.0.0.1:12345')
                    asyncio.run(controller.start_browser())
                options = browser.new_context.call_args.kwargs
                self.assertNotIn('extra_http_headers', options)
                self.assertNotIn('user_agent', options)
                self.assertNotIn('bypass_csp', options)
                page.add_init_script.assert_not_called()
                launch = playwright.chromium.launch.call_args.kwargs
                self.assertEqual(launch['proxy']['server'], 'http://127.0.0.1:12345')
                self.assertFalse(any('AutomationControlled' in arg for arg in launch['args']))
                if browser_type == 'msedge':
                    self.assertEqual(launch['channel'], 'msedge')

    def test_qr_duplicate_start_reuses_loading_task_before_image_exists(self):
        import asyncio
        from driver.wx import Wx
        wx = Wx()
        self.addCleanup(wx.release_lock)
        thread = MagicMock()
        thread.is_alive.return_value = True
        with patch('core.thread.ThreadManager', return_value=thread):
            first, second = wx.GetCode(), wx.GetCode()
        thread.start.assert_called_once()
        self.assertEqual(first['state'], 'loading')
        self.assertEqual(second['state'], 'loading')
        self.assertTrue(first['code'].startswith('/static/'))
        self.assertTrue(second['code'].startswith('/static/'))
        self.assertFalse(wx.GetHasCode())
        self.assertTrue(wx.check_lock())
        with patch.object(wx, 'Close', new_callable=AsyncMock) as close:
            asyncio.run(wx.wxLogin())
            close.assert_not_called()
        self.assertTrue(wx.check_lock())

    def test_qr_browser_failures_report_state_and_release_resources(self):
        import asyncio
        from driver.wx import Wx
        for phase in ('navigation', 'image', 'scan'):
            with self.subTest(phase=phase):
                wx = Wx()
                driver = MagicMock()
                driver.start_browser = AsyncMock()
                driver.open_url = AsyncMock(return_value=phase != 'navigation')
                driver.Close = AsyncMock()
                image = MagicMock()
                async def screenshot(**kwargs):
                    target = Path(kwargs['path'])
                    target.parent.mkdir(exist_ok=True)
                    target.write_bytes(b'synthetic-image' * 100)
                image.screenshot = AsyncMock(side_effect=screenshot)
                driver.page.query_selector = AsyncMock(return_value=image)
                async def expired(*args, **kwargs):
                    self.assertEqual(wx.QrStatus()['state'], 'waiting')
                    self.assertFalse(wx.QrStatus()['login_status'])
                    raise TimeoutError('synthetic-only')
                driver.page.wait_for_url = AsyncMock(side_effect=expired)
                old_proxy = self.cfg.config.get('proxy')
                self.cfg.config['proxy'] = {'enabled': True, 'http_url': 'http://127.0.0.1:12345'}
                try:
                    with patch('driver.wx.PlaywrightController', return_value=driver) as factory, patch.object(wx, '_wait_qrcode_ready', new_callable=AsyncMock, return_value=phase == 'scan'):
                        asyncio.run(wx.wxLogin())
                    self.assertFalse(factory.call_args.kwargs['apply_anti_crawler'])
                    self.assertEqual(factory.call_args.kwargs['proxy_url'], 'http://127.0.0.1:12345')
                finally:
                    if old_proxy is None:
                        self.cfg.config.pop('proxy', None)
                    else:
                        self.cfg.config['proxy'] = old_proxy
                status = wx.QrStatus()
                self.assertEqual(status['state'], 'failed')
                self.assertTrue(status['error'])
                self.assertFalse(status['login_status'])
                self.assertFalse(status['qr_code'])
                self.assertFalse(wx.check_lock())
                driver.Close.assert_awaited_once()

    def test_qr_status_requires_native_login(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from apis.auth import router
        from core.auth import get_current_user
        app = FastAPI()
        app.include_router(router, prefix='/api/v1/wx')
        client = TestClient(app)
        for route in ('code', 'status'):
            self.assertEqual(client.get('/api/v1/wx/auth/qr/' + route).status_code, 401)
        app.dependency_overrides[get_current_user] = lambda: {'username': 'synthetic'}
        response = client.get('/api/v1/wx/auth/qr/status')
        self.assertEqual(response.status_code, 200)
        self.assertIn('state', response.json()['data'])

    def run_feed(self, data):
        import requests
        def send(adapter, request, **kwargs):
            url = urlsplit(request.url)
            if url.hostname != "mp.weixin.qq.com":
                raise AssertionError("Unexpected external request")
            offset = int(parse_qs(url.query)["begin"][0])
            self.pages.append(offset)
            response = requests.Response()
            response.status_code, response.url, response.request = 200, request.url, request
            response._content = json.dumps(data[offset]).encode()
            return response
        _, _, lower, upper = self.range({"start_date": "2026-09-07", "end_date": "2026-09-13"})
        with patch("requests.adapters.HTTPAdapter.send", send), patch("time.sleep"):
            return self.adapter.collect_feed(self.feed, lower, upper)

    def page(self, items):
        return {"base_resp": {"ret": 0}, "publish_page": json.dumps({"publish_list": [{"publish_info": json.dumps({"appmsgex": items})}] if items else []})}

    def test_original_parser_and_database_cover_dates_even_when_articles_already_exist(self):
        _, _, lower, _ = self.range({"start_date": "2026-09-07", "end_date": "2026-09-13"})
        data = {0: self.page([self.item("new", lower + 100), self.item("old-in-mixed-page", lower - 100)]), 5: self.page([self.item("older", lower - 200)])}
        first = self.run_feed(data)
        self.assertEqual(self.pages, [0, 5])
        self.assertEqual(first["status"], "complete")
        self.assertEqual(first["matched"], 1)
        self.pages.clear()
        second = self.run_feed(data)
        self.assertEqual(self.pages, [0, 5])
        self.assertEqual(second["status"], "complete")
        with self.DB.get_session() as session:
            self.assertEqual(session.query(self.Article).count(), 3)
            self.assertIsNotNone(session.get(self.Article, "TEST-new"))
        listed = self.adapter.articles({"start_date": "2026-09-07", "end_date": "2026-09-13", "limit": 1})
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["articles"][0]["id"], "TEST-new")

    def test_original_empty_page_is_valid_and_repeated_page_is_not(self):
        from we_mp_rss_adapter import CollectionFailure
        result = self.run_feed({0: self.page([])})
        self.assertEqual(result["coverage"], "end_of_history")
        _, _, lower, _ = self.range({"start_date": "2026-09-07", "end_date": "2026-09-13"})
        repeated = self.page([self.item("same", lower + 1)])
        with self.assertRaises(CollectionFailure):
            self.run_feed({0: repeated, 5: repeated})

    def test_rate_limit_retries_are_not_multiplied_by_upstream_and_can_cancel(self):
        from we_mp_rss_adapter import CollectionFailure, Cancelled
        from unittest.mock import call
        with patch.object(self.adapter.cancelled, 'wait', return_value=False) as wait:
            with self.assertRaises(CollectionFailure) as caught:
                self.run_feed({0: {'base_resp': {'ret': 200013}}})
            self.assertEqual(caught.exception.code, 200013)
            self.assertEqual(self.pages, [0, 0, 0])
            self.assertEqual(wait.call_args_list, [call(60), call(120)])
        self.pages.clear()
        with patch.object(self.adapter.cancelled, 'wait', return_value=True):
            with self.assertRaises(Cancelled):
                self.run_feed({0: {'base_resp': {'ret': 200013}}})
        self.assertEqual(self.pages, [0])

    def test_native_article_detail_uses_upstream_content_sync(self):
        _, _, lower, _ = self.range({"start_date": "2026-09-07", "end_date": "2026-09-13"})
        self.run_feed({0: self.page([self.item("body", lower + 1)]), 5: self.page([])})
        from core import article_content
        with patch.object(article_content, "fetch_article_content", return_value=("<p>原版正文测试</p>", "web", 0)) as content:
            result = self.adapter.article({"id": "TEST-body", "ensure_content": True})
            self.assertIn("原版正文测试", result["article"]["content"])
            content.assert_called_once()
            self.adapter.article({"id": "TEST-body", "ensure_content": True})
            content.assert_called_once()  # Existing body never gets fetched or overwritten again.

    def manual_task(self, data, start=0, end=1):
        import requests
        from core.manual_refresh import ManualRefreshTasks, RefreshFailure
        calls = []
        queue = []

        def enqueue(function, *args, **kwargs):
            queue.append((function, args, kwargs))
            return True

        path = self.folder / 'manual-test.json'
        path.unlink(missing_ok=True)
        tasks = ManualRefreshTasks(path, enqueue=enqueue)
        task = tasks.submit(self.feed, start, end)
        self.assertEqual(task['status'], 'pending')
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[0][2]['max_retries'], 0)
        with self.assertRaisesRegex(ValueError, '已有采集任务'):
            tasks.submit(self.feed, start, end)

        def send(adapter, request, **kwargs):
            url = urlsplit(request.url)
            self.assertEqual(url.hostname, 'mp.weixin.qq.com')
            offset = int(parse_qs(url.query)['begin'][0])
            calls.append(offset)
            body = data[offset]
            if isinstance(body, Exception):
                raise body
            response = requests.Response()
            response.status_code, response.url, response.request = 200, request.url, request
            response._content = json.dumps(body).encode()
            return response

        with patch('requests.adapters.HTTPAdapter.send', send), patch('time.sleep'):
            try:
                queue[0][0](*queue[0][1])
            except RefreshFailure:
                pass
        result = tasks.get(task['task_id'])
        self.assertEqual(tasks.latest(self.feed['id']), result)
        self.assertEqual(ManualRefreshTasks(path).get(task['task_id']), result)
        return result, calls

    def test_manual_refresh_real_parser_saves_first_page_and_reports_completion(self):
        result, calls = self.manual_task({0: self.page([self.item('manual', 1788710500)])})
        self.assertEqual(calls, [0])
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['start_page'], 1)
        self.assertEqual(result['end_page'], 1)
        self.assertEqual(result['article_count'], 1)
        with self.DB.get_session() as session:
            self.assertIsNotNone(session.get(self.Article, 'TEST-manual'))

    def test_manual_refresh_surfaces_swallowed_wechat_errors_and_timeouts(self):
        import requests
        cases = [({'base_resp': {'ret': 200013}}, '200013'),
                 ({'base_resp': {'ret': 200003}}, '200003'),
                 (requests.exceptions.Timeout('synthetic'), '采集提前结束')]
        for body, expected in cases:
            with self.subTest(expected=expected):
                result, calls = self.manual_task({0: body})
                self.assertEqual(result['status'], 'failed')
                self.assertIn(expected, result['message'])
                self.assertTrue(calls and set(calls) == {0})
                self.assertEqual(len(calls), 1)  # Interactive failures finish without hidden retries.
                if expected in ('200013', '200003'):
                    self.assertIn('本次已停止', result['message'])

    def test_manual_refresh_partial_page_failure_is_not_success_and_empty_is_valid(self):
        import requests
        result, calls = self.manual_task({0: self.page([self.item('partial', 1788710500)]),
                                         5: requests.exceptions.Timeout('synthetic')}, end=2)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['article_count'], 1)
        self.assertEqual(calls, [0, 5])
        empty, _ = self.manual_task({0: self.page([])})
        self.assertEqual(empty['status'], 'success')
        self.assertIn('没有文章', empty['message'])

    def test_manual_refresh_invalid_range_rejected_and_restart_marks_interrupted(self):
        from core.manual_refresh import ManualRefreshTasks
        from unittest.mock import Mock
        path = self.folder / 'manual-boundaries.json'
        path.unlink(missing_ok=True)
        queue = Mock(return_value=True)
        tasks = ManualRefreshTasks(path, enqueue=queue)
        for start, end in [(1, 1), (-1, 1), (2, 1), (0, 1001)]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                tasks.submit(self.feed, start, end)
        queue.assert_not_called()
        task = tasks.submit(self.feed, 0, 1)
        restarted = ManualRefreshTasks(path).get(task['task_id'])
        self.assertEqual(restarted['status'], 'interrupted')
        self.assertIn('重启', restarted['message'])

    def test_native_refresh_http_returns_a_trackable_job_and_requires_auth(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from core.auth import get_current_user_or_ak
        from core.manual_refresh import ManualRefreshTasks
        from apis.mps import router
        from unittest.mock import Mock
        app = FastAPI()
        app.include_router(router, prefix='/api/v1/wx')
        path = self.folder / 'manual-http.json'
        path.unlink(missing_ok=True)
        tasks = ManualRefreshTasks(path, enqueue=Mock(return_value=True))
        client = TestClient(app)
        self.assertIn(client.get('/api/v1/wx/mps/update/latest/MP_WXS_TEST').status_code, (401, 403))
        app.dependency_overrides[get_current_user_or_ak] = lambda: {'username': 'synthetic'}
        with patch('core.manual_refresh.get_manual_refresh_tasks', return_value=tasks):
            invalid = client.get('/api/v1/wx/mps/update/MP_WXS_TEST?start_page=1&end_page=1').json()
            self.assertNotEqual(invalid['code'], 0)
            response = client.get('/api/v1/wx/mps/update/MP_WXS_TEST?start_page=0&end_page=1').json()
            self.assertEqual(response['code'], 0)
            self.assertNotIn('刷新成功', response['message'])
            task = response['data']
            self.assertEqual(task['status'], 'pending')
            status = client.get('/api/v1/wx/mps/update/tasks/' + task['task_id']).json()
            self.assertEqual(status['data'], task)
            latest = client.get('/api/v1/wx/mps/update/latest/MP_WXS_TEST').json()
            self.assertEqual(latest['data']['task'], task)
            tasks.update(task['task_id'], status='failed', message='微信返回 200013')
            failed = client.get('/api/v1/wx/mps/update/tasks/' + task['task_id']).json()
            self.assertEqual(failed['data']['status'], 'failed')
            self.assertIn('200013', failed['data']['message'])


if __name__ == "__main__":
    unittest.main()
