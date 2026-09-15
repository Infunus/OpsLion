import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };

// Completed Tencent challenges remain in the DOM, hidden by their ancestors.
export const VERIFICATION_PROBE_JS = `(() => {
  const visible = node => {
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
  };
  if ([...document.querySelectorAll('[id*="captcha"], [class*="tcaptcha"], iframe[src*="captcha"]')].some(visible)) return true;
  const text = document.body?.innerText || '';
  return !document.querySelector('#js_content,.rich_media_content') && text.length < 1500
    && /当前环境异常[，,]?\\s*完成验证|请完成(?:安全|人机)验证|人机验证|请(?:拖动|移动).{0,8}滑块/.test(text);
})()`;

export function safeVerificationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 8192) return null;
    if (url.hostname === 'weread.qq.com' && (url.pathname === '/' || url.pathname.startsWith('/web/'))
      || url.hostname === 'open.weixin.qq.com' && url.pathname === '/connect/qrconnect'
      || url.hostname === 'mp.weixin.qq.com' && (/^\/s(?:\/[-\w]+)?\/?$/.test(url.pathname) || url.pathname === '/mp/verify')) return url.href;
  } catch { /* Never open untrusted or local URLs from a response. */ }
  return null;
}

export function verificationRequired(settings, targetId, url, kind = 'reader') {
  // OAuth URLs and tab IDs stay in the private runtime, never in status or exports.
  save(path.join(settings.runtime, 'verification.json'), {
    id: randomUUID(), state: 'pending', kind, target_id: targetId,
    url: safeVerificationUrl(url) || 'https://weread.qq.com/', created_at: Date.now(),
  });
  return Object.assign(new Error('检测到人机验证，已暂停请求，正在打开默认浏览器…'), { code: 'verification' });
}

export async function assertNoVerification(settings, cdp, session, target, kind = 'reader') {
  if (await cdp.evaluate(session, target, VERIFICATION_PROBE_JS, 6000)) {
    const tab = (await cdp.listTabs(session)).find((item) => item.targetId === target);
    throw verificationRequired(settings, target, tab?.url, kind);
  }
}

export async function waitForReader(settings, cdp, session, target, probeScript, isCancelled = () => false) {
  const started = Date.now();
  let deadline = started + 15000;
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error('已停止等待阅读页面，进度已保留。');
    const probe = JSON.parse(await cdp.evaluate(session, target, probeScript));
    await assertNoVerification(settings, cdp, session, target);
    if (probe.verdict === 'ready') return;
    if (probe.capArming) deadline = started + 75000;
    if (probe.verdict !== 'loading') throw new Error('公众号阅读页面尚未就绪，请检查登录后继续。');
    await pause(1500);
  }
  throw new Error('公众号阅读页面加载超时，请检查网络后继续。');
}

export async function presentVerification(settings, config) {
  const file = path.join(settings.runtime, 'verification.json');
  const verification = JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = safeVerificationUrl(verification.url);
  if (!url) throw new Error('验证页面地址无效，请重新扫码登录。');
  const cdp = await import(pathToFileURL(path.join(settings.source, 'lib/cdp.mjs')).href);
  const session = await cdp.connectChrome({ port: config.chromePort, profileDir: config.chromeProfileDir });
  try {
    const tabs = await cdp.listTabs(session);
    const old = tabs.find((tab) => tab.targetId === verification.target_id && safeVerificationUrl(tab.url));
    const target = old?.targetId || tabs.find((tab) => tab.url === url)?.targetId || await cdp.createTab(session, url);
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: target });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Target.activateTarget', { targetId: target });
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: target, flatten: true });
    try { await session.send('Page.bringToFront', {}, sessionId); }
    finally { await session.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
    // A headless-to-visible switch reloads the page with the same saved profile.
    // Reopen the login dialog if needed; never interact with the challenge itself.
    if (!old && verification.kind === 'login' && new URL(url).origin === 'https://weread.qq.com') {
      const { LOGIN_PROBE_JS, CLICK_LOGIN_JS } = await import('./collector-auth.mjs');
      for (let attempt = 0; attempt < 12; attempt++) {
        const probe = await cdp.evaluate(session, target, LOGIN_PROBE_JS, 6000);
        if (probe.state === 'login') { await cdp.evaluate(session, target, CLICK_LOGIN_JS); break; }
        if (probe.state !== 'loading') break;
        await pause(500);
      }
    }
    save(file, { ...verification, target_id: target, state: 'opened' });
  } finally { session.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
    await presentVerification({ runtime: process.env.OPSLION_COLLECTOR_DATA_DIR, source: process.env.OPSLION_COLLECTOR_SOURCE }, config);
    process.stdout.write(JSON.stringify({ opened: true }));
  } catch { process.stderr.write('验证页面未能打开，请点击“重新打开验证页面”重试。'); process.exitCode = 1; }
}
