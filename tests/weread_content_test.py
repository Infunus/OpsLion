import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("weread_content_pack", Path(__file__).resolve().parents[1] / "scripts" / "weread_content_pack.py")
packer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packer)


class WereadContentPackTests(unittest.TestCase):
    def test_image_url_scope(self):
        self.assertTrue(packer.safe_image_url("https://mmbiz.qpic.cn/example/640"))
        self.assertTrue(packer.safe_image_url("https://mmecoa.qpic.cn/example/640"))
        for url in ("http://127.0.0.1/x", "https://mmbiz.qpic.cn.evil.test/x", "https://user:secret@mmbiz.qpic.cn/x", "file:///C:/test"):
            self.assertFalse(packer.safe_image_url(url))

    def test_archive_preserves_full_text_and_cleans_active_content(self):
        with tempfile.TemporaryDirectory(prefix="opslion-weread-pack-") as temporary:
            root = Path(temporary)
            self.assertEqual(root.resolve().parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("opslion-weread-pack-"))
            image_url = "https://mmbiz.qpic.cn/example/640"
            body_file = root / "body.json"
            body_file.write_text(json.dumps({"ok": True, "rid": "MP_WXS_123_demo", "originalUrl": "https://mp.weixin.qq.com/s/demo", "text": "第一段完整正文第二段完整正文", "html": f'<script>evil()</script><p onclick="evil()">第一段完整正文</p><p>第二段完整正文</p><img data-src="{image_url}">'}), encoding="utf-8")
            report = {"start_date": "2026-09-07", "end_date": "2026-09-13", "coverage": [], "index_issues": [], "status": "complete", "articles": [{"id": "MP_WXS_123_demo", "account_id": "MP_WXS_123", "account_name": "测试公众号", "title": "测试文章", "publish_time": 1789000000, "source_url": "https://mp.weixin.qq.com/s/demo", "body_file": str(body_file), "status": "complete"}]}
            manifest = root / "download.json"
            manifest.write_text(json.dumps(report), encoding="utf-8")

            def image_fetch(url, folder):
                (folder / "test.png").write_bytes(b"fixture-image")
                return {"source_url": url, "path": "assets/test.png"}

            result, archive = packer.pack(manifest, image_fetch=image_fetch)
            self.assertTrue(result["archive_complete"])
            self.assertFalse(result["collection_coverage_confirmed"])
            self.assertEqual(result["body_count"], 1)
            with zipfile.ZipFile(archive) as zipped:
                self.assertIsNone(zipped.testzip())
                text = zipped.read("all-text.md").decode("utf-8")
                self.assertIn("第一段完整正文", text)
                self.assertIn("第二段完整正文", text)
                self.assertNotIn("![", text)
                page = zipped.read(next(name for name in zipped.namelist() if name.endswith(".html"))).decode("utf-8")
                self.assertNotIn("onclick", page)
                self.assertNotIn("<script", page)
                self.assertIn("../assets/test.png", page)
                self.assertNotIn(str(root), zipped.read("manifest.json").decode("utf-8"))

    def test_missing_bodies_and_unsupported_images_are_not_reported_complete(self):
        with tempfile.TemporaryDirectory(prefix="opslion-weread-pack-") as temporary:
            root = Path(temporary)
            self.assertEqual(root.resolve().parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(root.name.startswith("opslion-weread-pack-"))
            body_file = root / "body.json"
            body_file.write_text(json.dumps({"ok": True, "rid": "MP_WXS_123_demo", "originalUrl": "https://mp.weixin.qq.com/s/demo", "text": "完整文字", "html": '<p>完整文字</p><img src="https://unknown.test/photo.png">'}), encoding="utf-8")
            article = {"id": "MP_WXS_123_demo", "account_id": "MP_WXS_123", "account_name": "示例", "title": "已下载文章", "publish_time": 1789000000, "source_url": "https://mp.weixin.qq.com/s/demo", "body_file": str(body_file), "status": "complete"}
            report = {"start_date": "2026-09-07", "end_date": "2026-09-13", "coverage": [], "index_issues": [], "status": "paused", "articles": [article, {**article, "id": "MP_WXS_123_pending", "title": "尚未下载", "status": "pending"}]}
            manifest = root / "download.json"
            manifest.write_text(json.dumps(report), encoding="utf-8")

            def no_network(url, folder):
                self.fail("不应请求未知图片地址")

            result, archive = packer.pack(manifest, image_fetch=no_network)
            self.assertFalse(result["archive_complete"])
            self.assertEqual(result["body_count"], 1)
            self.assertEqual(result["article_count"], 2)
            self.assertCountEqual([issue["type"] for issue in result["issues"]], ["image", "body"])
            self.assertIn("含缺失项", archive.name)


if __name__ == "__main__":
    unittest.main()
