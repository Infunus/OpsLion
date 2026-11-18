#!/usr/bin/env python3
"""Build, inspect and review the xiumi-bridge/v4 native-layout round-trip format.

No network access, browser login, proprietary API calls, or image uploads here.
Models are only changed where explicit user-authored plans request changes.
"""
from __future__ import annotations
import argparse
import base64
import copy
from html import unescape, escape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
import uuid
from urllib.parse import urlparse
from collections import Counter, defaultdict

V4 = 'xiumi-bridge/v4'
PLAN = 'opslion-native-layout-plan/v1'
BLUEPRINT = 'opslion-native-blueprint/v1'
WORKPLAN = 'opslion-native-workplan/v1'
ALLOWED_IMAGES = {'png', 'jpeg', 'gif', 'webp', 'avif'}
DATA_RE = re.compile(r'^data:image/(png|jpeg|gif|webp|avif);base64,([a-zA-Z0-9+/=\s]+)$',re.S)
BAD_JS = re.compile(r'^\s*(?:javascript|vbscript):',re.I)
FORBIDDEN = {'__proto__','prototype','constructor'}

class PacketError(ValueError): pass

def require(condition, message):
    if not condition: raise PacketError(message)

def load(path):
    try: return json.loads(Path(path).read_text(encoding='utf-8-sig'))
    except (ValueError,UnicodeError) as e: raise PacketError(f'JSON 文件无法解析：{e}')

def save(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def bypath(obj,path):
    v=obj
    for x in path:
        require(not isinstance(x,str) or x not in FORBIDDEN,'路径含不允许的键')
        if isinstance(v,list):
            require(isinstance(x,int) and 0<=x<len(v),f'数组路径失效：{path}')
            v=v[x]
        elif isinstance(v,dict):
            require(x in v,f'对象路径失效：{path}')
            v=v[x]
        else: raise PacketError(f'路径指向非对象：{path}')
    return v

def compact_path(path): return json.dumps(path,ensure_ascii=False,separators=(',',':'))

def slot_name(s):
    p=compact_path(s['path'])
    if s['kind']=='text': return f't:{p}:{s["run"]}'
    return f'i:{compact_path([*s["path"],s["field"]])}'

def image_data_url(src):
    m=DATA_RE.fullmatch(src)
    if not m: return None
    try: raw=base64.b64decode(re.sub(r'\s+','',m.group(2)),validate=True)
    except ValueError: raise PacketError('图片 Base64 内容无效')
    require(len(raw)<=12*1024*1024,'单张内嵌图片超过 12MB')
    mime=m.group(1)
    ok={'png':raw.startswith(b'\x89PNG\r\n\x1a\n'),'jpeg':raw.startswith(b'\xff\xd8'),
        'gif':raw[:6] in (b'GIF89a',b'GIF87a'),'webp':raw[:4]==b'RIFF' and raw[8:12]==b'WEBP',
        'avif':b'ftyp' in raw[:32] and (b'avif' in raw[:64] or b'avis' in raw[:64])}[mime]
    require(ok,f'内嵌图片实际内容不是 {mime}')
    return mime,len(raw)

def check_image(src):
    require(isinstance(src,str) and bool(src),'图片替换必须是非空字符串')
    if src.startswith('data:'):
        require(len(src)<=17_000_000,'图片数据 URI 超过插件限制')
        require(image_data_url(src) is not None,'只支持 PNG/JPEG/GIF/WebP/AVIF base64 图片')
        return
    u=urlparse(src)
    require(u.scheme in ('http','https') and bool(u.netloc) and not u.username and not u.password,'图片需要有效 HTTP(S) 公网 URL')
    host=(u.hostname or '').lower()
    require(host not in ('localhost','0.0.0.0','::1') and not host.endswith('.local') and not
            re.match(r'^(127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)',host),'图片地址不能指向本地/内网')

class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True);self.text=[]
    def handle_data(self,s): self.text.append(s)
    def handle_starttag(self,tag,attrs):
        if tag=='br': self.text.append('\n')
    def get(self):return ''.join(self.text)

def plaintext(html):
    p=TextOnly();p.feed(html);return p.get()

def walk_native(obj,path=()):
    if isinstance(obj,dict):
        yield path,obj
        for k,v in obj.items():
            if k!='$$hashKey': yield from walk_native(v,(*path,k))
    elif isinstance(obj,list):
        for i,v in enumerate(obj):yield from walk_native(v,(*path,i))

def validate(obj,full_images=False):
    require(isinstance(obj,dict) and obj.get('schema')==V4 and obj.get('mode')=='native-layout','需要 xiumi-bridge/v4 且 mode=native-layout 的原生导入包')
    p=obj.get('nativeLayout');require(isinstance(p,dict) and p.get('schema')==PLAN,'nativeLayout 结构不正确')
    b=p.get('blueprint');require(isinstance(b,dict) and b.get('schema')==BLUEPRINT,'缺少原生 blueprint')
    require(isinstance(b.get('source'),dict) and re.fullmatch(r'\d+',str(b['source'].get('paperId',''))) is not None,'来源稿件 ID 无效')
    mods=b.get('modules');slots=b.get('slots');seq=p.get('sequence')
    require(isinstance(mods,list) and 0<len(mods)<=500,'原生模块应为 1–500 个')
    require(isinstance(b.get('pageStyle'),dict),'全文原生样式缺失')
    require(isinstance(slots,list) and len(slots)<=15000,'原生文字/图片槽位错误')
    require(isinstance(seq,list) and 0<len(seq)<=1000,'稿件顺序需要 1–1000 个模块')
    require(len(json.dumps({'modules':mods,'pageStyle':b['pageStyle']},ensure_ascii=False))<=8_000_000,'原始组件模型超过插件 8MB 上限')
    slot_map={}
    for s in slots:
        require(isinstance(s,dict) and s.get('kind') in ('text','image'),'槽位类型无效')
        require(isinstance(s.get('path'),list) and s['path'] and isinstance(s['path'][0],int) and
                0<=s['path'][0]<len(mods) and s['path'][0]==s.get('module'),'槽位路径或来源模块无效')
        require(s.get('id')==slot_name(s),'槽位 ID 与路径不匹配')
        require(s['id'] not in slot_map,'存在重复槽位 ID')
        cell=bypath(mods,s['path'])
        require(isinstance(cell,dict),'槽位不是原生组件')
        if s['kind']=='text':
            require(isinstance(s.get('run'),int) and s['run']>=0 and isinstance(s.get('original'),str),'文字槽位信息错误')
            require(cell.get('type')=='text' and isinstance(cell.get('text'),str),'文字槽位没有指向文字组件')
            if s['original']:
                require(s['original'] in unescape(cell['text']),'原生文字槽位与模板不符')
        else:
            require(isinstance(s.get('field'),str) and s['field'] in ['src','url','uri','imageUrl','imageURL'] and
                    cell.get('type')=='image' and cell.get(s['field'])==s.get('original'),'图片槽位与模板不符')
        slot_map[s['id']]=s
    names=set();counts=Counter()
    for e in seq:
        require(isinstance(e,dict) and isinstance(e.get('id'),str) and e['id'] and e['id'] not in names,'稿件模块 ID 无效或重复')
        names.add(e['id']);source=e.get('source')
        require(isinstance(source,int) and 0<=source<len(mods),'模块来源编号无效')
        edits=e.get('edits');require(isinstance(edits,dict),'模块 edits 必须是对象')
        for sid, v in edits.items():
            require(sid in slot_map and slot_map[sid]['module']==source,'编辑槽位与所在模块不匹配')
            require(isinstance(v,str),'最终编辑值必须是字符串')
            if slot_map[sid]['kind']=='image':
                require(len(v)<=17_000_000,'单张替换图片超过插件字符限制')
                if full_images:check_image(v)
                else:require(v.startswith('data:image/') or v.startswith('http://') or v.startswith('https://'),'图片替换格式不正确')
                counts['images']+=1
            else:
                require(len(v)<=50000 and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]',v),'文字包含超长或非法控制字符')
                counts['texts']+=1
    # Report size/complexity, no hashes: modified templates are normal.
    return {'ok':True,'schema':V4,'sourceModules':len(mods),'outputModules':len(seq),
            'slots':len(slots),'textEdits':counts['texts'],'imageEdits':counts['images'],
            'blueprintBytes':len(json.dumps({'modules':mods,'pageStyle':b['pageStyle']},ensure_ascii=False)),
            'note':'本检查只验证离线文件结构，不代表真实秀米保存/渲染成功'}

def safe_summary(src):
    if not isinstance(src,str):return str(src)
    m=DATA_RE.fullmatch(src)
    if m:return f'<embedded image/{m.group(1)} {len(m.group(2))} base64 chars>'
    return src[:200]

def catalog(packet):
    b=packet['nativeLayout']['blueprint'];slots=b['slots'];res=[]
    for i,module in enumerate(b['modules']):
        slotlist=[]
        for s in slots:
            if s['module']!=i:continue
            sample=s.get('original','')
            detail={'id':s['id'],'kind':s['kind'],'path':s['path'],
              'run':s.get('run'),'field':s.get('field'),'original':safe_summary(sample)[:1000]}
            if s['kind']=='text':
                cell=bypath(b['modules'],s['path'])
                html=cell.get('text','')
                detail['nativeTypography']={
                    'paragraphFirstLineIndent':bool(re.search(r'text-indent\s*:',html,re.I)),
                    'paragraphWesternBreak':bool(re.search(r'word-break\s*:\s*break-all',html,re.I)),
                    'wordBreakMode':(cell.get('constraint') or {}).get('wordBreakMode')
                }
            slotlist.append(detail)
        res.append({'index':i,'tplId':module.get('_comp',{}).get('tplId',''),'slotCount':len(slotlist),
                    'slots':slotlist})
    return {'schema':'opslion-native-catalog/v1','title':packet.get('title',''),
        'source':b['source'],'modules':res,'pageStyle':b['pageStyle'],
        'sequence':[{'id':e['id'],'source':e['source'],'textEdits':sum(k.startswith('t:') for k in e['edits']),
                     'imageEdits':sum(k.startswith('i:') for k in e['edits'])} for e in packet['nativeLayout']['sequence']]}

def source_get(obj,asset_spec):
    """Resolve a material image ID or a relative file path supplied in the workplan."""
    if isinstance(asset_spec,dict) and set(asset_spec)=={'asset'}:
        aid=asset_spec['asset'];require(isinstance(aid,str),'素材 ID 必须是字符串')
        assets=obj.get('assets',{})
        require(aid in assets,f'未找到材料素材 {aid}')
        return assets[aid]['src']
    if isinstance(asset_spec,str):return asset_spec
    raise PacketError('编辑值必须是字符串或 {"asset":"A0001"}')

# Xiumi v5 stores the native first-line indent on each paragraph (<p style=...>),
# and western-word breaking both on paragraph style and the text cell constraint.
# Replacing a text run in 支持 v4 原生协议的导入端 preserves these outer paragraph elements.
P_TAG_RE = re.compile(r'<p(?=\s|>)([^>]*)>', re.I | re.S)
STYLE_ATTRIBUTE_RE = re.compile(r'(?<![\w:-])style\s*=\s*([\"\'])(.*?)\1', re.I | re.S)
BARE_STYLE_RE = re.compile(r'(?<![\w:-])style(?=\s|$)', re.I)


def set_css_property(style, key, value):
    # Keep all unrelated inline declarations; remove old copies of this key.
    # These are known, fixed values and CSS property names, not user HTML.
    prop = re.compile(r'(?:^|;)\s*'+re.escape(key)+r'\s*:[^;]*;?', re.I)
    remaining = prop.sub(';', style).strip(' ;\t\r\n')
    return (remaining+'; ' if remaining else '')+key+': '+value+';'


def patch_paragraph_styles(html, additions):
    require(isinstance(html,str),'原生文字内容不是富文本字符串')
    count = 0
    def change(match):
        nonlocal count
        count += 1
        attrs = match.group(1)
        found = STYLE_ATTRIBUTE_RE.search(attrs)
        if found:
            merged = found.group(2)
            for name, val in additions.items():
                merged = set_css_property(merged, name, val)
            return '<p'+attrs[:found.start(2)]+merged+attrs[found.end(2):]+'>'
        bare = BARE_STYLE_RE.search(attrs)
        if bare:
            attrs = attrs[:bare.start()]+attrs[bare.end():]
        inline = ''.join(name+': '+val+'; ' for name,val in additions.items()).strip()
        return '<p'+attrs+' style="'+inline+'">'
    result = P_TAG_RE.sub(change, html)
    require(count>0, '文本组件没有 <p> 自然段；不能自动写入首行缩进或西文打断，请换用原生正文组件')
    return result


def apply_text_formatting(variant, formats):
    for fmt in formats:
        require(isinstance(fmt,dict) and set(fmt).issubset({'path','firstLineIndent','westernBreak'})
                and 'path' in fmt and ('firstLineIndent' in fmt or 'westernBreak' in fmt),
                'textFormatting 只支持 path / firstLineIndent / westernBreak')
        path=fmt['path']
        require(isinstance(path,list) and len(path)>=1, 'textFormatting.path 必须是组件内文本 cell 路径')
        cell=bypath(variant,path)
        require(isinstance(cell,dict) and cell.get('type')=='text' and isinstance(cell.get('text'),str),
                'textFormatting.path 必须指向 type=text 的原生文字 cell')
        additions={}
        if 'firstLineIndent' in fmt:
            indent=fmt['firstLineIndent']
            require(isinstance(indent,str) and re.fullmatch(r'(?:0|[1-3](?:\.\d{1,2})?)em', indent),
                    'firstLineIndent 应使用 0em、1em、2em、3em 等段落缩进值')
            additions['text-indent']=indent
        if 'westernBreak' in fmt:
            require(fmt['westernBreak'] is True, 'westernBreak 仅支持 true；不指定即保留模板原设置')
            additions['word-break']='break-all'
        cell['text']=patch_paragraph_styles(cell['text'],additions)
        if fmt.get('westernBreak') is True:
            constraint=cell.setdefault('constraint',{})
            require(isinstance(constraint,dict),'原生文字 constraint 不是对象')
            constraint['wordBreakMode']='breakAll'


# Rich-text replacement is performed on an independent native module variant.
# The browser plugin's text `edits` replace plain text nodes only, so passing
# HTML through edits would show the tags literally and lose bold formatting.
RICH_PARAGRAPH_RE = re.compile(r'(<p(?=\s|>)[^>]*>)(.*?)(</p\s*>)',re.I|re.S)


def render_rich_runs(runs):
    require(isinstance(runs,list) and bool(runs),'richText.runs 应为非空数组')
    fragments=[]
    for run in runs:
        require(isinstance(run,dict) and set(run).issubset({'text','bold'}) and 'text' in run,
                'richText run 仅支持 text 与 bold')
        require(isinstance(run['text'],str),'richText run.text 必须是文字')
        if 'bold' in run:require(isinstance(run['bold'],bool),'richText.bold 应为布尔值')
        text=escape(run['text'],quote=False).replace('\n','<br>')
        if run.get('bold') and text:text='<strong>'+text+'</strong>'
        fragments.append(text)
    require(any(r.get('text') for r in runs),'richText 不得全部为空')
    return ''.join(fragments)


def apply_rich_text(variant,entries):
    changed=set()
    for item in entries:
        require(isinstance(item,dict) and set(item).issubset({'path','runs','paragraphs'}) and
                'path' in item and (('runs' in item) != ('paragraphs' in item)),
                'richText 每项需要 path 和 runs 或 paragraphs')
        path=item['path'];require(isinstance(path,list) and len(path)>=1,'richText.path 必须是文字 cell 路径')
        key=tuple(path);require(key not in changed,'同一文字 cell 不应重复指定 richText')
        cell=bypath(variant,path)
        require(isinstance(cell,dict) and cell.get('type')=='text' and isinstance(cell.get('text'),str),
                'richText.path 必须指向原生 type=text 文字 cell')
        runs_by_para=[item['runs']] if 'runs' in item else item['paragraphs']
        require(isinstance(runs_by_para,list) and bool(runs_by_para),'richText.paragraphs 应为非空列表')
        if 'paragraphs' in item:
            runs_by_para=[p['runs'] if isinstance(p,dict) and set(p)=={'runs'} else None for p in runs_by_para]
        chunks=[render_rich_runs(r) for r in runs_by_para]
        cursor=iter(chunks);matched=[0]
        def rep(m):
            matched[0]+=1
            return m.group(1)+next(cursor)+m.group(3) if matched[0]<=len(chunks) else m.group(0)
        result=RICH_PARAGRAPH_RE.sub(rep,cell['text'])
        require(matched[0]==len(chunks),'richText 段落数与来源组件的 <p> 数量不匹配；请拆分文字组件')
        cell['text']=result
        changed.add(key)
    return changed


# Table rows must be cloned from a CAPTURED native classic-table component.
# These are real nested Xiumi cells, not arbitrary HTML <table> strings.
def render_native_table_cell(cell, data):
    allowed={'text','bold','runs','paragraphs','colSpan'}
    if isinstance(data,str): data={'text':data}
    require(isinstance(data,dict) and set(data).issubset(allowed),
            'nativeTables 单元格需为字符串或 {text/bold/runs/paragraphs/colSpan}')
    kinds=sum(k in data for k in ('text','runs','paragraphs'))
    require(kinds==1,'nativeTables 单元格应恰有 text、runs、paragraphs 中的一项')
    if 'text' in data:
        require(isinstance(data['text'],str),'nativeTables text 应为字符串')
        require('bold' not in data or isinstance(data['bold'],bool),'nativeTables bold 应为布尔值')
        bypara=[[{'text':data['text'],'bold':bool(data.get('bold'))}]]
    elif 'runs' in data:
        require('bold' not in data,'runs 已含局部加粗，不要同时设置 bold')
        bypara=[data['runs']]
    else:
        require('bold' not in data,'paragraphs 已含局部加粗，不要同时设置 bold')
        bypara=[]
        require(isinstance(data['paragraphs'],list) and data['paragraphs'],
                'nativeTables.paragraphs 必须为非空列表')
        for par in data['paragraphs']:
            if isinstance(par,str):bypara.append([{'text':par}])
            elif isinstance(par,dict) and set(par)=={'runs'}:bypara.append(par['runs'])
            else:raise PacketError('nativeTables 的每个段落需是字符串或 {runs:[...]}')
    # Keep the captured cell's paragraph attributes, but replace its stale words
    # and stale <strong> wrappers with explicit runs from the current document.
    target=cell['items'][0]['txt1']
    original=target.get('text')
    require(isinstance(original,str),'原生表格的单元格未包含原生文字')
    match=RICH_PARAGRAPH_RE.search(original)
    require(match is not None,'原生表格单元格没有可复用的 <p> 文字段落')
    prefix,suffix=match.group(1),match.group(3)
    target['text']=''.join(prefix+render_rich_runs(runs)+suffix for runs in bypara)
    col_span=data.get('colSpan',1)
    require(isinstance(col_span,int) and not isinstance(col_span,bool) and col_span>=1,
            'colSpan 必须是正整数')
    cell['colSpan']=col_span
    cell['rowSpan']=1
    return col_span


def regenerate_component_ids(subtree):
    for path,node in walk_native(subtree):
        if isinstance(node,dict) and isinstance(node.get('_comp'),dict) and isinstance(node['_comp'].get('_$uuid'),str):
            old=node['_comp']['_$uuid']; prefix=old.split('-')[0]
            node['_comp']['_$uuid']=prefix+'-'+uuid.uuid4().hex[:16]


def apply_native_tables(variant,entries):
    changed=[]
    seen=set()
    for entry in entries:
        require(isinstance(entry,dict) and set(entry).issubset({'path','rows','columnWidths'})
                and 'path' in entry and 'rows' in entry,
                'nativeTables 需要 path、rows，可选 columnWidths')
        path=entry['path']
        require(isinstance(path,list) and len(path)>=1,'nativeTables.path 需要指向真实原生表格组件')
        key=tuple(path);require(key not in seen,'同一表格不能重复指定 nativeTables')
        seen.add(key)
        comp=bypath(variant,path)
        require(isinstance(comp,dict) and comp.get('_comp',{}).get('tplId')=='paper-cp:layout/classic-table-normal',
                'nativeTables.path 必须指向从秀米抓取的 paper-cp:layout/classic-table-normal')
        tab=comp.get('classicTable1')
        require(isinstance(tab,dict) and tab.get('type')=='classic-table' and
                isinstance(tab.get('items'),list) and tab['items'] and isinstance(tab.get('thead'),list),
                '原生表格缺失 classicTable1.items / thead')
        count=len(tab['thead'])
        require(1<=count<=12,'原生表格列数需在 1 到 12 列以内')
        rows=entry['rows']
        require(isinstance(rows,list) and 1<=len(rows)<=200,'nativeTables.rows 需包含 1–200 行')
        oldrows=tab['items']
        # Refuse rowSpan merges whose actual occupancy cannot be safely inferred.
        require(all(cell.get('rowSpan',1)==1 for row in oldrows for cell in row.get('tds',[])),
                '来源表格含跨行合并；请在秀米中抓取专用表格组件并人工复核，不能猜测行结构')
        built=[]
        for i,record in enumerate(rows):
            require(isinstance(record,list) and record,'nativeTables 的每一行至少包含一个单元格')
            base=copy.deepcopy(oldrows[i % len(oldrows)])
            templates=base.get('tds')
            require(isinstance(templates,list) and len(templates)==count,
                    '参考表格行的单元格数量与表头列数不一致，不能安全复制')
            newcells=[]; span_total=0
            for j,value in enumerate(record):
                require(j<count,'表格行包含超过原生列数的单元格')
                cell=copy.deepcopy(templates[min(j,len(templates)-1)])
                require(isinstance(cell.get('items'),list) and len(cell['items'])==1 and
                        isinstance(cell['items'][0].get('txt1'),dict) and
                        cell['items'][0]['txt1'].get('type')=='text',
                        '参考单元格必须含一个可编辑的原生 type=text 文字组件')
                span_total+=render_native_table_cell(cell,value)
                regenerate_component_ids(cell)
                newcells.append(cell)
            require(span_total==count,'nativeTables 每一行的 colSpan 总和应等于原生表格列数')
            base['tds']=newcells
            regenerate_component_ids(base)
            built.append(base)
        tab['items']=built
        if 'columnWidths' in entry:
            widths=entry['columnWidths']
            require(isinstance(widths,list) and len(widths)==count and
                    all(type(w) in (int,float) and 0<w<=100 for w in widths) and
                    abs(sum(widths)-100)<0.01,
                    'columnWidths 应为与原生列数相同、合计 100 的百分比数组')
            for col,w in zip(tab['thead'],widths):
                require(isinstance(col.get('style'),dict) and 'width' in col['style'],
                        '原生表头缺少已有 style.width，不能创造不确定属性')
                col['style']['width']=f'{w:.2f}%'
        changed.append(key)
    return changed


class RichTextNodes(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True);self.nodes=[]
    def handle_data(self,value):self.nodes.append(value)


def make_variant(b,source,patches,formats=None,richtext=None,nativetables=None):
    """Create native component+slots variant so style changes affect one repeated instance only."""
    modules=b['modules'];source_module=modules[source]
    newidx=len(modules)
    require(newidx<500,'原生模板衍生模块超过插件上限 500')
    variant=copy.deepcopy(source_module)
    for p in patches:
        require(isinstance(p,dict) and set(p)=={'path','expected','value'},'stylePatches 每项需要 path、expected、value')
        path=p['path'];require(isinstance(path,list) and len(path)>=2,'样式路径无效')
        require(path[-2] in ('style','pose','constraint') and isinstance(path[-1],str),
                '仅允许修改原生组件的 style / pose / constraint 属性')
        container=bypath(variant,path[:-1])
        require(isinstance(container,dict),'样式目标必须是对象')
        require(path[-1] in container,
                f'样式键不存在：{path}；原生首行缩进/西文打断请使用 textFormatting')
        before=container[path[-1]]
        require(before==p['expected'],f'样式定位或预期值不一致: {path}: {before!r} != {p["expected"]!r}')
        container[path[-1]]=p['value']
    table_paths=apply_native_tables(variant,nativetables or [])
    if formats: apply_text_formatting(variant, formats)
    changed=apply_rich_text(variant,richtext or [])
    modules.append(variant)
    renamed={}
    for s in list(b['slots']):
        if s['module']!=source:continue
        # Existing table slots must be rebuilt because rows and paths may change.
        if any(tuple(s['path'][1:1+len(tp)])==tp for tp in table_paths):continue
        if s['kind']=='text' and tuple(s['path'][1:]) in changed:continue
        ss=copy.deepcopy(s);ss['module']=newidx;ss['path'][0]=newidx;ss['id']=slot_name(ss)
        b['slots'].append(ss);renamed[s['id']]=ss['id']
    for path in changed:
        cell=bypath(variant,list(path));parser=RichTextNodes();parser.feed(cell['text'])
        for i,value in enumerate(parser.nodes):
            if not value.strip():continue
            slot={'kind':'text','module':newidx,'path':[newidx,*path],
                  'run':i,'original':value}
            slot['id']=slot_name(slot);b['slots'].append(slot)
    for table_path in table_paths:
        node=bypath(variant,list(table_path))
        for rel,cell in walk_native(node):
            path=[newidx,*table_path,*rel]
            if isinstance(cell,dict) and cell.get('type')=='text' and isinstance(cell.get('text'),str):
                parser=RichTextNodes();parser.feed(cell['text'])
                for i,value in enumerate(parser.nodes):
                    if not value.strip():continue
                    slot={'kind':'text','module':newidx,'path':path,'run':i,'original':value}
                    slot['id']=slot_name(slot);b['slots'].append(slot)
            elif isinstance(cell,dict) and cell.get('type')=='image' and isinstance(cell.get('src'),str):
                slot={'kind':'image','module':newidx,'path':path,'field':'src','original':cell['src']}
                slot['id']=slot_name(slot);b['slots'].append(slot)
    return newidx,renamed

def build(template,plan,materials=None):
    validate(template)
    require(isinstance(plan,dict) and plan.get('schema')==WORKPLAN,'工作计划需要 opslion-native-workplan/v1')
    require(isinstance(plan.get('sequence'),list) and plan['sequence'],'计划 sequence 不应为空')
    new=copy.deepcopy(template)
    b=new['nativeLayout']['blueprint'];before=b['slots'];lookup={s['id']:s for s in before}
    assets={a['id']:a for a in (materials or {}).get('assets',[])}
    context={'assets':assets}
    seq=[]
    for e in plan['sequence']:
        require(isinstance(e,dict) and set(e).issubset({'id','source','edits','stylePatches','textFormatting','richText','nativeTables'}),'计划模块包含不支持的字段')
        source=e.get('source');require(isinstance(source,int) and 0<=source<len(template['nativeLayout']['blueprint']['modules']),'计划 source 越界')
        raw_edits=e.get('edits',{});require(isinstance(raw_edits,dict),'计划 edits 必须是对象')
        patches=e.get('stylePatches',[]);require(isinstance(patches,list),'stylePatches 应为数组')
        formats=e.get('textFormatting',[]);require(isinstance(formats,list),'textFormatting 应为数组')
        rich=e.get('richText',[]);require(isinstance(rich,list),'richText 应为数组')
        tables=e.get('nativeTables',[]);require(isinstance(tables,list),'nativeTables 应为数组')
        protected={tuple(x.get('path',[])) for x in rich if isinstance(x,dict) and isinstance(x.get('path'),list)}
        for sid in raw_edits:
            if sid in lookup and lookup[sid]['kind']=='text' and tuple(lookup[sid]['path'][1:]) in protected:
                raise PacketError('同一个文字 cell 的 richText 与 edits 不能同时使用；richText 已包含最终全部文字')
        table_paths=[tuple(x.get('path',[])) for x in tables if isinstance(x,dict) and isinstance(x.get('path'),list)]
        for item in rich:
            if isinstance(item,dict) and isinstance(item.get('path'),list) and any(tuple(item['path'][:len(tp)])==tp for tp in table_paths):
                raise PacketError('nativeTables 已提供完整表格内容及 runs 加粗，不能再对同一张表使用 richText')
        for sid in raw_edits:
            if sid in lookup and any(tuple(lookup[sid]['path'][1:1+len(tp)])==tp for tp in table_paths):
                raise PacketError('nativeTables 已提供整张表格内容，不要同时用旧单元格的 edits')
        renamed={}
        new_source=source
        if patches or formats or rich or tables:new_source,renamed=make_variant(b,source,patches,formats,rich,tables)
        edits={}
        for sid,value in raw_edits.items():
            require(sid in lookup and lookup[sid]['module']==source,'计划文字/图片槽位不存在或不属于本模块')
            if isinstance(value,dict) and set(value)=={'asset'}:
                require(lookup[sid]['kind']=='image','素材引用只能用于图片槽位')
            result=source_get(context,value)
            if lookup[sid]['kind']=='image':check_image(result)
            edits[renamed.get(sid,sid)]=result
        seq.append({'id':e.get('id'), 'source':new_source,'edits':edits})
    new['nativeLayout']['sequence']=seq
    new['title']=str(plan.get('title') or new.get('title') or '秀米成稿').strip()[:200]
    if 'createdAt' in new: new.pop('createdAt',None)  # Metadata is not part of v4 native-layout import contract.
    validate(new,full_images=True)
    require(len(json.dumps([b['modules'][e['source']] for e in seq],ensure_ascii=False))<=8_000_000,
            '最终展开的原生组件超过插件 8MB 上限')
    return new

def draft_plan(packet):
    return {'schema':WORKPLAN,'title':packet.get('title','秀米成稿'),
            'sequence':[{'id':e['id'],'source':e['source'],'edits':copy.deepcopy(e['edits'])} for e in packet['nativeLayout']['sequence']]}

def ancestor_styles(module,path):
    """Collect nearby style dictionaries from a slot's actual native path."""
    out=[]; obj=module
    for k in path[1:]:
        if isinstance(obj,dict):
            for key in ('style',):
                if isinstance(obj.get(key),dict) and obj[key]:out.append((key,obj[key]))
            if isinstance(obj.get('_comp'),dict) and isinstance(obj['_comp'].get('style'),dict) and obj['_comp']['style']:
                out.append(('_comp.style',obj['_comp']['style']))
        try:obj=obj[k]
        except (KeyError,IndexError,TypeError):break
    if isinstance(obj,dict):
        if isinstance(obj.get('style'),dict):out.append(('style',obj['style']))
    return out

def audit(packet):
    """Conservative, evidence-based risk hints, NOT a visual-rendering verdict."""
    validate(packet)
    b=packet['nativeLayout']['blueprint']; slots_by_source=defaultdict(list)
    for slot in b['slots']:slots_by_source[slot['module']].append(slot)
    risks=[];changed_count=Counter(); old_remaining=[]
    for idx,entry in enumerate(packet['nativeLayout']['sequence']):
        m=b['modules'][entry['source']]
        for slot in slots_by_source[entry['source']]:
            sid=slot['id'];old=slot['original'];value=entry['edits'].get(sid,old)
            if slot['kind']=='text':
                if sid not in entry['edits'] and len(old.strip())>=5:
                    old_remaining.append({'sequenceIndex':idx,'block':entry['id'],'text':old[:120],'slot':sid})
                if sid in entry['edits']:changed_count['texts']+=1
                ratio=len(value)/max(len(old),1)
                paths=ancestor_styles(m,slot['path'])
                fixed_height=[(k,style.get('height')) for k,style in paths if isinstance(style.get('height'),str) and re.match(r'^\d+(?:\.\d+)?px$',style['height'])]
                fixed_width=[(k,style.get('width')) for k,style in paths if isinstance(style.get('width'),str) and re.match(r'^\d+(?:\.\d+)?px$',style['width'])]
                flex=[style.get('flex') for k,style in paths if isinstance(style.get('flex'),str)]
                nowrap=any(style.get('whiteSpace')=='nowrap' for _,style in paths)
                hidden=any(style.get('overflow')=='hidden' for _,style in paths)
                if value.strip() and ((len(value)>40 or (ratio>=1.6 and len(value)>=6)) and fixed_height or len(value)>6 and fixed_width or nowrap and len(value)>12 or hidden and len(value)>50):
                    risks.append({'level':'review','kind':'constrained-text','module':idx,'block':entry['id'],
                        'slot':sid,'length':len(value),'fixedHeight':fixed_height[:3],'fixedWidth':fixed_width[:3],
                        'nowrap':nowrap,'hidden':hidden,
                        'hint':'核对文本自身及父/兄弟组件的尺寸、布局与溢出属性；结合可视结果确定根因，最小幅度修改。保留既有装饰、字号与视觉结构。'})
                if sid in entry['edits'] and ratio>=1.6 and len(value)>=6 and any(z.startswith('0 0') for z in flex):
                    risks.append({'level':'review','kind':'grow-in-flex','module':idx,'block':entry['id'],
                        'slot':sid,'previousLength':len(old),'newLength':len(value),'ratio':round(ratio,1),
                        'flexExamples':flex[:4],
                        'hint':'文字增长且祖先含不可伸缩 flex；需查看真实排版中是否发生挤压或裁切，再选择必要的局部调整。'})
                # Evidence-based typography hint: long unbreakable Western runs can overflow
                # mobile-width cells. This is a review suggestion, not a mandatory global switch.
                western_token=re.search(r'[A-Za-z0-9_./:%?=&#+-]{40,}',value)
                cell=bypath(b['modules'],slot['path'])
                if western_token and (cell.get('constraint') or {}).get('wordBreakMode')!='breakAll' \
                    and not re.search(r'word-break\s*:\s*break-all',cell.get('text',''),re.I):
                    risks.append({'level':'review','kind':'long-western-run','module':idx,'block':entry['id'],
                        'slot':sid,'runLength':len(western_token.group(0)),
                        'hint':'检查长英文/URL 是否撑破窄正文框；确需允许单词内换行时，在本实例使用 textFormatting.westernBreak=true。'})
                if sid in entry['edits'] and len(value)>140 and len(old)<60:
                    risks.append({'level':'review','kind':'large-text-growth','module':idx,'block':entry['id'],
                        'slot':sid,'previousLength':len(old),'newLength':len(value),
                        'hint':'原短文改成长段，优先复用正文型模块或改外层容器高度，不通过缩小字号解决。'})
            elif sid in entry['edits']:
                changed_count['images']+=1
    return {'schema':'opslion-native-audit/v1','staticReviewOnly':True,'renderedInXiumi':False,
        'outputModules':len(packet['nativeLayout']['sequence']),'sourceModules':len(b['modules']),
        'textChanges':changed_count['texts'],'imageChanges':changed_count['images'],
        'risks':risks,'unchangedSourceText':old_remaining,
        'note':'风险项需视觉判断；旧文字可能是固定装饰，也可能是不应保留的上期内容，请逐项分类。'}

def material_summary(materials):
    return {'schema':materials.get('schema'),'files':materials.get('files',[]),
       'blocks':materials.get('blocks',[]),
       'assets':[{'id':a['id'],'mime':a['mime'],'bytes':a['bytes'],'size':a.get('size'),
                 'sources':a.get('sources',[])} for a in materials.get('assets',[])],
       'issues':materials.get('issues',[])}

def cmd_prepare(args):
    p=load(args.template);validate(p)
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    save(out/'template.xiumi.json',p)
    save(out/'catalog.json',catalog(p))
    save(out/'layout.plan.json',draft_plan(p))  # Source order for round-trip or incremental edits only.
    save(out/'composition.plan.json',{'schema':WORKPLAN,'title':p.get('title','秀米成稿'),
                                      'sequence':[]})  # New article: compose order from the manuscript.
    save(out/'audit.source.json',audit(p))
    if args.materials:
        from materials import ingest
        m=ingest(args.materials)
        save(out/'materials.json',m)
        save(out/'materials.summary.json',material_summary(m))
        asset_dir=out/'assets';asset_dir.mkdir(exist_ok=True)
        for a in m['assets']:
            ext={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','image/avif':'avif'}[a['mime']]
            (asset_dir/f'{a["id"]}.{ext}').write_bytes(base64.b64decode(a['src'].split(',',1)[1]))
    print(json.dumps({'ok':True,'workspace':str(out),'modules':len(p['nativeLayout']['sequence']),
          'materials':len(args.materials or [])},ensure_ascii=False))

def cmd_build(args):
    template=load(args.template);plan=load(args.plan);materials=load(args.materials) if args.materials else None
    p=build(template,plan,materials)
    save(args.out,p)
    report=audit(p)
    if args.audit_out: save(args.audit_out,report)
    print(json.dumps({'output':str(args.out),**validate(p),'auditRisks':len(report['risks']),
                      'remainingOriginalText':len(report['unchangedSourceText'])},ensure_ascii=False))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='action',required=True)
    def argin(a): a.add_argument('input')
    a=sub.add_parser('prepare',help='创建工作目录、槽位目录、材料清单和计划初稿')
    a.add_argument('--template',required=True);a.add_argument('--materials',nargs='*');a.add_argument('--out',required=True)
    a=sub.add_parser('inspect',help='输出完整槽位目录（自动省略图片 base64）');argin(a);a.add_argument('--out')
    a=sub.add_parser('validate',help='核验 v4 包结构、编辑引用与图片');argin(a);a.add_argument('--images',action='store_true')
    a=sub.add_parser('build',help='根据工作计划生成 v4 原生成稿');a.add_argument('--template',required=True)
    a.add_argument('--plan',required=True);a.add_argument('--materials');a.add_argument('--out',required=True);a.add_argument('--audit-out')
    a=sub.add_parser('audit',help='发现固定宽高、flex 约束、长文、旧文字残留等潜在问题');argin(a);a.add_argument('--out')
    args=parser.parse_args()
    try:
        if args.action=='prepare':cmd_prepare(args)
        elif args.action=='build':cmd_build(args)
        else:
            packet=load(args.input)
            if args.action=='validate':result=validate(packet,full_images=args.images)
            elif args.action=='inspect':result=catalog(packet)
            else:result=audit(packet)
            if getattr(args,'out',None):save(args.out,result);print(json.dumps({'ok':True,'out':args.out},ensure_ascii=False))
            else:print(json.dumps(result,ensure_ascii=False,indent=2))
    except (PacketError,ValueError,OSError) as e:
        print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False),file=sys.stderr);return 2
    return 0

if __name__=='__main__':sys.exit(main())
