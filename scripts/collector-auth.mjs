import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERIFICATION_PROBE_JS, verificationRequired } from './collector-verification.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };

// Inspect login UI; do not persist cookie values or QR payload URLs.
export const LOGIN_PROBE_JS = `(() => {
  if (${VERIFICATION_PROBE_JS}) return { state: 'verification' };
  if (location.origin !== 'https://weread.qq.com') return { state: 'loading' };
  const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x + scrollX,y:r.y + scrollY,width:r.width,height:r.height}; };
  const login = [...document.querySelectorAll('.wr_index_page_top_section_header_action_link')].find(el => visible(el) && el.textContent.trim() === '登录');
  const image = document.querySelector('img.wr_login_modal_qr_img');
  const frame = [...document.querySelectorAll('iframe')].find(el => { try { const u = new URL(el.src);return u.origin === 'https://open.weixin.qq.com' && u.pathname === '/connect/qrconnect' && visible(el); } catch {return false;} });
  const imageReady = visible(image) && image.complete && image.naturalWidth >= 80;
  const modal = image?.closest('[class*="login_modal"]');
  if (visible(modal) && /二维码.*(?:过期|失效)/.test(modal.innerText)) return {state:'expired'};
  const hasSession = document.cookie.split(';').some(part => /^\\s*wr_vid=[1-9]\\d*/.test(part));
  if (hasSession && !login && !imageReady && !frame) return {state:'ready'};
  if (imageReady) return {state:'qr',rect:rect(image),key:image.currentSrc};
  if (frame) return {state:'frame',rect:rect(frame)};
  return {state: login ? 'login' : 'loading'};
})()`;
export const CLICK_LOGIN_JS = `(() => { const el = [...document.querySelectorAll('.wr_index_page_top_section_header_action_link')].find(el => el.textContent.trim() === '登录'); if(el) el.click(); })()`;

async function frameQr(session, target, frameRectangle) {
  const {targetInfos}=await session.send('Target.getTargets');
  const frame=targetInfos.find(item=>{try {const u=new URL(item.url);return item.type==='iframe' && u.origin==='https://open.weixin.qq.com' && u.pathname==='/connect/qrconnect';}catch{return false;}});
  const {sessionId}=await session.send('Target.attachToTarget',{targetId:frame?.targetId || target,flatten:true});
  try {
    let contextId;
    if(!frame) {
      const {frameTree}=await session.send('Page.getFrameTree',{},sessionId,5000);
      const visit=node=> {try{const u=new URL(node.frame.url);if(u.origin==='https://open.weixin.qq.com' && u.pathname==='/connect/qrconnect')return node.frame.id;}catch{/* Continue to child frames. */}for(const child of node.childFrames || []){const id=visit(child);if(id)return id;}};
      const frameId=visit(frameTree);if(!frameId)return {state:'loading'};
      contextId=(await session.send('Page.createIsolatedWorld',{frameId,worldName:'opslion-login-view'},sessionId,5000)).executionContextId;
    }
    const value=await session.send('Runtime.evaluate',{returnByValue:true,contextId,expression:`(() => {
      if(location.origin!=='https://open.weixin.qq.com'||location.pathname!=='/connect/qrconnect')return null;
      const text=document.body.innerText;
      if(${VERIFICATION_PROBE_JS})return {state:'verification'};
      if(/二维码.*(?:过期|失效)/.test(text))return {state:'expired'};
      const image=[...document.images].find(im=>im.complete&&im.naturalWidth>=100&&im.getBoundingClientRect().width>80&&(im.classList.contains('qrcode')||im.alt.includes('二维码')||im.src.includes('/connect/qrcode/')));
      if(!image)return null;
      const r=image.getBoundingClientRect();return {state:'qr',x:r.x,y:r.y,width:r.width,height:r.height,viewport:innerWidth,key:image.currentSrc};
    })()`},sessionId,5000);
    const image=value.result?.value;
    if(!image)return {state:'loading'};
    if(image.state!=='qr')return image;
    const scale=frameRectangle.width/image.viewport;
    return {state:'qr',key:image.key,rect:{x:frameRectangle.x+image.x*scale,y:frameRectangle.y+image.y*scale,width:image.width*scale,height:image.height*scale}};
  } finally {await session.send('Target.detachFromTarget',{sessionId}).catch(()=>{});}
}

export async function captureQr(session, target, rectangle, output) {
  const { x, y, width, height } = rectangle;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 80 || height < 80 || width > 650 || height > 650) throw new Error('登录二维码区域不可用，请使用默认浏览器完成登录。');
  const { sessionId } = await session.send('Target.attachToTarget', { targetId: target, flatten: true });
  try {
    const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: Math.max(0, x - 10), y: Math.max(0, y - 10), width: width + 20, height: height + 20, scale: 2 } }, sessionId, 10000);
    const image = Buffer.from(shot.data, 'base64');
    if (image.length < 500 || image.length > 2 * 1024 * 1024 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('二维码图片尚未加载，请重试。');
    fs.writeFileSync(output + '.tmp', image); fs.renameSync(output + '.tmp', output);
  } finally { await session.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}

export async function runLogin(settings, config, input, progress) {
  const cdp = await import(pathToFileURL(path.join(settings.source, 'lib/cdp.mjs')).href);
  const session = await cdp.connectChrome({ port: config.chromePort, profileDir: config.chromeProfileDir });
  const file = path.join(settings.runtime, 'login.json'), image = path.join(settings.runtime, 'login-qr.png');
  const state = { id: input.job_id, state: 'loading', message: '正在取得登录二维码…', qr_available: false, revision: 0, expires_at: Date.now() + 300000 };
  const update = (patch) => { Object.assign(state, patch); save(file, state); };
  let target, clicks = 0, clickedAt = 0, fingerprint = '', displayed = false;
  const started = Date.now();
  const parent = process.ppid;
  const cancelled = () => {
    if (fs.existsSync(input.cancel_file)) return true;
    try { process.kill(parent, 0); return false; } catch { return true; }
  };
  try {
    update({});
    const tabs = await cdp.listTabs(session);
    target = tabs.find(tab => tab.url === 'https://weread.qq.com/')?.targetId || await cdp.createTab(session, 'https://weread.qq.com/');
    while (Date.now() < state.expires_at) {
      if (cancelled()) { update({state:'cancelled',qr_available:false,message:'已停止扫码。'}); return {state:'cancelled',message:state.message}; }
      let probe = await cdp.evaluate(session, target, LOGIN_PROBE_JS, 6000);
      if(probe.state==='frame')probe=await frameQr(session,target,probe.rect);
      if (probe.state === 'ready') {
        update({state:'ready',qr_available:false,message:'登录完成，会话已保存到本机。'});
        save(path.join(settings.runtime, 'session.json'), {state:'ready',message:state.message,checked_at:new Date().toISOString()});
        return {message:state.message};
      }
      if (['verification','expired'].includes(probe.state)) {
        update({state:probe.state,qr_available:false,message:probe.state === 'expired' ? '二维码已过期，请重新获取。' : '检测到人机验证，正在打开默认浏览器…'});
        if (probe.state === 'verification') {
          const tab = (await cdp.listTabs(session)).find(item => item.targetId === target);
          verificationRequired(settings, target, tab?.url, 'login');
          return {state:'paused',code:'verification',message:state.message};
        }
        return {state:'paused',message:state.message};
      }
      if (probe.state === 'login' && clicks < 3 && Date.now()-clickedAt > 2500) { await cdp.evaluate(session,target,CLICK_LOGIN_JS,5000);clicks++;clickedAt=Date.now(); }
      if (probe.state === 'qr') {
        if (!displayed) {
          await pause(1200);
          if (cancelled()) continue;
          probe=await cdp.evaluate(session,target,LOGIN_PROBE_JS,6000);
          if(probe.state==='frame')probe=await frameQr(session,target,probe.rect);
          if(probe.state!=='qr')continue;
        }
        const hash=createHash('sha256').update(probe.key).digest('hex');
        if (hash !== fingerprint) {
          await captureQr(session,target,probe.rect,image);
          fingerprint=hash;displayed=true;
          update({state:'waiting',qr_available:true,revision:state.revision+1,message:'请使用微信扫一扫，并在手机上确认登录。'});
          progress('login',state.message);
        }
      }
      if (!displayed && Date.now()-started>35000) throw new Error('登录页面暂未显示二维码，可重试或使用默认浏览器登录。');
      await pause(displayed ? 1800 : 500);
    }
    update({state:'expired',qr_available:false,message:'二维码已过期，请重新获取。'});
    return {state:'paused',message:state.message};
  } catch (error) { update({state:'failed',qr_available:false,message:'二维码登录未完成，可重试或使用默认浏览器。'});throw error; }
  finally {
    if (!['ready','verification'].includes(state.state) && target) await session.send('Target.closeTarget',{targetId:target},undefined,3000).catch(()=>{});
    if (!state.qr_available) fs.rmSync(image,{force:true});
    session.close();
  }
}

if (process.argv[2] === 'close' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config=JSON.parse(fs.readFileSync(process.argv[3],'utf8').replace(/^\uFEFF/,''));
  const cdp=await import('../integrations/weread-mp-fetcher/lib/cdp.mjs');
  const session=await cdp.connectChrome({port:config.chromePort,profileDir:config.chromeProfileDir});
  try {await session.send('Browser.close',{},undefined,2000).catch(()=>{});} finally {session.close();}
}
