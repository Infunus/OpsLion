import { inReader, loginFrameQr } from './page-api.js';
import { get, put } from './store.js';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function safeReader(value) {
  try { const u = new URL(value); return u.origin === 'https://weread.qq.com' && !u.username && !u.password && (/^\/web\/mp\/reader\/[a-z\d]+$/i.test(u.pathname) || u.pathname === '/') ? u.href : null; } catch { return null; }
}
export function safeVerification(value) {
  try { const u = new URL(value); return u.origin === 'https://weread.qq.com' && !u.username && !u.password && (u.pathname === '/' || u.pathname.startsWith('/web/')) ? u.href : null; } catch { return null; }
}
async function call(tabId, action, args) {
  // Bound the injection too: a frozen or closed tab must not hang the job forever.
  let timer;
  try {
    return await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: inReader, args: [action, args || {}] }).then(rows => { if (!rows[0]?.result) throw new Error('无法读取微信读书页面。'); return rows[0].result; }),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('阅读页响应超时，请保持页面打开后继续。')),35000);}),
    ]);
  } finally { clearTimeout(timer); }
}
export class BrowserTransport {
  constructor(cancelled = () => false) { this.cancelled = cancelled; this.lastRequest = 0; }
  async tab(url, active = false) {
    if (!safeReader(url)) throw new Error('无效的阅读入口。');
    const saved = await get('meta','readerTab');
    let tab = saved && await chrome.tabs.get(saved).catch(()=>null);
    if (!tab || !safeVerification(tab.url)) tab = await chrome.tabs.create({ url, active });
    else if (tab.url !== url) tab = await chrome.tabs.update(tab.id,{ url, active });
    else if (active) await chrome.tabs.update(tab.id,{ active:true });
    await chrome.tabs.update(tab.id,{autoDiscardable:false});
    await put('meta','readerTab',tab.id); this.tabId=tab.id;
    const start=Date.now();
    while (Date.now()-start<90000) {
      if (await this.cancelled()) throw Object.assign(new Error('已停止。'),{code:'cancelled'});
      const current=await chrome.tabs.get(tab.id);
      if (current.status==='complete') {
        const probe=await call(tab.id,'probe');
        if (probe.code==='verification') await this.challenge(probe);
        if (probe.ok && probe.ready) return tab.id;
      }
      await sleep(500);
    }
    throw new Error('阅读入口在 90 秒内未加载完成，请打开阅读页面后继续。');
  }
  async challenge(result) {
    const url=safeVerification(result.verificationUrl);
    // Reuse our own tab and retain its authenticated browser context.
    await chrome.tabs.update(this.tabId,{active:true,...(url?{url}:{})});
    const tab=await chrome.tabs.get(this.tabId);await chrome.windows.update(tab.windowId,{focused:true});
    await put('meta','verification',{tabId:this.tabId,url:url || tab.url});
    throw Object.assign(new Error('已打开当前浏览器的验证页面。完成验证后回采集台继续上次任务。'),{code:'verification',browser_opened:true});
  }
  async request(action,args = {}) {
    const elapsed=Date.now()-this.lastRequest;
    if (elapsed<3000) await sleep(3000-elapsed);
    if (await this.cancelled()) throw Object.assign(new Error('已停止，进度已保存。'),{code:'cancelled'});
    const probe=await call(this.tabId,'probe');if (probe.code==='verification') await this.challenge(probe);
    this.lastRequest=Date.now();
    const result=await call(this.tabId,action,args);
    const usage=await get('meta','usage') || {used:0,runs:0};usage.used++;await put('meta','usage',usage);
    if (result.code==='verification') await this.challenge(result);
    if (!result.ok) throw Object.assign(new Error(result.error || '微信读书接口返回异常。'),{code:result.code});
    return result;
  }
  async loginProbe() {
    const result=await call(this.tabId,'login');if(result.code==='verification')await this.challenge(result);
    if(result.state==='frame') {
      const frames=await chrome.scripting.executeScript({target:{tabId:this.tabId,allFrames:true},func:loginFrameQr}).catch(()=>[]);
      const data=frames.find(row=>typeof row.result==='string' && row.result.startsWith('data:image/'))?.result;
      if(data)return {ok:true,state:'qr',data};
    }
    return result;
  }
  async show() {
    const verification=await get('meta','verification');
    const id=verification?.tabId || await get('meta','readerTab');
    const tab=id && await chrome.tabs.get(id).catch(()=>null);
    if(tab && safeVerification(tab.url)) { await chrome.tabs.update(id,{active:true});await chrome.windows.update(tab.windowId,{focused:true}); }
    else await this.tab('https://weread.qq.com/',true);
  }
}
