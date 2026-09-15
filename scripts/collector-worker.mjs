import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readSettings, initialize } from './weread-fetcher.mjs';
import { buildContentJs, countRequest, downloadBodies, latestIndex, requestUsage, selectArticles } from './weread-content.mjs';
import { runLogin } from './collector-auth.mjs';
import { assertNoVerification, waitForReader } from './collector-verification.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(file + '.tmp', file); };
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const progress = (stage, message, completed = 0, total = 0) => emit({ event: 'progress', stage, message, completed, total });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateArticleLink(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || url.port || !/^\/s(?:\/[-\w]+)?\/?$/.test(url.pathname)) throw new Error('请粘贴 https://mp.weixin.qq.com/ 开头的公众号文章链接。');
  return url;
}

function takeLock(settings) {
  const file = path.join(settings.runtime, 'collector.lock');
  try { const descriptor = fs.openSync(file, 'wx'); fs.writeFileSync(descriptor, String(process.pid)); fs.closeSync(descriptor); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try { if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; } } catch (reason) { if (reason.code !== 'ESRCH') alive = true; }
    if (alive) throw new Error('另一项采集正在运行，请等它结束后再继续。');
    fs.unlinkSync(file);
    return takeLock(settings);
  }
  return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
}

async function browserSession(settings, config) {
  const cdp = await import(pathToFileURL(path.join(settings.source, 'lib/cdp.mjs')).href);
  const scripts = await import(pathToFileURL(path.join(settings.source, 'lib/scripts.mjs')).href);
  const session = await cdp.connectChrome({ port: config.chromePort, profileDir: config.chromeProfileDir });
  try {
    const tabs = await cdp.listTabs(session);
    const tab = tabs.find((item) => { try { return new URL(item.url).origin === 'https://weread.qq.com'; } catch { return false; } });
    const target = tab?.targetId || await cdp.createTab(session, 'https://weread.qq.com/');
    const shelf = async () => {
      await assertNoVerification(settings, cdp, session, target, 'login');
      countRequest(config, 'management');
      const value = JSON.parse(await cdp.evaluate(session, target, scripts.LIST_SHELF_JS, 30000));
      if (!value.ok) {
        await assertNoVerification(settings, cdp, session, target, 'login');
        save(path.join(settings.runtime, 'session.json'), { state: 'expired', message: '登录尚未生效或已过期，请在“公众号与登录”中重新扫码。' });
        throw new Error('未能读取微信读书会话，请重新扫码；出现额外验证时可用默认浏览器处理。');
      }
      const books = value.books.filter((book) => /^MP_WXS_\d+$/.test(book.bookId));
      save(path.join(settings.runtime, 'session.json'), { state: 'ready', message: '已登录微信读书。', checked_at: new Date().toISOString() });
      save(path.join(settings.runtime, 'shelf.json'), { books, checked_at: Date.now() });
      return books;
    };
    return { cdp, scripts, session, target, shelf, close: () => session.close() };
  } catch (error) { session.close(); throw error; }
}

async function resolveLink(settings, input) {
  const url = validateArticleLink(input);
  const { extractBiz, bizToBookId } = await import(pathToFileURL(path.join(settings.source, 'lib/mp.mjs')).href);
  let biz = extractBiz(url.href);
  if (!biz) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('无法读取该链接。也可以点击读取书架，从已加入微信读书的公众号中选择。');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) throw new Error('文章页面过大，请从微信读书书架选择公众号。');
      chunks.push(chunk);
    }
    biz = extractBiz(Buffer.concat(chunks).toString('utf8'));
  }
  const bookId = biz && bizToBookId(biz);
  if (!bookId) throw new Error('该链接需要验证或未包含公众号信息。请在采集浏览器把公众号加入微信读书书架，然后点击读取书架选择。');
  return bookId;
}

async function manage(settings, config, input) {
  if (input.action === 'update') {
    const account = config.accounts.find((row) => row.bookId === input.bookId);
    if (!account) throw new Error('公众号已被移除，请刷新列表。');
    if (input.operation === 'remove') config.accounts = config.accounts.filter((row) => row !== account);
    else if (['pause', 'resume'].includes(input.operation)) account.enabled = input.operation === 'resume';
    else throw new Error('无效的公众号操作。');
    save(settings.configFile, config);
    return { message: '公众号列表已更新，已有文章已保留。' };
  }
  const addBook = (book) => {
    const url = new URL(book.readerUrl);
    if (url.origin !== 'https://weread.qq.com' || !url.pathname.startsWith('/web/mp/reader/')) throw new Error('公众号阅读地址无效。');
    if (!config.accounts.some((row) => row.bookId === book.bookId)) config.accounts.push({ name: book.name, bookId: book.bookId, readerUrl: book.readerUrl, enabled: true });
    if (!config.readerUrl) config.readerUrl = book.readerUrl;
    save(settings.configFile, config);
    return { message: `已添加公众号：${book.name}` };
  };
  if (input.action === 'add') {
    const file = path.join(settings.runtime, 'shelf.json');
    const cached = fs.existsSync(file) ? readJson(file) : null;
    const book = Date.now() - (cached?.checked_at || 0) < 600000 && cached.books.find((row) => row.bookId === input.bookId && row.readerUrl);
    if (book) return addBook(book);
  }
  const client = await browserSession(settings, config);
  try {
    if (['check', 'shelf'].includes(input.action)) {
      const books = await client.shelf();
      save(path.join(settings.runtime, 'login.json'), {id:input.job_id,state:'ready',qr_available:false,message:'登录有效，可以在后台采集。'});
      fs.rmSync(path.join(settings.runtime, 'login-qr.png'), {force:true});
      return { books, message: '登录有效，可从书架选择公众号，或通过文章链接添加。' };
    }
    if (input.action === 'logout') {
      await client.session.send('Storage.clearDataForOrigin', { origin: 'https://weread.qq.com', storageTypes: 'all' });
      await client.session.send('Storage.clearCookies');
      const tabs = await client.cdp.listTabs(client.session);
      for (const tab of tabs) { if (tab.url.startsWith('https://weread.qq.com/')) await client.session.send('Target.closeTarget', { targetId: tab.targetId }); }
      save(path.join(settings.runtime, 'session.json'), { state: 'logged_out', message: '已清除采集浏览器授权，订阅和文章已保留。' });
      save(path.join(settings.runtime, 'login.json'), {id:input.job_id,state:'cancelled',qr_available:false,message:'本机采集授权已清除，可重新扫码。'});
      fs.rmSync(path.join(settings.runtime, 'login-qr.png'), {force:true});
      return { message: '本机采集授权已清除。' };
    }
    const bookId = input.action === 'resolve' ? await resolveLink(settings, input.url) : input.bookId;
    if (!/^MP_WXS_\d+$/.test(bookId)) throw new Error('公众号标识无效。');
    // Adding a supplied article link is an explicit subscription action in the UI.
    countRequest(config, 'management');
    const result = JSON.parse(await client.cdp.evaluate(client.session, client.target, client.scripts.buildAddToShelfJs([bookId]), 30000));
    if (!result.ok) throw new Error('未能把公众号加入书架，请检查登录后重试。');
    const books = await client.shelf();
    const book = books.find((row) => row.bookId === bookId && row.readerUrl);
    if (!book) throw new Error('微信读书尚未收录该公众号，或加入书架未成功。');
    return addBook(book);
  } finally { client.close(); }
}

function filteredIndex(settings, config, sourceFile) {
  const index = readJson(sourceFile);
  const enabled = new Set(config.accounts.filter((row) => row.enabled !== false).map((row) => row.bookId));
  if (!enabled.size) throw new Error('请先添加或启用一个公众号。');
  if (index.sources.every((source) => enabled.has(source.bookId)) && [...enabled].every((id) => index.sources.some((source) => source.bookId === id))) return sourceFile;
  index.sources = config.accounts.filter((row) => enabled.has(row.bookId)).map((account) => index.sources.find((source) => source.bookId === account.bookId) || { ...account, items: [], err: '该公众号还没有文章目录，请先采集。' });
  const file = path.join(settings.runtime, 'selected-index.json');
  save(file, index);
  return file;
}

async function scan(settings, config, input, cancelled) {
  const accounts = config.accounts.filter((row) => row.enabled !== false);
  if (!accounts.length) throw new Error('请先添加并启用公众号。');
  const indexFile = path.join(config.outDir, 'web-index', 'articles.json');
  const previous = input.resume && fs.existsSync(indexFile) ? readJson(indexFile) : null;
  const index = { start_date: input.start_date, end_date: input.end_date, collected_at: new Date().toISOString(), sources: accounts.map((account) => {
    const old = previous?.start_date === input.start_date && previous?.end_date === input.end_date && previous.sources.find((row) => row.bookId === account.bookId);
    return old ? { ...old, err: undefined, partialErr: undefined } : { name: account.name, bookId: account.bookId, items: [], pageMeta: [], pagesFetched: 0 };
  }) };
  const lower = Date.parse(input.start_date + 'T00:00:00+08:00') / 1000;
  const covered = (source) => source.pageMeta.some((page) => page.reviews === 0) || source.items.some((item) => item.t < lower);
  if (index.sources.every(covered)) { save(indexFile, index); return indexFile; }
  const usage = requestUsage(config);
  if (config.maxRunsPerDay > 0 && (usage.ledger.count || 0) >= config.maxRunsPerDay) throw new Error('今日目录采集次数已用完。已有目录可直接导出，未完成的目录可次日继续。');
  if (usage.remaining < 1) throw new Error('今日请求预算已用完，已有资料仍可下载或重新打包。');
  const client = await browserSession(settings, config);
  let sent = 0;
  try {
    if (!config.readerUrl) {
      const books = await client.shelf();
      const first = books.find((book) => accounts.some((account) => account.bookId === book.bookId) && book.readerUrl);
      if (!first) throw new Error('请重新添加公众号，取得有效的阅读入口。');
      config.readerUrl = first.readerUrl; save(settings.configFile, config);
    }
    const readerUrl = new URL(config.readerUrl);
    if (readerUrl.origin !== 'https://weread.qq.com' || !readerUrl.pathname.startsWith('/web/mp/reader/')) throw new Error('阅读入口无效，请重新添加公众号。');
    const tabs = await client.cdp.listTabs(client.session);
    const reader = tabs.find((tab) => tab.url === readerUrl.href)?.targetId || await client.cdp.createTab(client.session, readerUrl.href);
    await waitForReader(settings, client.cdp, client.session, reader, client.scripts.PROBE_JS, cancelled);
    for (const [number, source] of index.sources.entries()) {
      if (covered(source)) continue;
      try {
        for (let page = 0; page < Math.min(3, config.maxPagesPerRun); page++) {
          if (cancelled()) throw new Error('已停止目录采集。');
          if (sent) await pause(Math.max(3000, config.requestIntervalMs));
          if (cancelled()) throw new Error('已停止目录采集。');
          progress('index', `正在读取 ${source.name} 的文章目录`, number, accounts.length);
          await assertNoVerification(settings, client.cdp, client.session, reader);
          countRequest(config, 'articles'); sent++;
          const offset = source.pageMeta.reduce((sum, page) => sum + page.reviews, 0);
          const result = JSON.parse(await client.cdp.evaluate(client.session, reader, client.scripts.buildPageJs(source.bookId, offset), 30000));
          if (!result.ok || !result.onReader) {
            await assertNoVerification(settings, client.cdp, client.session, reader);
            throw new Error(`目录接口未返回有效文章（${result.errCode || '会话或网络异常'}），请检查采集浏览器后继续。`);
          }
          for (const item of result.items) { buildContentJs(item.rid); if (!source.items.some((old) => old.rid === item.rid)) source.items.push(item); }
          source.pageMeta.push({ offset, reviews: result.reviews }); source.pagesFetched++;
          source.items.sort((left, right) => right.t - left.t);
          save(indexFile, index);
          if (covered(source)) break;
        }
        if (!covered(source)) { source.partialErr = '本轮目录尚未覆盖开始日期，可继续读取更早文章。'; save(indexFile, index); }
      } catch (error) {
        source[source.items.length ? 'partialErr' : 'err'] = error.message; save(indexFile, index); throw error;
      }
    }
    return indexFile;
  } finally {
    if (sent) { const { ledger } = requestUsage(config); ledger.count = (Number(ledger.count) || 0) + 1; save(config.statePath, ledger); }
    client.close();
  }
}

async function pack(settings, manifestFile, cancelFile) {
  const script = path.join(root, 'scripts/weread_content_pack.py');
  return new Promise((resolve, reject) => {
    const child = spawn(settings.local.collector_python, ['-X', 'utf8', script, manifestFile, '--json-progress', '--cancel-file', cancelFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffered = '', result;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === 'progress') emit(event);
          if (event.event === 'result') result = event;
        } catch { /* Ignore non-protocol dependency output. */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => result ? resolve(result) : reject(new Error(`正文已保存，打包未完成（${code}），可点击导出已有资料重试。`)));
  });
}

export async function run(input) {
  const settings = readSettings();
  const config = initialize(settings);
  const unlock = takeLock(settings);
  try {
    if (input.action === 'login') return await runLogin(settings, config, input, progress);
    if (!['collect', 'export'].includes(input.action)) return await manage(settings, config, input);
    selectArticles({ sources: [] }, input.start_date, input.end_date);
    const cancelled = () => fs.existsSync(input.cancel_file);
    const sourceFile = input.action === 'collect' ? await scan(settings, config, input, cancelled) : latestIndex(config);
    if (cancelled()) return { state: 'cancelled', message: '已停止采集，已有内容已保留。' };
    const file = filteredIndex(settings, config, sourceFile);
    const download = await downloadBodies(settings, config, file, input.start_date, input.end_date, { isCancelled: cancelled, onProgress: (message) => {
      const match = /^\[(\d+)\/(\d+)\]/.exec(message);
      progress('bodies', message, match ? Number(match[1]) - 1 : 0, match ? Number(match[2]) : 0);
    } });
    if (cancelled()) return { state: 'cancelled', message: '已停止采集，已下载正文可继续使用。' };
    if (download.report.stop_code === 'verification') return { state: 'paused', code: 'verification', message: download.report.stop_reason };
    progress('images', '正文已保存，正在整理配图与资料包…');
    const packed = await pack(settings, download.manifestFile, input.cancel_file);
    return { state: packed.manifest.archive_complete ? 'complete' : 'paused', message: packed.manifest.archive_complete
      ? `已完成 ${packed.manifest.body_count} 篇正文、${packed.manifest.image_count} 张配图。`
      : (download.report.stop_reason || '部分资料仍有缺失，可查看清单并继续补取。'), article_count: packed.manifest.article_count, body_count: packed.manifest.body_count };
  } catch (error) {
    if (error.code === 'verification') return { state: 'paused', code: 'verification', message: error.message };
    throw error;
  } finally { unlock(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  try { emit({ event: 'result', ...await run(JSON.parse(source)) }); }
  catch (error) { emit({ event: 'result', state: 'failed', message: error.message }); process.exitCode = 1; }
}
