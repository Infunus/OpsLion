import { status, start, request, download, openBrowser } from '../collector/api.js';
import { today } from '../collector/range.js';

const $ = id => document.getElementById(id);
$('root').innerHTML = `
  <header class="topbar"><a class="brand" href="#"><img src="../icon48.png" alt=""><span>运营狮 <small>公众号下载工具</small></span></a><span class="version">0.9.0</span></header>
  <main>
    <div class="intro"><p class="eyebrow">公众号采集</p><h1>把公众号推文，下载到本地。</h1><p>登录微信读书，添加公众号，一次打包文字和配图。</p></div>
    <div id="notice" class="notice" role="alert" hidden></div>
    <div class="workspace">
      <section class="card accounts-card" aria-labelledby="account-heading">
        <div class="section-heading"><span class="step">1</span><h2 id="account-heading">登录与公众号</h2><span id="account-count" class="badge">0 个已选</span></div>
        <div class="login-panel">
          <div class="login-line"><span id="login-dot" class="dot"></span><strong id="login-state">正在读取登录状态…</strong></div>
          <p id="session-message" class="muted"></p>
          <div class="buttons"><button id="login" data-idle type="button">微信扫码登录</button><button id="check" data-idle class="secondary" type="button">检查登录</button><button id="browser" class="text-button" type="button">打开登录 / 验证页 ↗</button></div>
          <div id="qr-panel" class="qr-panel" hidden><img id="qr" width="208" height="208" alt="微信读书登录二维码"><p id="qr-message"></p></div>
        </div>
        <form id="add-form"><label for="article-url">粘贴该公众号的任意一篇文章链接</label><div class="input-row"><input id="article-url" type="url" required placeholder="https://mp.weixin.qq.com/s/…" autocomplete="off"><button id="add" data-idle type="submit">添加</button></div></form>
        <details id="shelf-details"><summary>从微信读书书架选择</summary><div class="shelf-tools"><p class="muted">显示当前账号书架中的公众号。</p><button id="shelf" data-idle class="text-button" type="button">刷新书架</button></div><div id="shelf-list"></div></details>
        <div class="list-heading"><h3>要下载的公众号</h3><span class="muted">勾选后批量采集</span></div><div id="accounts"></div>
        <details class="account-options"><summary>登录选项</summary><button id="logout" data-idle class="text-button" type="button">退出微信读书登录</button></details>
      </section>
      <section class="card collect-card" aria-labelledby="collect-heading">
        <div class="section-heading"><span class="step">2</span><h2 id="collect-heading">抓取并下载</h2></div>
        <fieldset id="scope"><legend>采集范围</legend><label class="range-option"><input type="radio" name="range" value="all" checked><span><strong>全部历史推文</strong><small>自动翻页，直到可获取的历史目录结束</small></span></label><label class="range-option"><input type="radio" name="range" value="dates"><span><strong>指定日期</strong><small>只下载所选时间内的推文</small></span></label></fieldset>
        <div id="dates" class="date-row" hidden><label for="start-date">开始日期<input id="start-date" type="date"></label><span>至</span><label for="end-date">结束日期<input id="end-date" type="date"></label></div>
        <p class="range-note">可获取范围由微信读书提供。视频消息保留原文链接；无法获取的内容会列入缺失清单。</p>
        <button id="collect" data-idle class="primary collect-button" type="button">抓取全部推文并下载 ZIP ↓</button>
        <button id="export" data-idle class="secondary export-button" type="button">打包下载已采集资料</button>
        <button id="repair-links" data-idle class="secondary export-button" type="button">修复原文链接并重新打包</button>
        <p class="small muted">旧资料出现失效链接时，选择对应日期并修复；会联网补取链接，复用已保存的正文。</p>
        <p class="small muted">采集期间保持本页打开。文字、图片和下载记录保存在此浏览器中。</p>
        <div id="job-panel" class="job-panel" hidden><div class="job-heading"><strong id="job-state"></strong><span id="job-count" class="muted"></span></div><progress id="progress" max="1"></progress><p id="job-message" role="status" aria-live="polite"></p><div class="buttons"><button id="cancel" class="secondary" type="button" hidden>停止任务</button><button id="resume" data-idle type="button" hidden>继续上次任务</button></div></div>
      </section>
    </div>
    <section class="card downloads-card" aria-labelledby="downloads-heading"><div class="section-heading"><span class="step">3</span><h2 id="downloads-heading">下载记录</h2><span id="download-count" class="badge">0 份资料</span></div><div id="downloads"></div></section>
    <footer>ZIP 包含逐篇 Markdown / HTML、合并文字稿、本地配图，以及完整目录和缺失清单。</footer>
  </main>`;

let snapshot;
let submitting = false;
let refreshing = false;
let cancelRequested = false;
let downloading = false;
const signatures = new Map();
const pendingKey = 'opslion-auto-download';
const active = () => ['running', 'cancelling'].includes(snapshot?.job?.state);
const enabledCount = () => snapshot?.accounts.filter(account => account.enabled !== false).length || 0;
const collectionInput = () => ({ all_history: document.querySelector('input[name="range"]:checked').value === 'all', start_date: $('start-date').value, end_date: $('end-date').value });
const displayRange = value => value.all_history ? `全部历史 · 截至 ${value.end_date}` : `${value.start_date} — ${value.end_date}`;
const sizeLabel = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}
function button(label, className, callback, idle = false) {
  const element = node('button', className, label);
  element.type = 'button';
  if (idle) element.dataset.idle = '';
  element.addEventListener('click', callback);
  return element;
}
function notify(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function renderWhenChanged(id, value, render) {
  const signature = JSON.stringify(value);
  if (signatures.get(id) === signature) return;
  signatures.set(id, signature);
  $(id).replaceChildren(...render());
}
function syncControls() {
  const busy = submitting || active() || !snapshot;
  document.querySelectorAll('[data-idle], #scope input, #dates input, #article-url').forEach(element => { element.disabled = busy; });
  $('collect').disabled = busy || !enabledCount() || snapshot?.session.state !== 'ready';
  $('export').disabled = busy || !enabledCount() || !snapshot?.has_index;
  $('repair-links').disabled = busy || !enabledCount() || !snapshot?.has_index || snapshot?.session.state !== 'ready';
  $('cancel').disabled = cancelRequested || snapshot?.job?.state === 'cancelling';
  $('cancel').textContent = cancelRequested ? '正在停止…' : '停止任务';
  const all = collectionInput().all_history;
  $('dates').hidden = all;
  $('collect').textContent = all ? '抓取全部推文并下载 ZIP ↓' : '抓取所选日期推文并下载 ZIP ↓';
}

function renderAccounts() {
  $('account-count').textContent = `${enabledCount()} 个已选`;
  renderWhenChanged('accounts', snapshot.accounts, () => snapshot.accounts.length ? snapshot.accounts.map(account => {
    const row = node('div', 'account-row');
    const label = node('label', 'account-label');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = account.enabled !== false;
    checkbox.dataset.idle = '';
    checkbox.addEventListener('change', () => {
      const operation = checkbox.checked ? 'resume' : 'pause';
      checkbox.checked = account.enabled !== false;
      void act({ action: 'update', bookId: account.bookId, operation });
    });
    label.append(checkbox, node('span', '', account.name));
    const remove = button('移除', 'text-button remove', () => act({ action: 'update', bookId: account.bookId, operation: 'remove' }), true);
    remove.setAttribute('aria-label', `移除公众号 ${account.name}`);
    row.append(label, remove);
    return row;
  }) : [node('div', 'empty', '还没有公众号。粘贴文章链接，或从书架选择。')]);
  renderWhenChanged('shelf-list', [snapshot.books, snapshot.accounts], () => snapshot.books.length ? snapshot.books.map(book => {
    const row = node('div', 'shelf-row');
    const exists = snapshot.accounts.some(account => account.bookId === book.bookId);
    const add = button(exists ? '已添加' : '添加', 'text-button', () => act({ action: 'add', bookId: book.bookId }), !exists && !!book.readerUrl);
    if (exists || !book.readerUrl) add.disabled = true;
    if (!book.readerUrl) add.title = '微信读书暂未提供阅读入口';
    row.append(node('span', '', book.name), add);
    return row;
  }) : [node('p', 'muted small', '登录后点击“刷新书架”获取公众号。')]);
}

async function saveDownload(id, kind) {
  try { await download(id, kind); }
  catch (error) { notify(`下载失败：${error.message}`); throw error; }
}
function renderDownloads() {
  $('download-count').textContent = `${snapshot.exports.length} 份资料`;
  renderWhenChanged('downloads', snapshot.exports, () => snapshot.exports.length ? snapshot.exports.map(archive => {
    const row = node('article', 'download-row');
    const details = node('div', 'download-info');
    const title = node('div', 'download-title');
    title.append(node('h3', '', displayRange(archive)), node('span', `badge ${archive.complete ? 'success' : 'warning'}`, archive.complete ? '打包完成' : '含缺失项'));
    details.append(title, node('p', 'muted small', `目录 ${archive.article_count} 篇 · 正文 ${archive.body_count} 篇 · 配图 ${archive.image_count} 张 · ${sizeLabel(archive.size)}`));
    if(!archive.link_schema_version)details.append(node('p','small','旧版资料可能含失效原文链接。请修复并下载新生成的资料包。'));
    if (archive.issues?.length) {
      const disclosure = node('details', 'issues');
      disclosure.append(node('summary', '', `查看 ${archive.issues.length} 项说明`));
      const list = node('ul');
      archive.issues.forEach(issue => list.append(node('li', '', issue.message)));
      disclosure.append(list);
      details.append(disclosure);
    }
    const actions = node('div', 'buttons download-actions');
    for (const [kind, label] of [['zip', '下载 ZIP'], ['text', '合并文字'], ['index', '文章目录']]) {
      actions.append(button(label, kind === 'zip' ? '' : 'secondary', () => { void saveDownload(archive.id, kind).catch(() => {}); }));
    }
    row.append(details, actions);
    return row;
  }) : [node('div', 'empty download-empty', '完成第一次采集后，资料包会出现在这里。')]);
}

function renderJob() {
  const job = snapshot.job;
  const resumable = snapshot.resume_job;
  const canResume = !active() && resumable && ['paused', 'failed', 'cancelled'].includes(resumable.state);
  $('job-panel').hidden = !job && !canResume;
  $('cancel').hidden = !active();
  $('resume').hidden = !canResume;
  if (!job) return;
  $('job-state').textContent = ({ running: '正在处理', cancelling: '正在停止', complete: '已完成', failed: '任务未完成', paused: '等待继续', cancelled: '已停止' })[job.state] || '任务状态';
  $('job-message').textContent = job.message;
  $('job-panel').dataset.state = job.state;
  $('progress').hidden = !active();
  $('job-count').textContent = job.stage === 'body' && job.total ? `${job.completed} / ${job.total} 篇` : '';
  if (job.stage === 'body' && job.total) {
    $('progress').max = job.total;
    $('progress').value = job.completed;
  } else $('progress').removeAttribute('value');
}

async function autoDownload() {
  const job = snapshot.job;
  if (downloading || !job || job.state !== 'complete' || sessionStorage.getItem(pendingKey) !== job.id || !job.result?.archive_id) return;
  downloading = true;
  sessionStorage.removeItem(pendingKey);
  try { await saveDownload(job.result.archive_id, 'zip'); }
  catch { /* The explicit download buttons remain available. */ }
  finally { downloading = false; }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const previousJob = snapshot?.job?.id;
    snapshot = await status();
    if (snapshot.job?.id !== previousJob || !active()) cancelRequested = false;
    const session = snapshot.session;
    $('login-state').textContent = session.state === 'ready' ? '微信读书已登录' : session.state === 'verification' ? '需要完成验证' : '等待登录微信读书';
    $('login-dot').classList.toggle('ready', session.state === 'ready');
    $('session-message').textContent = session.message;
    $('login').textContent = session.state === 'ready' ? '重新扫码' : '微信扫码登录';
    $('qr-panel').hidden = !snapshot.login;
    const qr = snapshot.login?.qr_data;
    $('qr').hidden = !qr;
    if (qr && /^data:image\//.test(qr) && $('qr').getAttribute('src') !== qr) $('qr').src = qr;
    if (!qr) $('qr').removeAttribute('src');
    $('qr-message').textContent = snapshot.login?.message || '';
    renderAccounts();
    renderDownloads();
    renderJob();
    syncControls();
    await autoDownload();
  } catch (error) { notify(`读取状态失败：${error.message}`); }
  finally { refreshing = false; }
}

async function act(input, automatic = false) {
  if (submitting || active()) return;
  submitting = true;
  notify();
  syncControls();
  try {
    const result = await start(input);
    if (automatic) sessionStorage.setItem(pendingKey, result.job_id);
  } catch (error) { notify(error.message); }
  finally {
    submitting = false;
    await refresh();
    syncControls();
  }
}

$('end-date').value = today();
$('start-date').value = today().slice(0, 8) + '01';
for (const action of ['login', 'check', 'shelf', 'logout']) $(action).addEventListener('click', () => { void act({ action }); });
$('browser').addEventListener('click', async () => {
  try { await openBrowser(); } catch (error) { notify(error.message); }
});
$('add-form').addEventListener('submit', event => {
  event.preventDefault();
  void act({ action: 'resolve', url: $('article-url').value.trim() });
});
$('scope').addEventListener('change', syncControls);
$('collect').addEventListener('click', () => { void act({ action: 'collect', ...collectionInput() }, true); });
$('export').addEventListener('click', () => { void act({ action: 'export', ...collectionInput() }, true); });
$('repair-links').addEventListener('click', () => { void act({ action: 'repair-links', ...collectionInput() }, true); });
$('resume').addEventListener('click', () => { void act({ action: 'resume', job_id: snapshot.resume_job.id }, true); });
$('cancel').addEventListener('click', async () => {
  if (!active() || cancelRequested) return;
  cancelRequested = true;
  syncControls();
  try { await request('/local-api/collector/cancel', { body: JSON.stringify({ job_id: snapshot.job.id }) }); }
  catch (error) { cancelRequested = false; notify(error.message); }
  await refresh();
});
window.addEventListener('beforeunload', event => {
  if (active()) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
syncControls();
void refresh();
setInterval(() => { void refresh(); }, 1200);
