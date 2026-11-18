// Metadata extraction and identity checks adapted from weread-mp-fetcher (MIT).
import { extractContentMetadata } from './link-metadata.js';

const fail = reason => ({url:'',linkStatus:'unresolved',linkReason:reason});
const titleKey = value => String(value || '').replace(/\s+/g,' ').trim();
export function validateMetadata(item, bookId, metadata) {
  const parts = String(item.rid || '').match(/^MP_WXS_(\d+)_[A-Za-z0-9_~-]+$/);
  if (!parts || 'MP_WXS_'+parts[1] !== bookId) return fail('invalid_review_id');
  if (!metadata?.ok) return fail(metadata?.reason || 'missing_meta');
  if (!titleKey(item.title) || titleKey(item.title)!==titleKey(metadata.title)) return fail('title_mismatch');
  let url;
  try { url=new URL(metadata.url); } catch { return fail('invalid_article_url'); }
  if(url.origin!=='https://mp.weixin.qq.com' || url.username || url.password || url.port || url.pathname!=='/s')return fail('invalid_article_url');
  const fields={};
  for(const key of ['__biz','mid','idx','sn']) {
    const values=url.searchParams.getAll(key);
    if(values.length!==1 || !values[0])return fail('missing_article_field');
    fields[key]=values[0];
  }
  if(!/^[1-9]\d*$/.test(fields.mid) || !/^[1-9]\d*$/.test(fields.idx) || !/^[a-f\d]{32}$/i.test(fields.sn))return fail('invalid_article_field');
  try {
    const publisher=atob(fields.__biz);
    if(publisher!==parts[1] || btoa(publisher)!==fields.__biz)return fail('publisher_mismatch');
  }catch{return fail('publisher_mismatch');}
  const canonical=new URL('https://mp.weixin.qq.com/s');
  for(const key of ['__biz','mid','idx','sn'])canonical.searchParams.set(key,fields[key]);
  return {url:canonical.href,linkStatus:'metadata_url'};
}

export function existingLink(item, bookId) {
  const parts=String(item.rid || '').match(/^MP_WXS_(\d+)_([A-Za-z0-9_~-]+)$/);
  if(!parts || 'MP_WXS_'+parts[1]!==bookId)return fail('invalid_review_id');
  if(/^[A-Za-z0-9_~-]{22}$/.test(parts[2])) {
    const url='https://mp.weixin.qq.com/s/'+parts[2].replace(/~/g,'_');
    if(item.url===url)return {url,linkStatus:'short_token'};
  }
  if(item.url) {
    const result=validateMetadata(item,bookId,{ok:true,title:item.title,url:item.url});
    if(result.url)return result;
  }
  return fail(item.linkReason || 'not_resolved');
}

export function extractLink(raw, item, bookId) {
  return validateMetadata(item,bookId,extractContentMetadata(raw));
}
const reasons={
  not_resolved:'尚未取得真实原文链接',missing_meta:'页面未提供原文元数据',empty_meta:'原文元数据为空',
  title_mismatch:'原文标题与目录不符',publisher_mismatch:'原文公众号与目录不符',invalid_review_id:'文章标识与公众号不符',
  invalid_article_url:'页面未提供有效微信原文地址',missing_article_field:'原文地址缺少或重复定位参数',invalid_article_field:'原文定位参数无效',
  ambiguous_meta:'原文元数据存在冲突',invalid_html:'无法可靠解析原文元数据',invalid_entity:'原文元数据编码异常',
  verification_page:'页面要求验证',request_failed:'补取原文链接失败',
};
export const linkReasonText = reason => reasons[reason] || '未能确认真实原文链接';
