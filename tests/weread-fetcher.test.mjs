import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collect, initialize, inspectResult, normalizeAccounts, validateConfig, verifyShelf } from '../scripts/weread-fetcher.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function cleanFixture(runtime) {
  const resolved = path.resolve(runtime);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^opslion-weread-/);
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('读取 RSS 名单时过滤精选、无效 ID 和重复项，兼容 faker_id', () => {
  assert.deepEqual(normalizeAccounts([
    { id: 'MP_WXS_123', mp_name: '示例甲' },
    { id: 'MP_WXS_FEATURED_ARTICLES', mp_name: '精选' },
    { id: 'old-id', faker_id: Buffer.from('456').toString('base64'), mp_name: '示例乙' },
    { id: 'MP_WXS_123', mp_name: '重复' },
  ]), [{ name: '示例甲', bookId: 'MP_WXS_123' }, { name: '示例乙', bookId: 'MP_WXS_456' }]);
});

test('接口不报错但书架缺少目标号时，不报告准备完成', () => {
  assert.throws(() => verifyShelf([], [{ name: '示例甲', bookId: 'MP_WXS_123' }]), /尚未出现在书架/);
});

test('返回 0 篇、部分失败、缺链接分别报告', () => {
  const report = inspectResult({ sources: [
    { name: '甲', items: [] },
    { name: '乙', partialErr: 'errCode=-2041', items: [{ url: 'https://mp.weixin.qq.com/s/demo' }] },
    { name: '丙', items: [{ url: 'https://example.com/s/demo' }] },
  ] });
  assert.equal(report.issues.length, 3);
  assert.deepEqual(report.urls, ['https://mp.weixin.qq.com/s/demo']);
});

test('初始化可重复执行，保留已编辑名单，拒绝把导出目录指向源码', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'opslion-weread-config-'));
  try {
    const settings = { runtime, local: {}, configFile: path.join(runtime, 'config.json') };
    const first = initialize(settings);
    first.accounts = [{ name: '用户选的号', bookId: 'MP_WXS_123' }];
    first.requestIntervalMs = 4000;
    fs.writeFileSync(settings.configFile, JSON.stringify(first));
    const second = initialize(settings);
    assert.deepEqual(second, first);
    assert.throws(() => validateConfig({ ...second, outDir: project }, settings), /运行目录/);
  } finally { cleanFixture(runtime); }
});

test('一次试采生成 JSON、Markdown、链接清单，并共用采集次数记录', async (t) => {
  const source = path.join(project, 'integrations', 'weread-mp-fetcher');
  if (!fs.existsSync(source)) return t.skip('需要安装上游工具后执行此集成测试');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'opslion-weread-export-'));
  try {
    const settings = { source, runtime, local: {}, configFile: path.join(runtime, 'config.json') };
    const config = initialize(settings);
    config.accounts = [{ name: '甲', bookId: 'MP_WXS_123' }, { name: '乙', bookId: 'MP_WXS_456' }];
    let calls = 0;
    const result = await collect(settings, config, { trial: true, run: (runSettings, args) => {
      calls++;
      const runConfig = JSON.parse(fs.readFileSync(runSettings.configFile, 'utf8'));
      assert.equal(runConfig.accounts.length, 1);
      assert.equal(runConfig.statePath, config.statePath);
      const out = args[args.indexOf('--out') + 1];
      fs.writeFileSync(out, JSON.stringify({ sources: [{ name: '甲', items: [
        { title: '文章甲', url: 'https://mp.weixin.qq.com/s/demo', t: 1789000000 },
        { title: '同一链接', url: 'https://mp.weixin.qq.com/s/demo', t: 1789000000 },
      ] }] }));
    } });
    assert.equal(calls, 1);
    assert.equal(config.accounts.length, 2);
    assert.equal(fs.readFileSync(path.join(result.outDir, 'links.txt'), 'utf8').trim().split('\n').length, 1);
    assert.match(fs.readFileSync(path.join(result.outDir, 'articles.md'), 'utf8'), /文章甲/);
    assert.equal(fs.readdirSync(runtime).filter((name) => name.startsWith('run-')).length, 0);
  } finally { cleanFixture(runtime); }
});

test('采集失败仍清理临时配置，不覆盖原始配置', async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'opslion-weread-failure-'));
  try {
    const settings = { runtime, local: {}, configFile: path.join(runtime, 'config.json') };
    const config = initialize(settings);
    config.accounts = [{ name: '甲', bookId: 'MP_WXS_123' }];
    const before = fs.readFileSync(settings.configFile, 'utf8');
    await assert.rejects(collect(settings, config, { run: () => { throw new Error('登录失效'); } }), /登录失效/);
    assert.equal(fs.readFileSync(settings.configFile, 'utf8'), before);
    assert.equal(fs.readdirSync(runtime).filter((name) => name.startsWith('run-')).length, 0);
  } finally { cleanFixture(runtime); }
});
