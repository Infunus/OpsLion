import DOMPurify from '../vendor/purify.js';
import { parseGalleryHtml, parseVideoHtml } from './content-parser.js';
export function safeImage(value) {
  try { const u=new URL(value.replace(/^http:/,'https:'));return u.protocol==='https:' && !u.username && !u.password && !u.port && ['qpic.cn','qlogo.cn','xiumi.us'].some(host=>u.hostname===host || u.hostname.endsWith('.'+host)) ? u.href : null; }catch{return null;}
}
export function parseBody(raw) {
  const video=parseVideoHtml(raw);if(video)return {...video,images:[]};
  const doc=new DOMParser().parseFromString(raw,'text/html');
  const root=doc.querySelector('#js_content,.rich_media_content');
  const title=(doc.querySelector('#activity-name')?.textContent || doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '').trim();
  if(root) {
    root.querySelectorAll('script,style,noscript,iframe,form,object,embed,video,audio').forEach(node=>node.remove());
    for(const image of root.querySelectorAll('img')) { const url=safeImage(image.getAttribute('data-src') || image.getAttribute('src') || '');if(url)image.setAttribute('src',url);else image.remove(); }
    // Preserve paragraph boundaries in plain text instead of flattening the entire article.
    for(const node of root.querySelectorAll('p,div,section,li,h1,h2,h3,h4,blockquote,br')) node.append(doc.createTextNode('\n'));
    const text=(root.textContent || '').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    const images=[...new Set([...root.querySelectorAll('img[src]')].map(image=>image.getAttribute('src')))];
    if(text || images.length)return {ok:true,title,text,images,html:DOMPurify.sanitize(root.innerHTML,{FORBID_TAGS:['style','iframe','form','video','audio'],FORBID_ATTR:['style','srcset']})};
  }
  const gallery=parseGalleryHtml(raw);if(gallery)return gallery;
  const message=doc.body.textContent || '';
  if(message.includes('你暂无权限查看此页面内容'))throw new Error('当前登录会话没有阅读正文的权限。');
  throw Object.assign(new Error('页面未包含可识别的文字正文，已记录缺失项。'),{code:'body_unavailable'});
}
export function markdownBody(html) {
  const doc=new DOMParser().parseFromString(html,'text/html');
  const escape=s=>s.replace(/[\\`*_\[\]]/g,'\\$&');
  const walk=node=>{
    if(node.nodeType===3)return escape(node.textContent || '');
    if(node.nodeType!==1)return '';
    const text=[...node.childNodes].map(walk).join(''),tag=node.tagName;
    if(tag==='IMG')return `\n\n![${escape(node.getAttribute('alt') || '配图')}](${node.getAttribute('src') || ''})\n\n`;
    if(tag==='A') { const href=node.getAttribute('href') || '';return /^https?:\/\//.test(href)?`[${text}](${href.replace(/\)/g,'%29')})`:text; }
    if(tag==='BR')return '\n';
    if(['P','DIV','SECTION','LI','BLOCKQUOTE','H1','H2','H3','H4'].includes(tag))return '\n\n'+text+'\n\n';
    return text;
  };
  return [...doc.body.childNodes].map(walk).join('').replace(/\n{3,}/g,'\n\n').trim();
}
