import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initialize } from '../scripts/weread-fetcher.mjs';
import { buildContentJs, downloadBodies, localDay, parseGalleryHtml, previousWeek, requestUsage, selectArticles } from '../scripts/weread-content.mjs';

const stamp = (day) => Date.parse(day + 'T00:00:00+08:00') / 1000;
const item = (id, day) => ({ title: id, t: stamp(day), rid: 'MP_WXS_123_' + id, url: 'https://mp.weixin.qq.com/s/' + id });
const fixtureIndex = { sources: [{ name: '测试公众号', bookId: 'MP_WXS_123', items: [item('before', '2026-09-01'), item('first', '2026-09-07'), item('second', '2026-09-10'), item('third', '2026-09-13'), item('after', '2026-09-14')] }] };

test('图片帖提取完整配文和顶层原图，不执行脚本或混入水印', () => {
  const raw = String.raw`<script>
    window.appmsg_type = '9' || '';
    window.msg_title = window.title = '测试\u56fe文' || '';
    window.desc = "第一段\x0a第二段 '引号' \"引用\" &lt;b&gt;原样&lt;/b&gt; 😀".replace(/\n/g, '<br>');
    window.cgiDataNew = { picture_page_info_list: [
      { cdn_url: 'https://mmbiz.qpic.cn/one/0?wx_fmt=jpeg\x26amp;from=appmsg', width: '1280' * 1,
        watermark_info: { cdn_url: 'https://mmbiz.qpic.cn/watermark/0' }, list: [']', {name: "'"}] },
      /* nested structures cannot terminate the list */
      { cdn_url: 'https://mmbiz.qpic.cn/two/0' }
    ] };
    throw new Error('must never execute');
  </script>`;
  const result = parseGalleryHtml(raw);
  assert.equal(result.title, '测试图文');
  assert.equal(result.text, '第一段\n第二段 \'引号\' "引用" <b>原样</b> 😀');
  assert.deepEqual(result.images, ['https://mmbiz.qpic.cn/one/0?wx_fmt=jpeg&from=appmsg', 'https://mmbiz.qpic.cn/two/0']);
  assert.match(result.html, /&lt;b&gt;原样&lt;\/b&gt;/);
  assert.equal(parseGalleryHtml(raw.replace("appmsg_type = '9'", "appmsg_type = '1'")), null);
  assert.equal(parseGalleryHtml(raw.replace('https://mmbiz.qpic.cn/two/0', 'http://127.0.0.1/private')), null);
});

function fixture() {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'opslion-weread-body-'));
  const settings = { runtime, local: {}, configFile: path.join(runtime, 'config.json') };
  const config = initialize(settings);
  const indexFile = path.join(runtime, 'articles.json');
  fs.writeFileSync(indexFile, JSON.stringify(fixtureIndex));
  return { settings, config, indexFile, clean() {
    const resolved = path.resolve(runtime);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^opslion-weread-body-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  } };
}

test('日期按北京时间包含两端，整周选择不会混入本周一', () => {
  const selected = selectArticles(fixtureIndex, '2026-09-07', '2026-09-13');
  assert.deepEqual(selected.articles.map((row) => row.title), ['first', 'second', 'third']);
  assert.equal(selected.coverage[0].date_depth_covered, true);
  assert.deepEqual(previousWeek(new Date('2026-09-13T17:00:00Z')), { start: '2026-09-07', end: '2026-09-13' });
  assert.throws(() => selectArticles(fixtureIndex, '2026-02-30', '2026-03-01'), /日期/);
  assert.throws(() => selectArticles(fixtureIndex, '2026-99-99', '2026-03-01'), /日期/);
});

test('绑定 reviewId 与原文链接，拒绝错误条目和脚本输入', () => {
  const index = structuredClone(fixtureIndex);
  index.sources[0].items[1].url = 'https://mp.weixin.qq.com/s/wrong';
  assert.throws(() => selectArticles(index, '2026-09-07', '2026-09-13'), /不一致/);
  assert.throws(() => buildContentJs("MP_WXS_123_');alert(1)"), /无效/);
});

test('正文请求加入已有目录请求预算，缓存重跑不连接浏览器', async () => {
  const setup = fixture();
  try {
    fs.writeFileSync(setup.config.statePath, JSON.stringify({ date: localDay(), count: 2, requests: { articles: 8, content: 28 } }));
    assert.equal(requestUsage(setup.config).remaining, 4);
    let calls = 0;
    const connect = async () => ({ fetch: async (rid) => {
      calls++;
      const title = rid.slice('MP_WXS_123_'.length);
      return { ok: true, title, html: '<p>完整正文</p>', text: '完整正文', images: [] };
    }, close() {} });
    const first = await downloadBodies(setup.settings, setup.config, setup.indexFile, '2026-09-07', '2026-09-13', { connect, sleep: async () => {}, onProgress() {} });
    assert.equal(calls, 3);
    assert.equal(first.report.status, 'complete');
    const second = await downloadBodies(setup.settings, setup.config, setup.indexFile, '2026-09-07', '2026-09-13', { connect: async () => { throw new Error('缓存重跑不应连接浏览器'); }, onProgress() {} });
    assert.equal(second.report.status, 'complete');
    assert.equal(calls, 3);
  } finally { setup.clean(); }
});

test('首次要求验证即暂停整批，继续时复用已成功的正文', async () => {
  const setup = fixture();
  try {
    let calls = 0;
    const first = await downloadBodies(setup.settings, setup.config, setup.indexFile, '2026-09-07', '2026-09-13', { connect: async () => ({
      fetch: async () => ++calls === 1 ? { ok: true, title: 'first', html: '<p>正文</p>', text: '正文', images: [] } : { ok: false, code: 'verification', error: '需要验证' }, close() {},
    }), sleep: async () => {}, onProgress() {} });
    assert.equal(calls, 2);
    assert.deepEqual(first.report.articles.map((row) => row.status), ['complete', 'failed', 'pending']);
    assert.equal(first.report.status, 'paused');
    assert.equal(first.report.stop_code, 'verification');
    const resumed = [];
    const second = await downloadBodies(setup.settings, setup.config, setup.indexFile, '2026-09-07', '2026-09-13', { connect: async () => ({
      fetch: async (rid) => { resumed.push(rid); return { ok: true, html: '<p>正文</p>', text: '正文', images: [] }; }, close() {},
    }), sleep: async () => {}, onProgress() {} });
    assert.equal(second.report.status, 'complete');
    assert.deepEqual(resumed, ['MP_WXS_123_second', 'MP_WXS_123_third']);
  } finally { setup.clean(); }
});

test('预算耗尽时不发请求、不弹验证，保留未完成清单', async () => {
  const setup = fixture();
  try {
    fs.writeFileSync(setup.config.statePath, JSON.stringify({ date: localDay(), requests: { articles: 8, content: 32 } }));
    let connected = false;
    const result = await downloadBodies(setup.settings, setup.config, setup.indexFile, '2026-09-07', '2026-09-13', { connect: async () => { connected = true; throw new Error(); }, onProgress() {} });
    assert.equal(connected, false);
    assert.equal(result.report.status, 'paused');
    assert.match(result.report.stop_reason, /预算/);
    assert.equal(result.report.stop_code, undefined);
  } finally { setup.clean(); }
});
