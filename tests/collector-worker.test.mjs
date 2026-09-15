import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateArticleLink } from '../scripts/collector-worker.mjs';
import { safeVerificationUrl } from '../scripts/collector-verification.mjs';

test('公众号链接解析限制到公众号文章，拒绝本地地址和其他站点', () => {
  assert.equal(validateArticleLink('https://mp.weixin.qq.com/s/demo').hostname, 'mp.weixin.qq.com');
  assert.ok(validateArticleLink('https://mp.weixin.qq.com/s?__biz=MTIz'));
  for (const value of ['http://127.0.0.1/private', 'https://mp.weixin.qq.com.evil.test/s/demo', 'https://user:pass@mp.weixin.qq.com/s/demo', 'https://mp.weixin.qq.com:8443/s/demo', 'https://mp.weixin.qq.com/s/demo/private', 'file:///C:/test']) assert.throws(() => validateArticleLink(value));
});

test('验证交接只接受官方 HTTPS 页面，不接受本机或伪装地址', () => {
  for (const value of ['https://weread.qq.com/', 'https://weread.qq.com/web/mp/reader/example', 'https://weread.qq.com/web/mp/content?reviewId=MP_WXS_123_demo', 'https://open.weixin.qq.com/connect/qrconnect?appid=test', 'https://mp.weixin.qq.com/mp/verify?test=1']) assert.equal(safeVerificationUrl(value), value);
  for (const value of ['http://weread.qq.com/', 'https://weread.qq.com.evil.test/', 'https://weread.qq.com@evil.test/', 'https://user:password@weread.qq.com/', 'https://weread.qq.com:8443/', 'file:///C:/private', 'http://127.0.0.1:4319/collector/status', 'https://mp.weixin.qq.com/other']) assert.equal(safeVerificationUrl(value), null);
});
