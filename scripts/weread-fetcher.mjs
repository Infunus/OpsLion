import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
};

export function inside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

export function readSettings(root = projectRoot) {
  const localFile = path.join(root, 'config', 'local.paths.json');
  const local = fs.existsSync(localFile) ? readJson(localFile) : {};
  const source = path.resolve(process.env.OPSLION_COLLECTOR_SOURCE || path.join(root, 'integrations', 'weread-mp-fetcher'));
  const runtime = path.resolve(process.env.OPSLION_COLLECTOR_DATA_DIR || local.weread_fetcher_data_dir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'OpsLion', 'collector'));
  local.collector_python = process.env.OPSLION_COLLECTOR_PYTHON || local.collector_python || local.rss_python;
  if (inside(runtime, root) || inside(runtime, source)) {
    throw new Error('采集运行目录必须位于源码目录之外。');
  }
  const entry = path.join(source, 'bin', 'weread.mjs');
  if (!fs.existsSync(entry)) throw new Error('随附的采集模块不完整，请重新解压完整项目。');
  return { local, source, runtime, entry, configFile: path.join(runtime, 'config.json') };
}

export function normalizeAccounts(rows) {
  const seen = new Set();
  return rows.flatMap((row) => {
    let bookId = String(row.bookId || row.id || '');
    if (!/^MP_WXS_\d+$/.test(bookId) && row.faker_id) {
      const number = Buffer.from(String(row.faker_id), 'base64').toString('utf8');
      bookId = /^\d+$/.test(number) ? `MP_WXS_${number}` : '';
    }
    if (!/^MP_WXS_\d+$/.test(bookId) || seen.has(bookId)) return [];
    seen.add(bookId);
    return [{ name: String(row.name || row.mp_name || bookId), bookId }];
  });
}

export function initialize(settings) {
  const existing = fs.existsSync(settings.configFile) ? readJson(settings.configFile) : {};
  const defaults = {
    accounts: Object.hasOwn(existing, 'accounts') ? existing.accounts : [],
    readerUrl: '', maxRunsPerDay: 2, requestIntervalMs: 3000,
    maxRequestsPerDay: 40, maxPagesPerRun: 3, chromePort: 9333,
    chromeProfileDir: path.join(settings.runtime, 'chrome-profile'),
    outDir: path.join(settings.runtime, 'exports'),
    statePath: path.join(settings.runtime, 'quota.json'),
  };
  const config = { ...defaults, ...existing };
  validateConfig(config, settings);
  for (const dir of [config.chromeProfileDir, config.outDir]) fs.mkdirSync(dir, { recursive: true });
  writeJson(settings.configFile, config);
  return config;
}

export function validateConfig(config, settings) {
  for (const field of ['chromeProfileDir', 'outDir', 'statePath']) {
    if (typeof config[field] !== 'string' || !path.isAbsolute(config[field]) || !inside(config[field], settings.runtime)) {
      throw new Error(`${field} 必须是采集运行目录内的绝对路径。`);
    }
  }
  if (!Number.isInteger(config.chromePort) || config.chromePort < 1024 || config.chromePort > 65535) {
    throw new Error('chromePort 必须是 1024 至 65535 之间的整数。');
  }
  if (!Array.isArray(config.accounts) || normalizeAccounts(config.accounts).length !== config.accounts.length) {
    throw new Error('accounts 中应填写不重复的公众号 name 和 MP_WXS_数字 bookId。');
  }
}

function upstream(settings, args, capture = false) {
  const result = spawnSync(process.execPath, [settings.entry, '--config', settings.configFile, ...args], {
    cwd: settings.source, stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.code === 'ETIMEDOUT'
      ? '本次操作超时，已停止采集进程。请查看浏览器是否需要扫码或验证。'
      : `采集工具未完成本次操作（退出码 ${result.status ?? '未知'}），请查看上方提示。`);
  }
  return result.stdout;
}

export function verifyShelf(books, accounts) {
  if (!Array.isArray(books)) throw new Error('书架返回格式异常。');
  const missing = accounts.filter((account) => !books.some((book) => book.bookId === account.bookId));
  if (missing.length) throw new Error(`这些公众号尚未出现在书架中：${missing.map((row) => row.name).join('、')}。请检查登录状态后再试。`);
  return books.find((book) => accounts.some((account) => account.bookId === book.bookId) && book.readerUrl)?.readerUrl || '';
}

export function inspectResult(result) {
  if (!Array.isArray(result.sources) || result.sources.length === 0) throw new Error('未返回有效的公众号采集结果。');
  const issues = [];
  const urls = new Set();
  let count = 0;
  for (const source of result.sources) {
    if (source.err || source.partialErr) issues.push(`${source.name}：${source.err || source.partialErr}`);
    const items = source.items || [];
    if (!Array.isArray(items)) throw new Error('文章列表格式异常。');
    if (!items.length && !source.err) issues.push(`${source.name}：返回 0 篇，请核对该号是否被收录。`);
    for (const item of items) {
      count++;
      try {
        const url = new URL(item.url);
        if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || !url.pathname.startsWith('/s/')) throw new Error();
        urls.add(url.href);
      } catch {
        issues.push(`${source.name}：有文章缺少有效的公众号原文链接。`);
      }
    }
  }
  return { count, urls: [...urls], issues: [...new Set(issues)] };
}

export async function collect(settings, config, { trial = false, pages = 1, run = upstream } = {}) {
  if (!config.accounts.length) throw new Error('尚未配置公众号，请在配置文件的 accounts 中填写公众号。');
  if (!Number.isInteger(pages) || pages < 1 || pages > config.maxPagesPerRun) throw new Error('采集页数超出配置允许范围。');
  const { requestUsage } = await import('./weread-content.mjs');
  const usage = requestUsage(config);
  const needed = (trial ? 1 : config.accounts.length) * pages + (config.readerUrl ? 0 : 1);
  if (usage.remaining < needed) throw new Error('今日剩余请求预算不足以采集这些目录；正文缓存仍可用于打包。');
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
  const outDir = path.join(config.outDir, id);
  fs.mkdirSync(outDir, { recursive: true });
  const runConfigFile = path.join(settings.runtime, `run-${id}.json`);
  const remainingIndexBudget = config.maxRequestsPerDay > 0 ? config.maxRequestsPerDay - (Number(usage.ledger.requests?.content) || 0) - (Number(usage.ledger.requests?.management) || 0) : 0;
  writeJson(runConfigFile, { ...config, maxRequestsPerDay: remainingIndexBudget, accounts: trial ? config.accounts.slice(0, 1) : config.accounts });
  const jsonFile = path.join(outDir, 'articles.json');
  try {
    run({ ...settings, configFile: runConfigFile }, ['--pages', String(pages), '--out', jsonFile]);
    const result = readJson(jsonFile);
    const report = inspectResult(result);
    const { toMarkdown } = await import(pathToFileURL(path.join(settings.source, 'lib', 'render.mjs')).href);
    fs.writeFileSync(path.join(outDir, 'articles.md'), toMarkdown(result.sources).trim() + '\n', 'utf8');
    fs.writeFileSync(path.join(outDir, 'links.txt'), report.urls.join('\n') + (report.urls.length ? '\n' : ''), 'utf8');
    writeJson(path.join(outDir, 'summary.json'), {
      collectedAt: new Date().toISOString(), kind: 'article-index', trial, pages,
      count: report.count, uniqueLinks: report.urls.length, issues: report.issues,
    });
    console.log(`已导出 ${report.count} 条文章记录、${report.urls.length} 个原文链接。\n位置：${outDir}`);
    console.log('articles.md 可查看标题和日期；articles.json 保留原始结果；links.txt 为原文链接。');
    console.log('这是文章目录。可用菜单 9 按日期下载正文并打包。');
    if (report.issues.length) throw new Error(`已保存取得的结果，但本次存在问题：\n${report.issues.join('\n')}`);
    return { outDir, ...report };
  } finally {
    fs.rmSync(runConfigFile, { force: true });
  }
}

async function main() {
  const settings = readSettings();
  const action = process.argv[2] || 'check';
  if (action === 'init') {
    const config = initialize(settings);
    console.log(`已配置 ${config.accounts.length} 个公众号。\n配置：${settings.configFile}`);
    return;
  }
  const config = readJson(settings.configFile);
  validateConfig(config, settings);
  if (action === 'check') {
    console.log(`Node.js：${process.version}\n源码：${settings.source}\n运行目录：${settings.runtime}\n已配置 ${config.accounts.length} 个公众号：`);
    config.accounts.forEach((row, index) => console.log(`  ${index + 1}. ${row.name}`));
  } else if (action === 'prepare') {
    if (!config.accounts.length) throw new Error('请先在配置文件的 accounts 中填写公众号。');
    const books = JSON.parse(upstream(settings, ['--add', ...config.accounts.map((row) => row.bookId)], true));
    const readerUrl = verifyShelf(books, config.accounts);
    if (readerUrl) { config.readerUrl = readerUrl; writeJson(settings.configFile, config); }
    console.log(`已核对：${config.accounts.length} 个目标公众号均在书架中。可以进行试采。`);
  } else if (action === 'trial' || action === 'collect') {
    await collect(settings, config, { trial: action === 'trial', pages: Number(process.argv[3] || 1) });
  } else if (action === 'quota') {
    const { requestUsage } = await import('./weread-content.mjs');
    const usage = requestUsage(config);
    console.log(`今日目录采集：${usage.ledger.count || 0}/${config.maxRunsPerDay || '不限'} 次。`);
    console.log(`目录与正文请求合计：${usage.used}/${config.maxRequestsPerDay || '不限'}。命中正文缓存不发送新请求。`);
  } else {
    throw new Error(`未知操作：${action}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
