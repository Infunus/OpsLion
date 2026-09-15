import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSettings, validateConfig } from './weread-fetcher.mjs';
import { assertNoVerification, verificationRequired, waitForReader } from './collector-verification.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
};

export function localDay(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

export function requestUsage(config) {
  const old = fs.existsSync(config.statePath) ? readJson(config.statePath) : {};
  const ledger = old.date === localDay() ? old : { date: localDay(), count: 0, requests: {} };
  const requests = ledger.requests || {};
  const used = ['articles', 'shelf', 'content', 'management'].reduce((sum, key) => sum + (Number(requests[key]) || 0), 0);
  return { ledger, used, remaining: config.maxRequestsPerDay > 0 ? Math.max(0, config.maxRequestsPerDay - used) : Infinity };
}

export function countRequest(config, kind = 'content') {
  const { ledger, remaining } = requestUsage(config);
  if (remaining < 1) throw new Error('今日请求预算已用完，已保存的正文可继续导出；请次日再补取缺少的正文。');
  ledger.requests = { ...ledger.requests, [kind]: (Number(ledger.requests?.[kind]) || 0) + 1 };
  writeJson(config.statePath, ledger);
}

export function buildContentJs(reviewId) {
  if (!/^MP_WXS_\d+_[A-Za-z0-9_~-]+$/.test(reviewId)) throw new Error('文章 reviewId 无效。');
  const url = '/web/mp/content?reviewId=' + encodeURIComponent(reviewId);
  return `(async function () {
    if (location.hostname !== 'weread.qq.com' || !location.pathname.startsWith('/web/mp/reader/')) {
      return JSON.stringify({ ok: false, code: 'wrong_page', error: '请在公众号阅读页面中采集。' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(${JSON.stringify(url)}, { credentials: 'include', signal: controller.signal });
      const raw = await response.text();
      if (/^\\s*\\{/.test(raw)) {
        const data = JSON.parse(raw);
        return JSON.stringify({ ok: false, code: data.errCode || data.errcode || 'unexpected_json', error: '正文接口未返回文章内容' });
      }
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const allText = doc.body.textContent || '';
      if (/当前环境异常[，,]?\\s*完成验证|请完成(?:安全|人机)验证/.test(allText) && !doc.querySelector('#js_content,.rich_media_content')) {
        return JSON.stringify({ ok: false, code: 'verification', error: '正文接口要求验证，已停止本批请求。', verificationUrl: response.url });
      }
      if (!response.ok) return JSON.stringify({ ok: false, code: response.status, error: '正文接口返回 HTTP ' + response.status });
      if (allText.includes('你暂无权限查看此页面内容')) return JSON.stringify({ ok: false, code: 'permission_denied', error: '当前会话没有阅读该内容的权限' });
      if (allText.includes('未知错误，请稍后再试')) return JSON.stringify({ ok: false, code: 'upstream_error', error: '正文服务暂时出错，请稍后重试' });
      const body = doc.querySelector('#js_content') || doc.querySelector('.rich_media_content');
      if (!body) return JSON.stringify({ ok: false, code: 'missing_body', error: '返回页面没有文章正文', diagnosticHtml: raw,
        diagnostic: { title: doc.title, text: allText.trim().slice(0, 600), ids: Array.from(doc.querySelectorAll('[id]')).map(node => node.id).slice(0, 35), images: doc.querySelectorAll('img').length, bytes: raw.length } });
      body.querySelectorAll('script,style,noscript,form,object,embed,iframe').forEach(node => node.remove());
      body.querySelectorAll('*').forEach(node => {
        Array.from(node.attributes).forEach(attr => {
          if (/^on/i.test(attr.name) || attr.name === 'srcdoc') node.removeAttribute(attr.name);
        });
      });
      const text = (body.innerText || body.textContent || '').trim();
      const images = Array.from(body.querySelectorAll('img')).map(img => img.getAttribute('data-src') || img.getAttribute('src') || '').filter(Boolean);
      const title = (doc.querySelector('#activity-name')?.textContent || doc.querySelector('meta[property="og:title"]')?.content || '').trim();
      if (!text && !images.length) return JSON.stringify({ ok: false, code: 'empty_body', error: '文章正文为空' });
      return JSON.stringify({ ok: true, title, html: body.innerHTML, text, images, http: response.status, source: 'weread' });
    } catch (error) {
      return JSON.stringify({ ok: false, code: error.name === 'AbortError' ? 'timeout' : 'request_error', error: String(error.message).slice(0, 100) });
    } finally { clearTimeout(timer); }
  })()`;
}

export function cachePath(runtime, reviewId) {
  return path.join(runtime, 'body-cache', createHash('sha256').update(reviewId).digest('hex') + '.json');
}

// Read inert string literals from picture-post data; never execute article scripts.
function quotedValue(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let pos = start + 1; pos < source.length; pos++) {
    const char = source[pos];
    if (char === quote) return { value, end: pos + 1 };
    if (char !== '\\') { value += char; continue; }
    const escaped = source[++pos];
    if (escaped === undefined) return null;
    if (escaped === 'x' || escaped === 'u') {
      const count = escaped === 'x' ? 2 : 4;
      const digits = source.slice(pos + 1, pos + count + 1);
      if (digits.length !== count || !/^[\da-f]+$/i.test(digits)) return null;
      value += String.fromCharCode(parseInt(digits, 16));
      pos += count;
    } else if (escaped === '\r' || escaped === '\n') {
      if (escaped === '\r' && source[pos + 1] === '\n') pos++;
    } else {
      value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[escaped] ?? escaped;
    }
  }
  return null;
}

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function galleryImages(source, start) {
  const stack = [];
  const images = [];
  for (let pos = start; pos < source.length;) {
    const char = source[pos];
    if (char === '/' && source[pos + 1] === '/') {
      const end = source.indexOf('\n', pos + 2);
      if (end < 0) return [];
      pos = end + 1; continue;
    }
    if (char === '/' && source[pos + 1] === '*') {
      const end = source.indexOf('*/', pos + 2);
      if (end < 0) return [];
      pos = end + 2; continue;
    }
    if (char === '"' || char === "'") {
      const literal = quotedValue(source, pos);
      if (!literal) return [];
      pos = literal.end; continue;
    }
    if (char === '[' || char === '{') stack.push(char);
    if (char === ']' || char === '}') {
      if (stack.pop() !== (char === ']' ? '[' : '{')) return [];
      if (!stack.length) return images;
    }
    if (/[a-z_$]/i.test(char)) {
      const identifier = /^[\w$]+/.exec(source.slice(pos))[0];
      pos += identifier.length;
      if (identifier === 'cdn_url' && stack.join('') === '[{') {
        const colon = /^\s*:\s*/.exec(source.slice(pos));
        const literal = colon && quotedValue(source, pos + colon[0].length);
        if (literal) { images.push(decodeEntities(literal.value)); pos = literal.end; }
      }
      continue;
    }
    pos++;
  }
  return [];
}

export function parseGalleryHtml(raw) {
  const scripts = Array.from(raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi), (match) => match[1]);
  const assignment = (pattern) => {
    for (const script of scripts) {
      const match = pattern.exec(script);
      if (match) return quotedValue(script, match.index + match[0].length)?.value;
    }
  };
  if (assignment(/\bwindow\.appmsg_type\s*=\s*/) !== '9') return null;
  const caption = assignment(/\bwindow\.desc\s*=\s*/);
  const title = assignment(/\bwindow\.msg_title\s*=\s*window\.title\s*=\s*/);
  if (caption === undefined || !title) return null;
  const data = scripts.find((script) => /\bwindow\.cgiDataNew\s*=\s*\{/.test(script));
  const list = data && /\bpicture_page_info_list\s*:\s*(?=\[)/.exec(data);
  if (!list) return null;
  const images = [...new Set(galleryImages(data, list.index + list[0].length))];
  if (!images.length || images.some((source) => {
    try { const url = new URL(source); return url.protocol !== 'https:' || url.hostname !== 'mmbiz.qpic.cn' || !!url.username || !!url.password || !!url.port; }
    catch { return true; }
  })) return null;
  const text = decodeEntities(caption).replace(/\r/g, '').trim();
  const html = text.split('\n').map((line) => '<p>' + (escapeHtml(line) || '<br>') + '</p>').join('\n')
    + '\n' + images.map((source) => '<img src="' + escapeHtml(source) + '" alt="">').join('\n');
  return { ok: true, title: decodeEntities(title).trim(), html, text, images, http: 200, source: 'weread', content_kind: 'gallery' };
}

export async function openContentSession(settings, config, { isCancelled = () => false } = {}) {
  const cdp = await import(pathToFileURL(path.join(settings.source, 'lib', 'cdp.mjs')).href);
  const { PROBE_JS } = await import(pathToFileURL(path.join(settings.source, 'lib', 'scripts.mjs')).href);
  const session = await cdp.connectChrome({ port: config.chromePort, profileDir: config.chromeProfileDir });
  try {
    const tabs = await cdp.listTabs(session);
    const reader = tabs.find((tab) => {
      try { const url = new URL(tab.url); return url.origin === 'https://weread.qq.com' && url.pathname.startsWith('/web/mp/reader/'); }
      catch { return false; }
    });
    let targetId = reader?.targetId;
    if (!targetId) {
      const url = new URL(config.readerUrl || 'about:blank');
      if (url.origin !== 'https://weread.qq.com' || !url.pathname.startsWith('/web/mp/reader/')) throw new Error('请在“公众号与登录”中重新添加公众号。');
      targetId = await cdp.createTab(session, url.href);
    }
    await waitForReader(settings, cdp, session, targetId, PROBE_JS, isCancelled);
    return {
          async fetch(reviewId) {
            await assertNoVerification(settings, cdp, session, targetId);
            const script = buildContentJs(reviewId);
            countRequest(config);
            const result = JSON.parse(await cdp.evaluate(session, targetId, script, 35000));
            if (result.code === 'verification') {
              verificationRequired(settings, null, result.verificationUrl || `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`, 'body');
              delete result.verificationUrl;
            } else if (!result.ok) await assertNoVerification(settings, cdp, session, targetId);
            return result.code === 'missing_body' && result.diagnosticHtml ? parseGalleryHtml(result.diagnosticHtml) || result : result;
          },
          close: () => session.close(),
    };
  } catch (error) { session.close(); throw error; }
}

export function previousWeek(date = new Date()) {
  const today = new Date(localDay(date) + 'T00:00:00Z');
  const weekday = (today.getUTCDay() + 6) % 7;
  const end = new Date(today.getTime() - (weekday + 1) * 86400000);
  return { start: new Date(end.getTime() - 6 * 86400000).toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function selectArticles(index, start, end) {
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (!validDate(start) || !validDate(end) || start > end) throw new Error('日期须为 YYYY-MM-DD，且开始日期不能晚于结束日期。');
  if (!Array.isArray(index.sources)) throw new Error('文件不是有效的文章目录。');
  const lower = Date.parse(start + 'T00:00:00+08:00') / 1000;
  const upper = Date.parse(end + 'T00:00:00+08:00') / 1000 + 86400;
  const articles = [];
  const issues = [];
  const seen = new Set();
  const coverage = [];
  for (const source of index.sources) {
    if (source.err || source.partialErr) issues.push({ type: 'index_error', account: source.name, message: source.err || source.partialErr });
    const items = Array.isArray(source.items) ? source.items : [];
    const oldest = items.length ? Math.min(...items.map((item) => Number(item.t) || Infinity)) : null;
    const endsHistory = source.pageMeta?.some((page) => page.reviews === 0) || false;
    const depthCovered = !source.err && !source.partialErr && (endsHistory || (oldest !== null && oldest < lower));
    coverage.push({ account: source.name, oldest, date_depth_covered: depthCovered });
    if (!depthCovered) issues.push({ type: 'index_depth', account: source.name, message: '目录尚未覆盖开始日期，请补取更早页后再核对。' });
    for (const item of items) {
      if (!(Number(item.t) >= lower && Number(item.t) < upper)) continue;
      if (!/^MP_WXS_\d+$/.test(source.bookId) || !String(item.rid).startsWith(source.bookId + '_')) throw new Error('文章与公众号标识不一致。');
      buildContentJs(item.rid);
      const expectedUrl = 'https://mp.weixin.qq.com/s/' + item.rid.slice(source.bookId.length + 1).replace(/~/g, '_');
      if (item.url !== expectedUrl) throw new Error('文章链接与 reviewId 不一致，请重新采集目录。');
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      articles.push({ id: item.rid, account_id: source.bookId, account_name: source.name, title: item.title, publish_time: Number(item.t), source_url: item.url });
    }
  }
  articles.sort((a, b) => a.publish_time - b.publish_time || a.id.localeCompare(b.id));
  return { articles, issues, coverage };
}

export function latestIndex(config) {
  const files = fs.readdirSync(config.outDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => path.join(config.outDir, entry.name, 'articles.json')).filter((file) => fs.existsSync(file));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error('尚无文章目录，请先在周报页面采集公众号。');
  return files[0];
}

function titleKey(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ''); }

export function usableCachedBody(body, article) {
  return body?.ok === true && body.rid === article.id && body.originalUrl === article.source_url
    && typeof body.html === 'string' && body.html.length > 0 && typeof body.text === 'string'
    && (body.text.trim().length > 0 || (Array.isArray(body.images) && body.images.length > 0))
    && (!body.title || titleKey(body.title) === titleKey(article.title));
}

export async function downloadBodies(settings, config, indexFile, start, end, { connect = openContentSession, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onProgress = console.log, isCancelled = () => false } = {}) {
  const source = fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, '');
  const selected = selectArticles(JSON.parse(source), start, end);
  if (!selected.articles.length) throw new Error('所选日期在该目录中没有文章。');
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 10);
  const output = path.join(config.outDir, `正文_${start}_${end}_${hash}`);
  const manifestFile = path.join(output, 'download.json');
  const report = { schema: 'opslion-weread/content-v1', start_date: start, end_date: end, created_at: new Date().toISOString(), source_index: path.resolve(indexFile), coverage: selected.coverage, index_issues: selected.issues, status: 'running', stop_reason: '', articles: [] };
  for (const article of selected.articles) {
    const file = cachePath(settings.runtime, article.id);
    let cached;
    try { cached = readJson(file); } catch { /* Missing or interrupted cache is fetched again. */ }
    report.articles.push({ ...article, body_file: file, status: usableCachedBody(cached, article) ? 'complete' : 'pending' });
  }
  const save = () => writeJson(manifestFile, report);
  save();
  const required = report.articles.filter((article) => article.status !== 'complete').length;
  onProgress(`${start} 至 ${end}：${report.articles.length} 篇，已缓存 ${report.articles.length - required} 篇，待下载 ${required} 篇。`);
  let client;
  let requests = 0;
  try {
    for (const article of report.articles) {
      if (isCancelled()) throw new Error('已停止采集，已取得的正文已保留。');
      if (article.status === 'complete') continue;
      if (requestUsage(config).remaining < 1) throw new Error('今日请求预算已用完，本次已暂停；已下载正文可打包并在次日继续。');
      if (!client) client = await connect(settings, config, { isCancelled });
      if (requests) await sleep(Math.max(3000, Number(config.requestIntervalMs) || 3000));
      if (isCancelled()) throw new Error('已停止采集，已取得的正文已保留。');
      requests++;
      onProgress(`[${report.articles.indexOf(article) + 1}/${report.articles.length}] ${article.account_name} · ${article.title}`);
      const result = await client.fetch(article.id);
      if (!result.ok) {
        article.status = 'failed';
        article.error = `${result.code} · ${result.error}`;
        if (result.diagnostic) article.diagnostic = result.diagnostic;
        if (result.diagnosticHtml) {
          const diagnosticFile = path.join(settings.runtime, 'body-diagnostics', createHash('sha256').update(article.id).digest('hex') + '.html');
          fs.mkdirSync(path.dirname(diagnosticFile), { recursive: true });
          fs.writeFileSync(diagnosticFile, result.diagnosticHtml, 'utf8');
        }
        save();
        throw Object.assign(new Error(`正文请求已暂停：${article.error}。同批剩余文章未继续请求。`), { code: result.code });
      }
      const body = { ...result, rid: article.id, originalUrl: article.source_url, fetchedAt: new Date().toISOString() };
      if (!usableCachedBody(body, article)) {
        article.status = 'failed';
        article.error = '正文标题或内容校验未通过';
        save();
        throw new Error('正文校验未通过，已停止本批采集。');
      }
      writeJson(article.body_file, body);
      article.status = 'complete';
      article.characters = body.text.length;
      save();
    }
    report.status = 'complete';
  } catch (error) {
    report.status = 'paused';
    if (error.code === 'verification') report.stop_code = 'verification';
    report.stop_reason = error.message;
    onProgress(error.message);
  } finally {
    client?.close();
    save();
  }
  return { output, manifestFile, report };
}

async function runPacker(settings, manifestFile) {
  const python = settings.local.collector_python;
  if (!python || !fs.existsSync(python)) throw new Error('请在周报页面初始化公众号采集环境后重试。');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'weread_content_pack.py');
  await new Promise((resolve, reject) => {
    const child = spawn(python, ['-X', 'utf8', script, manifestFile], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`正文已缓存，但打包未全部完成（退出码 ${code}）。请查看上方提示。`)));
  });
}

async function main() {
  const settings = readSettings();
  const config = readJson(settings.configFile);
  validateConfig(config, settings);
  const week = previousWeek();
  let indexFile = process.argv[2] && process.argv[2] !== 'latest' ? process.argv[2] : latestIndex(config);
  if (fs.statSync(indexFile).isDirectory()) indexFile = path.join(indexFile, 'articles.json');
  const start = process.argv[3] || week.start;
  const end = process.argv[4] || week.end;
  const result = await downloadBodies(settings, config, indexFile, start, end);
  await runPacker(settings, result.manifestFile);
  if (result.report.status !== 'complete') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
