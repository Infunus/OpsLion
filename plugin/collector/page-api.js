/** Runs only on official pages through chrome.scripting; no eval or downloaded code. */
export async function inReader(action, args = {}) {
  const visible = node => {
    for (let parent = node; parent; parent = parent.parentElement) {
      const s = getComputedStyle(parent);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const text = document.body?.innerText || '';
  const verification = [...document.querySelectorAll('[id*="captcha"],[class*="tcaptcha"],iframe[src*="captcha"]')].some(visible)
    || !document.querySelector('#js_content,.rich_media_content') && text.length < 1500 && /当前环境异常[，,]?\s*完成验证|请完成(?:安全|人机)验证|人机验证|请(?:拖动|移动).{0,8}滑块/.test(text);
  if (verification) return { ok: false, code: 'verification', error: '请在阅读页面完成人机验证。' };
  if (location.origin !== 'https://weread.qq.com') return { ok: false, code: 'wrong_page', error: '阅读入口已离开微信读书，请重新打开。' };
  if (action === 'probe') return { ok: true, ready: document.readyState === 'complete' && (!!document.body?.children.length), reader: location.pathname.startsWith('/web/mp/reader/'), title: document.title };
  if (action === 'login') {
    const login = [...document.querySelectorAll('.wr_index_page_top_section_header_action_link')].find(el => visible(el) && el.textContent.trim() === '登录');
    const image = document.querySelector('img.wr_login_modal_qr_img');
    const modal = image?.closest('[class*="login_modal"]') || document.querySelector('[class*="login_modal"]');
    if (modal && /二维码.*(?:过期|失效)/.test(modal.innerText)) return { ok: true, state: 'expired' };
    const frame = [...document.querySelectorAll('iframe')].find(el => { try { const u = new URL(el.src); return u.origin === 'https://open.weixin.qq.com' && u.pathname === '/connect/qrconnect' && visible(el); } catch { return false; } });
    if (login && !frame && !(modal && visible(modal))) login.click();
    if (image && visible(image)) {
      try {
        const u = new URL(image.currentSrc || image.src, location.href);
        if (u.origin === location.origin || u.origin === 'https://open.weixin.qq.com' || u.protocol === 'data:') {
          const blob = await (await fetch(u.href)).blob();
          if (blob.size < 512 * 1024 && blob.type.startsWith('image/')) {
            const data = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
            return { ok: true, state: 'qr', data };
          }
        }
      } catch { /* The real login tab remains available if the image is protected. */ }
    }
    if (frame) return { ok: true, state: 'frame' };
    const loggedIn = document.cookie.split(';').some(value => /^\s*wr_vid=[1-9]\d*/.test(value));
    return { ok: true, state: loggedIn && !login && (!image || !visible(image)) && !frame ? 'ready' : 'loading' };
  }
  const request = async (url, init = {}) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, { ...init, credentials: 'include', signal: controller.signal });
      const raw = await response.text();
      if (raw.length > 10_000_000) return { ok: false, code: 'too_large', error: '单篇响应过大，已保留采集进度。' };
      if (/当前环境异常[，,]?\s*完成验证|请完成(?:安全|人机)验证/.test(raw) && !/id=["']js_content|class=["']rich_media_content/.test(raw)) return { ok: false, code: 'verification', error: '接口要求验证，请在打开的页面完成。', verificationUrl: response.url };
      if (!response.ok) return { ok: false, code: response.status, error: `接口返回 HTTP ${response.status}` };
      return { ok: true, raw };
    } catch (error) { return { ok: false, code: error.name === 'AbortError' ? 'timeout' : 'network', error: '请求超时或网络不可用，已保留进度。' }; }
    finally { clearTimeout(timer); }
  };
  if (['page','body'].includes(action) && !location.pathname.startsWith('/web/mp/reader/')) return { ok: false, code: 'wrong_page', error: '需要在公众号阅读页中采集。' };
  let url, init;
  if (action === 'shelf') url = '/web/shelf/sync?synckey=0&teenmode=0&album=1';
  else if (action === 'add' && /^MP_WXS_\d+$/.test(args.bookId)) { url = '/mp/shelf/addToShelf'; init = { method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify({ bookIds: [args.bookId] }) }; }
  else if (action === 'page' && /^MP_WXS_\d+$/.test(args.bookId) && Number.isSafeInteger(args.offset) && args.offset >= 0) url = `/web/mp/articles?bookId=${encodeURIComponent(args.bookId)}&offset=${args.offset}`;
  else if (action === 'body' && /^MP_WXS_\d+_[A-Za-z0-9_~-]+$/.test(args.rid)) url = '/web/mp/content?reviewId=' + encodeURIComponent(args.rid);
  else return { ok: false, code: 'invalid_action', error: '无效的采集请求。' };
  const result = await request(url, init);
  if (!result.ok) return result;
  if (action === 'body' && !/^\s*\{/.test(result.raw)) return result;
  let data;
  try { data = JSON.parse(result.raw); } catch { return { ok: false, code: 'invalid_json', error: '接口没有返回有效数据，请检查登录。' }; }
  if (data.errCode || data.errcode) return { ok: false, code: data.errCode || data.errcode, error: `微信读书接口返回 ${data.errCode || data.errcode}，请检查登录或稍后继续。` };
  if (action === 'body') return { ok: false, code: 'unexpected_json', error: '正文接口未返回文章。' };
  if (action === 'shelf') {
    if (!Array.isArray(data.books)) return { ok: false, code: 'invalid_shelf', error: '无法识别书架响应。' };
    return { ok: true, books: data.books.filter(book => /^MP_WXS_\d+$/.test(book.bookId)).map(book => {
      const hash = String(book.deepLink || '').match(/[?&]v=([\da-z]+)/i)?.[1];
      return { name: String(book.title || '公众号'), bookId: book.bookId, readerUrl: hash ? 'https://weread.qq.com/web/mp/reader/' + hash : null };
    }) };
  }
  if (action === 'add') return { ok: true };
  if (!Array.isArray(data.reviews)) return { ok: false, code: 'invalid_page', error: '目录缺少分页数据，未判定为历史结束。' };
  const items = [];
  for (const group of data.reviews) for (const sub of group.subReviews || []) {
    const review = sub.review || {}, info = review.mpInfo || {};
    if (!info.title) continue;
    const short = typeof info.originalId === 'string' && /^[A-Za-z0-9_~-]{22}$/.test(info.originalId);
    items.push({ t: Number(review.createTime || group.createTime || 0), title: String(info.title), rid: String(review.reviewId || ''), url: short ? 'https://mp.weixin.qq.com/s/' + info.originalId.replace(/~/g, '_') : '', linkStatus: short ? 'short_token' : 'unresolved' });
  }
  return { ok: true, reviews: data.reviews.length, items };
}

export async function loginFrameQr() {
  if (location.origin !== 'https://open.weixin.qq.com' || location.pathname !== '/connect/qrconnect') return null;
  const image = document.querySelector('img.qrcode');
  if (!image?.complete) return null;
  const url = new URL(image.src, location.href);
  if (url.origin !== location.origin) return null;
  try {
    const response = await fetch(url.href); const blob = await response.blob();
    if (blob.size > 512 * 1024 || !blob.type.startsWith('image/')) return null;
    return await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
  } catch { return null; }
}
