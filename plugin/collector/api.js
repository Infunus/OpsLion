import JSZip from '../vendor/jszip.js';
import { get, put } from './store.js';
import { BrowserTransport, safeReader, sleep } from './transport.js';
import { parseBody, markdownBody, safeImage } from './content.js';
import { normalizeRange, sourceCovered, inDateRange } from './range.js';
import { existingLink, extractLink, validateMetadata, linkReasonText } from './links.js';
export { validateRange, inDateRange } from './range.js';

const LOCK='opslion-collector-job';
const urls=new Map();
const initial=()=>({accounts:[],session:{state:'unknown',message:'等待登录'},job:null,resume_job:null,exports:[]});
const readState=async()=>await get('meta','state') || initial();
const saveState=state=>put('meta','state',state);
export function articleUrl(value) {
  const u=new URL(value);if(u.origin!=='https://mp.weixin.qq.com' || u.username || u.password || !/^\/s(?:\/[-\w]+)?\/?$/.test(u.pathname))throw new Error('请粘贴 https://mp.weixin.qq.com/ 开头的公众号文章链接。');return u;
}
export function bookIdFrom(value) {
  const match=value.match(/var\s+biz\s*=\s*["']([A-Za-z\d+/=]+)["']/) || value.match(/__biz=([A-Za-z\d+/=%]+)/);
  if(!match)return null;
  try { const id=atob(decodeURIComponent(match[1]));return /^\d+$/.test(id)?'MP_WXS_'+id:null; }catch{return null;}
}
async function fetchImage(source) {
  const url=safeImage(source);if(!url)throw new Error('配图地址不在允许的来源内。');
  const cached=await get('images',url);if(cached)return cached;
  const response=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(25000),referrerPolicy:'no-referrer'});
  if(!response.ok || !safeImage(response.url))throw new Error('配图未能下载。');
  const blob=await response.blob();if(blob.size>12*1024*1024 || !/^image\/(png|jpeg|gif|webp|avif)$/.test(blob.type))throw new Error('配图格式或大小不受支持。');
  await put('images',url,blob);return blob;
}
async function progress(job,patch) {
  Object.assign(job,patch);const state=await readState();state.job=job;
  if(['collect','export','repair-links'].includes(job.action))state.resume_job=job;
  await saveState(state);
}
async function session(value) {const state=await readState();state.session=value;await saveState(state);}
async function shelf(client) {
  const result=await client.request('shelf');await put('meta','shelf',result.books);
  await session({state:'ready',message:'已登录微信读书。'});await put('meta','verification',null);return result.books;
}
async function scan(job,client,cancelled) {
  const state=await readState();const accounts=state.accounts.filter(account=>account.enabled!==false);
  if(!accounts.length)throw new Error('请添加并启用公众号。');
  let index=await get('meta','index');
  if(!job.input.resume || index?.start_date!==job.input.start_date || index?.end_date!==job.input.end_date || !!index?.all_history!==!!job.input.all_history) index={...job.input,collected_at:new Date().toISOString(),sources:[]};
  index.sources=accounts.map(account=>({...(index.sources.find(source=>source.bookId===account.bookId) || {items:[],offset:0,ended:false}),...account,err:null}));
  const covered=source=>sourceCovered(source,job.input);
  await put('meta','index',index);
  for(const source of index.sources) {
    if(covered(source))continue;
    try {
      if(!safeReader(source.readerUrl))throw new Error('公众号缺少阅读入口，请重新添加。');
      await progress(job,{stage:'reader',message:`正在打开 ${source.name} 的阅读入口…`});await client.tab(source.readerUrl);
      while(!covered(source)) {
        if(await cancelled())throw Object.assign(new Error('已停止目录采集。'),{code:'cancelled'});
        await progress(job,{stage:'index',message:`正在读取 ${source.name} 的目录（已取得 ${source.items.length} 篇）…`});
        const page=await client.request('page',{bookId:source.bookId,offset:source.offset});
        if(!Array.isArray(page.items) || !Number.isSafeInteger(page.reviews) || page.reviews<0)throw new Error('目录分页格式无效，进度已保留。');
        if(page.reviews>0 && (!page.items.length || page.items.every(item=>source.items.some(old=>old.rid===item.rid))))throw new Error('目录重复或没有可用文章，未能确认更早日期，请稍后继续。');
        for(const item of page.items) {
          if(!/^MP_WXS_\d+_[A-Za-z\d_~-]+$/.test(item.rid) || !Number.isFinite(item.t) || item.t<=0)throw new Error('目录含无效文章标识或日期。');
          if(item.url)articleUrl(item.url);
          if(!source.items.some(old=>old.rid===item.rid))source.items.push(item);
        }
        source.offset+=page.reviews;source.ended=page.reviews===0;source.covered=covered(source);
        await put('meta','index',index);
      }
      source.covered=true;await put('meta','index',index);
    }catch(error) {source.err=error.message;await put('meta','index',index);throw error;}
  }
  const usage=await get('meta','usage') || {used:0,runs:0};usage.runs++;await put('meta','usage',usage);
  return index;
}
async function savedLink(item,bookId) {
  const stored=await get('meta','article-link:'+item.rid);
  if(stored?.url) {
    const checked=validateMetadata(item,bookId,{ok:true,url:stored.url,title:stored.title});
    if(checked.url)return checked;
  }
  return existingLink(item,bookId);
}
async function bodies(job,index,client,cancelled,linksOnly=false) {
  const enabled=new Set((await readState()).accounts.filter(row=>row.enabled!==false).map(row=>row.bookId));
  const items=index.sources.filter(source=>enabled.has(source.bookId)).flatMap(source=>source.items.filter(item=>inDateRange(item,job.input.start_date,job.input.end_date)).map(item=>({...item,entry:item,account:source.name,readerUrl:source.readerUrl,bookId:source.bookId})));
  for(const [i,item] of items.entries()) {
    if(await cancelled())throw Object.assign(new Error('已停止正文采集。'),{code:'cancelled'});
    const cached=await get('bodies',item.rid);
    let link=await savedLink(item,item.bookId);
    Object.assign(item.entry,link);if(link.url)delete item.entry.linkReason;
    await put('meta','index',index);
    if((cached || linksOnly) && link.url) {await progress(job,{completed:i+1,total:items.length});continue;}
    await progress(job,{stage:'body',message:`${cached || linksOnly?'正在补取原文链接':'正在读取正文和原文链接'}：${item.title}`,completed:i,total:items.length});
    try {
      const tab=client.tabId && await chrome.tabs.get(client.tabId).catch(()=>null);
      if(!tab || tab.url!==item.readerUrl)await client.tab(item.readerUrl);
      const response=await client.request('body',{rid:item.rid});
      const extracted=extractLink(response.raw,item,item.bookId);
      if(extracted.linkReason==='verification_page')await client.challenge({});
      if(extracted.url || !link.url)link=extracted;
      Object.assign(item.entry,link);if(link.url)delete item.entry.linkReason;
      await put('meta','index',index);
      if(extracted.url)await put('meta','article-link:'+item.rid,{...extracted,title:item.title});
      if(['title_mismatch','publisher_mismatch','invalid_review_id','ambiguous_meta'].includes(extracted.linkReason)) {
        throw Object.assign(new Error(linkReasonText(extracted.linkReason)+'，已保留进度，请核对后继续。'),{code:'link_identity'});
      }
      if(!cached && !linksOnly) {
        const body=parseBody(response.raw);
        await put('bodies',item.rid,{...body,collected_at:new Date().toISOString()});
        await put('meta','body-error:'+item.rid,null);
      }
    }catch(error) {
      if(!cached && !linksOnly)await put('meta','body-error:'+item.rid,error.message);
      if(!link.url) {item.entry.linkReason=error.code==='link_identity'?link.linkReason:'request_failed';await put('meta','index',index);}
      // Unavailable individual posts must not hide later posts. Authentication,
      // verification and network failures still pause the job for a retry.
      if(!['body_unavailable',404,410].includes(error.code))throw error;
    }
    await progress(job,{completed:i+1});
  }
}
async function packageArchive(job,cancelled) {
  const index=await get('meta','index');if(!index)throw new Error('暂无文章目录，请先采集。');
  const state=await readState();const enabled=new Set(state.accounts.filter(row=>row.enabled!==false).map(row=>row.bookId));
  if(!enabled.size)throw new Error('请启用要导出的公众号。');
  const zip=new JSZip(),issues=[],articles=[],skipped=[],assets=[],sourceRecords=[];let number=0;
  for(const account of state.accounts.filter(row=>enabled.has(row.bookId))) {
    const source=index.sources.find(row=>row.bookId===account.bookId);
    if(!source) {issues.push({type:'coverage',message:`${account.name} 尚未取得目录`});continue;}
    if(index.start_date>job.input.start_date || index.end_date<job.input.end_date || !sourceCovered(source,job.input))issues.push({type:'coverage',message:`${source.name} 的目录尚未覆盖所选范围`});
    if(source.err)issues.push({type:'source',message:source.name+'：'+source.err});
    const selected=source.items.filter(item=>inDateRange(item,job.input.start_date,job.input.end_date));
    sourceRecords.push({name:source.name,bookId:source.bookId,count:selected.length});
    for(const original of selected) {
      if(await cancelled())throw Object.assign(new Error('已停止打包。'),{code:'cancelled'});
      const item={...original,...await savedLink(original,source.bookId)};
      if(item.url)delete item.linkReason;
      else issues.push({type:'link',rid:item.rid,message:`${item.title}：原文链接未取得（${linkReasonText(item.linkReason)}）`});
      const body=await get('bodies',item.rid);
      if(body?.content_kind==='video') {
        skipped.push({title:item.title,url:item.url,account:source.name});
        articles.push({...item,account:source.name,status:'video',video_id:body.video_id});
        issues.push({type:'video',message:`${item.title}：视频消息${item.url?'已保留原文链接':'原文链接未取得'}，未下载视频文件`});
        continue;
      }
      number++;await progress(job,{stage:'pack',message:`正在打包第 ${number} 篇：${item.title}`,completed:number});
      if(!body) {issues.push({type:'body',message:item.title+'：'+(await get('meta','body-error:'+item.rid)||'尚未取得正文')});articles.push({...item,account:source.name,status:'missing'});continue;}
      let html=body.html;
      for(const url of body.images) {
        try {
          let asset=assets.find(row=>row.source_url===url);
          if(!asset) {const blob=await fetchImage(url);const ext=blob.type.split('/')[1].replace('jpeg','jpg');asset={source_url:url,path:`assets/${String(assets.length+1).padStart(4,'0')}.${ext}`,article_ids:[]};assets.push(asset);zip.file(asset.path,blob);}
          if(!asset.article_ids.includes(item.rid))asset.article_ids.push(item.rid);
          html=html.replaceAll(url.replaceAll('&','&amp;'),'../'+asset.path).replaceAll(url,'../'+asset.path);
        }catch(error) {issues.push({type:'image',message:`${item.title}：${error.message}`});}
      }
      const date=new Date(item.t*1000).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'});
      const header=`# ${item.title}\n\n来源公众号：${source.name}\n发布时间：${date}\n原文链接：${item.url || '缺少原文链接'}\n\n`;
      const filename=`articles/${String(number).padStart(4,'0')}`;
      zip.file(filename+'.md',header+markdownBody(html));
      zip.file(filename+'.html','<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' https: data:; style-src \'unsafe-inline\'">'+html.replaceAll('src="../assets/','src="../assets/'));
      articles.push({...item,account:source.name,status:'ok',text:body.text,markdown:header+markdownBody(html).replaceAll('../assets/','assets/'),file:filename+'.md'});
    }
  }
  const start=job.input.start_date,end=job.input.end_date;
  const rangeLabel=job.input.all_history?'全部历史（截至 '+end+'）':`${start}—${end}`;
  const allText=`# 公众号文字稿 ${rangeLabel}\n\n`+articles.map(row=>`## ${row.title}\n\n来源公众号：${row.account}\n发布时间：${new Date(row.t*1000).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'})}\n原文链接：${row.url || '缺少原文链接'}\n\n${row.status==='ok'?row.text:row.status==='video'?'[视频消息：请通过原文链接观看，未下载视频文件。]':'[正文未取得，详见 manifest.json 中的缺失项。]'}`).join('\n\n---\n\n');
  const manifest={schema:'opslion-article-bundle/v1',link_schema_version:1,all_history:!!job.input.all_history,start_date:start,end_date:end,review_range:{start,end},generated_at:new Date().toISOString(),sources:sourceRecords,article_count:articles.length,body_count:articles.filter(row=>row.status==='ok').length,image_count:assets.length,skipped_videos:skipped,archive_complete:issues.length===0,collection_coverage_confirmed:!issues.some(row=>['coverage','source'].includes(row.type)),coverage_scope:'微信读书可提供的公众号目录',issues};
  const summary=articles.map(({text,markdown,...item})=>item);
  zip.file('all-text.md',allText);zip.file('all-articles.md',articles.filter(row=>row.status==='ok').map(row=>row.markdown).join('\n\n---\n\n'));
  zip.file('manifest.json',JSON.stringify(manifest,null,2));zip.file('index.json',JSON.stringify(summary,null,2));zip.file('asset-index.json',JSON.stringify(assets,null,2));
  zip.file('说明.txt',`公众号推文资料\n范围：${rangeLabel}\n目录 ${manifest.article_count} 篇，已取得正文 ${manifest.body_count} 篇，图片 ${assets.length} 张。\n数据范围为微信读书可提供的公众号目录，不能证明覆盖该公众号在微信发布的所有内容。\nall-text.md：合并文字及未取得正文的条目\nall-articles.md：含配图的合并 Markdown\narticles/：逐篇 Markdown 与 HTML\nassets/：本地配图\nindex.json：全部条目及状态（ok / missing / video）\nmanifest.json：采集范围、统计和缺失说明\n\n${issues.length?'需核对的条目：\n'+issues.map(row=>row.message).join('\n'):'已取得本次目录内的全部图文正文和配图。'}\n`);
  const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});if(await cancelled())throw Object.assign(new Error('已停止打包。'),{code:'cancelled'});
  const id=crypto.randomUUID(),filename=`推文资料_${job.input.all_history?'全部历史':start}_${end}${issues.length?'_含缺失项':''}`;
  const meta={id,filename,link_schema_version:1,all_history:!!job.input.all_history,generated_at:manifest.generated_at,start_date:start,end_date:end,article_count:manifest.article_count,body_count:manifest.body_count,image_count:assets.length,complete:manifest.archive_complete,size:blob.size,issues};
  await put('archives',id,{meta,zip:blob,text:new Blob([allText],{type:'text/markdown;charset=utf-8'}),index:new Blob([JSON.stringify(summary,null,2)],{type:'application/json'})});
  const fresh=await readState();fresh.exports=[meta,...fresh.exports];await saveState(fresh);
  return {archive_id:id,message:`目录 ${manifest.article_count} 篇，已打包 ${manifest.body_count} 篇正文、${assets.length} 张图片${issues.length?'，请查看缺失项':''}。`};
}
async function manage(job,client,cancelled) {
  const input=job.input;
  if(job.action==='open-browser') {await client.show();return {message:'已打开当前浏览器的登录或验证页面。'};}
  if(job.action==='update') {
    const state=await readState(),account=state.accounts.find(row=>row.bookId===input.bookId);if(!account)throw new Error('公众号不存在。');
    if(input.operation==='remove')state.accounts=state.accounts.filter(row=>row!==account);
    else if(['pause','resume'].includes(input.operation))account.enabled=input.operation==='resume';else throw new Error('无效操作。');
    await saveState(state);return {message:'公众号列表已更新。'};
  }
  if(job.action==='logout') {
    // Only remove WeRead cookies, never clear all browser cookies or other websites.
    const cookies=await chrome.cookies.getAll({domain:'weread.qq.com'});
    for(const cookie of cookies)await chrome.cookies.remove({url:`https://${cookie.domain.replace(/^\./,'')}${cookie.path}`,name:cookie.name,storeId:cookie.storeId});
    await session({state:'logged_out',message:'已退出此浏览器的微信读书登录，公众号和文章已保留。'});await put('meta','login',null);
    return {message:'已退出微信读书。'};
  }
  await client.tab('https://weread.qq.com/');
  if(job.action==='login') {
    const started=Date.now();let displayed=false;
    while(Date.now()-started<300000) {
      if(await cancelled())throw Object.assign(new Error('已停止扫码。'),{code:'cancelled'});
      const probe=await client.loginProbe();
      if(probe.state==='ready') {await shelf(client);await put('meta','login',null);return {message:'登录有效，可以采集公众号。'};}
      if(probe.state==='expired')throw new Error('二维码已过期，请重新扫码。');
      if(probe.data) {displayed=true;await put('meta','login',{id:job.id,state:'waiting',qr_available:true,qr_data:probe.data,revision:Date.now(),message:'用微信扫描二维码，确认后自动登录。'});}
      if(!displayed && Date.now()-started>12000) {await client.show();displayed=true;await put('meta','login',{id:job.id,state:'external',qr_available:false,message:'二维码受页面限制，已打开登录页，请在那里扫码。'});}
      await progress(job,{stage:'login',message:displayed?'等待微信扫码确认…':'正在读取登录二维码…'});await sleep(1800);
    }
    throw new Error('扫码等待已结束，请重新获取二维码。');
  }
  if(['check','shelf'].includes(job.action))return {books:await shelf(client),message:'登录有效，已读取公众号书架。'};
  let bookId=input.bookId;
  if(job.action==='resolve') {
    const url=articleUrl(input.url);bookId=bookIdFrom(url.href);
    if(!bookId) {const response=await fetch(url.href,{credentials:'omit',signal:AbortSignal.timeout(20000)});articleUrl(response.url);const text=await response.text();if(text.length>4_000_000)throw new Error('文章页面过大。');bookId=bookIdFrom(text);}
    if(!bookId)throw new Error('链接未提供可用的公众号信息，请从微信读书书架选择。');
  }
  if(!/^MP_WXS_\d+$/.test(bookId || ''))throw new Error('公众号标识无效。');
  let book=(await get('meta','shelf') || []).find(row=>row.bookId===bookId);
  if(!book) {await client.request('add',{bookId});book=(await shelf(client)).find(row=>row.bookId===bookId);}
  if(!book || !safeReader(book.readerUrl))throw new Error('微信读书尚未提供该公众号的阅读入口。');
  const state=await readState();if(!state.accounts.some(row=>row.bookId===bookId))state.accounts.push({...book,enabled:true});await saveState(state);
  return {message:'已添加公众号：'+book.name};
}
async function run(job) {
  const cancelled=async()=>await get('meta','cancel')===job.id;
  const client=new BrowserTransport(cancelled);
  try {
    let result;
    if(job.action==='collect') {const index=await scan(job,client,cancelled);await bodies(job,index,client,cancelled);result=await packageArchive(job,cancelled);}
    else if(job.action==='repair-links') {
      const index=await get('meta','index');if(!index)throw new Error('暂无文章目录，请先采集。');
      if(!(await readState()).accounts.some(row=>row.enabled!==false))throw new Error('请启用要修复的公众号。');
      await bodies(job,index,client,cancelled,true);result=await packageArchive(job,cancelled);
    }
    else if(job.action==='export')result=await packageArchive(job,cancelled);
    else result=await manage(job,client,cancelled);
    await progress(job,{state:'complete',result,message:result.message});
  }catch(error) {
    const state=error.code==='verification'?'paused':error.code==='cancelled'?'cancelled':'failed';
    if(error.code==='verification')await session({state:'verification',message:error.message});
    await progress(job,{state,result:{code:error.code,browser_opened:!!error.browser_opened},message:error.message});
  }finally {await put('meta','login',null);if(client.tabId)await chrome.tabs.update(client.tabId,{autoDiscardable:true}).catch(()=>{});}
}
export async function start(input) {
  if(!['login','check','shelf','resolve','add','update','logout','open-browser','collect','export','repair-links','resume'].includes(input.action))throw new Error('无效操作。');
  return new Promise((resolve,reject)=>{
    void navigator.locks.request(LOCK,{ifAvailable:true},async lock=>{
      if(!lock) {reject(new Error('另一采集台正在执行任务，请返回原标签页。'));return;}
      try {
        const state=await readState();let action=input.action;
        if(action==='resume') {
          const old=state.resume_job;if(!old || old.id!==input.job_id || !['paused','failed','cancelled'].includes(old.state))throw new Error('找不到可继续的任务。');
          action=old.action;input={...old.input,resume:true};
        }
        if(['collect','export','repair-links'].includes(action))input=normalizeRange(input);
        const job={id:crypto.randomUUID(),action,input,state:'running',stage:'starting',message:'正在准备…',completed:0,total:0};
        await put('meta','cancel',null);await progress(job,{});resolve({job_id:job.id});await run(job);
      }catch(error) {reject(error);}
    }).catch(reject);
  });
}
export async function status() {
  const state=await readState();
  if(['running','cancelling'].includes(state.job?.state)) {
    await navigator.locks.request(LOCK,{ifAvailable:true},async lock=>{
      if(lock) {const latest=await readState();if(['running','cancelling'].includes(latest.job?.state)) {latest.job.state='paused';latest.job.message='采集页面已关闭或刷新，进度已保存，可继续上次任务。';if(['collect','export','repair-links'].includes(latest.job.action))latest.resume_job=latest.job;await saveState(latest);await put('meta','login',null);Object.assign(state,latest);}}
    });
  }
  const login=await get('meta','login');
  return {...state,books:await get('meta','shelf') || [],has_index:!!await get('meta','index'),login:['running','cancelling'].includes(state.job?.state)?login:null};
}
export async function download(id,kind) {
  if(!['zip','text','index'].includes(kind))throw new Error('无效下载类型。');
  const archive=await get('archives',id);if(!archive)throw new Error('资料不存在。');
  const blob=archive[kind];const key=id+kind;let url=urls.get(key);if(!url){url=URL.createObjectURL(blob);urls.set(key,url);}
  const a=document.createElement('a');a.href=url;a.download=archive.meta.filename+(kind==='zip'?'.zip':kind==='text'?'.md':'.json');a.click();
}
export async function request(url,options={}) {
  if(options.signal?.aborted)throw new DOMException('已取消','AbortError');
  if(url==='/local-api/collector/status')return status();
  const body=options.body?JSON.parse(options.body):{};
  if(url==='/local-api/collector/actions')return start(body);
  if(url==='/local-api/collector/cancel') {const state=await readState();if(state.job?.id!==body.job_id)throw new Error('任务已改变。');await put('meta','cancel',body.job_id);return {ok:true};}
  throw new Error('未知的插件本机操作。');
}

export async function openBrowser() {
  await new BrowserTransport().show();
}
