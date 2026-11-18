#!/usr/bin/env python3
"""Build a reusable, Xiumi v5-native Hello Week article from structured weekly content.

Uses the real source article components, never rebuilds them from flat HTML.
Output: xiumi-bridge/v4 with mode=native-layout.
"""
import argparse
import copy
import html
import json
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import urlsplit

from bs4 import BeautifulSoup, NavigableString, Comment

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = 'hello-week/native-v2'
SLOT_LIMIT = 15000
ITEM_LIMIT = 500
# Only exact, clearly irrelevant post-event signup-stat labels are auto-removed.
# Broader content relevance requires editorial judgment based on sources.
REVIEW_SIGNUP_STATS = frozenset({
    '报名人数', '报名总人数', '报名总数', '报名人次', '累计报名人数',
    '报名统计', '报名情况', '实际报名人数', '报名数据'
})
REVIEW_SIGNUP_TEXT = re.compile(r'报名人数|报名人次|报名总数|报名总人数|累计报名|[0-9一二三四五六七八九十百千万]+人报名')
LONG_WESTERN = re.compile(r'[A-Za-z0-9_./:%?=&#+-]{40,}')


def no_final_period(value):
    """Trim only final Chinese full stops in generated prose, never internal punctuation."""
    return str(value).strip().rstrip('。')



def clone(value):
    return copy.deepcopy(value)


def replace_visible_text(raw, previous, new):
    """Minimal literal replacement, keeps Xiumi's original formatting elements."""
    if previous not in raw:
        raise ValueError(f'Native title seed text missing: {previous!r}')
    return raw.replace(previous, html.escape(str(new), quote=False), 1)


def new_uuids(obj):
    if isinstance(obj, dict):
        if isinstance(obj.get('_$uuid'), str):
            alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
            obj['_$uuid'] = 'comp-' + ''.join(secrets.choice(alphabet) for _ in range(16))
        for child in obj.values():
            new_uuids(child)
    elif isinstance(obj, list):
        for child in obj:
            new_uuids(child)


def text_cells(module):
    if isinstance(module, dict):
        for v in module.values():
            if isinstance(v, dict) and v.get('type') == 'text' and isinstance(v.get('text'), str):
                yield v
            elif isinstance(v, (list, dict)):
                yield from text_cells(v)
    elif isinstance(module, list):
        for v in module:
            yield from text_cells(v)


def section_heading(seed, name):
    c = clone(seed)
    raw = c['col2']['items'][0]['txt1']['text']
    c['col2']['items'][0]['txt1']['text'] = replace_visible_text(raw, '上周回顾', name)
    return c


def category(seed, name):
    c = clone(seed)
    cell = c['col1']['items'][0]['txt1']
    cell['text'] = replace_visible_text(cell['text'], '学术信息', name)
    # Extra flexibility for longer category labels, without changing the gradient, padding or font.
    box = c['col1']['style']
    box['flex'] = '0 1 auto'
    box['maxWidth'] = '100%'
    box['minWidth'] = '0'
    return c


def heading(seed, text, previous='【本期资讯标题】'):
    c = clone(seed)
    cell = c['col1']['items'][0]['txt1']
    cell['text'] = replace_visible_text(cell['text'], previous, text)
    # Original uses flex:0 0 auto. Shrinkable title box avoids cropping long labels.
    g = c['col1']['style']
    g['flex'] = '0 1 auto'
    g['maxWidth'] = '100%'
    g['minWidth'] = '0'
    g['width'] = 'auto'
    cell.setdefault('style', {})['overflowWrap'] = 'anywhere'
    return c


def wants_western_break(fields, body, typography=None):
    """Optional Xiumi western-break mode; no automatic formatting by default."""
    typ = typography or {}
    choice = typ.get('western_break', False)
    if choice is True:
        return True
    if choice is False:
        return False
    raw = json.dumps({'fields': fields, 'body': body}, ensure_ascii=False)
    return LONG_WESTERN.search(raw) is not None


def body_html(fields, link=None, links_enabled=True, body=None, section=None,
              warnings=None, title=None, typography=None):
    """Preserve Hello Week's native text rhythm; special typography requires opt-in."""
    typ = typography if isinstance(typography, dict) else {}
    indent_mode = typ.get('first_line_indent', 'none')
    if indent_mode not in ('none', 'auto', '2em'):
        raise ValueError('first_line_indent must be none or 2em; legacy auto behaves as none')
    western = wants_western_break(fields, body, typ)
    western_style = 'word-break: break-all;' if western else ''
    paragraphs = []
    for f in (fields or []):
        if isinstance(f, str):
            t = no_final_period(f)
        else:
            label = str(f.get('label', '')).strip()
            if section == 'review' and label in REVIEW_SIGNUP_STATS:
                if warnings is not None:
                    warnings.append(f'已省略回顾中的无用报名统计字段：{title or "资讯"} / {label}')
                continue
            val = no_final_period(f.get('value', ''))
            t = f'{label}：{val}' if label else val
        if section == 'review' and REVIEW_SIGNUP_TEXT.search(t) and warnings is not None:
            warnings.append(f'回顾中可能有无用报名统计，请核对并精简：{title or "资讯"}')
        if t:
            attr = f' style="{western_style}"' if western else ''
            paragraphs.append('<p' + attr + '><span style="font-family: Segoe UI Symbol, sans-serif; color: #89b1e6;">✔</span> ' + html.escape(t) + '</p>')
    if body:
        lines = body if isinstance(body, list) else str(body).split('\n')
        for line in lines:
            if str(line).strip():
                prose = no_final_period(line)
                if section == 'review' and REVIEW_SIGNUP_TEXT.search(prose) and warnings is not None:
                    warnings.append(f'回顾正文可能有无用报名统计，请核对并精简：{title or "资讯"}')
                # Hello Week uses compact information panels: paragraph length alone never enables indentation.
                # Legacy 'auto' is accepted but intentionally behaves like 'none'.
                indent = indent_mode == '2em'
                style = ('text-indent: 2em;' if indent else '') + western_style
                attr = f' style="{style}"' if style else ''
                paragraphs.append('<p' + attr + '>' + html.escape(prose) + '</p>')
    if link and isinstance(link, dict) and link.get('label'):
        label = html.escape(str(link['label']))
        target = str(link.get('url', '')).strip()
        if links_enabled and target:
            parts = urlsplit(target)
            if parts.scheme not in ('https','http') or not parts.netloc:
                raise ValueError('Only http(s) URLs are supported')
            label = f'<a href="{html.escape(target,quote=True)}" target="_blank" style="text-decoration: none;">{label}</a>'
        elif links_enabled and warnings is not None:
            warnings.append(f'原文链接缺失，已保留标题纯文字：{title or link["label"]}')
        attr = f' style="{western_style}"' if western else ''
        paragraphs.append('<p' + attr + '><span style="font-family: Segoe UI Symbol, sans-serif; color: #89b1e6;">✔</span> 详情请见：' + label + '</p>')
    return ''.join(paragraphs) if paragraphs else '<p>（本期内容待填写）</p>'


def apply_native_western_break(cell, fields, body, typography=None):
    if wants_western_break(fields, body, typography):
        cell.setdefault('constraint', {})['wordBreakMode'] = 'breakAll'


def news_panel(seed, categories, links_enabled, warnings, section=None):
    result = clone(seed)
    col = result['col1']
    original = col['items']
    category_seed, head_seed, body_seed = original[:3]
    items = []
    for group in categories:
        label = str(group.get('name', '')).strip()
        if not label:
            raise ValueError('Every category needs a name')
        entries = group.get('items') or []
        if not entries:
            continue
        items.append(category(category_seed, label))
        for entry in entries:
            title = str(entry.get('title', '')).strip()
            if not title:
                raise ValueError(f'Category {label} contains an entry without a title')
            if len(title) > 32:
                warnings.append(f'长标题请实站检查折行：{title[:46]}')
            raw_body=entry.get('body') or ''
            if len(str(raw_body))+sum(len(str(f)) for f in (entry.get('fields') or []))>900:
                warnings.append(f'资讯正文较长，需核对移动端展开和相邻内容：{title[:35]}')
            items.append(heading(head_seed, title))
            para = clone(body_seed)
            para['txt1']['text'] = body_html(entry.get('fields'), entry.get('link'), links_enabled, entry.get('body'), section=section, warnings=warnings, title=title, typography=entry.get('typography'))
            apply_native_western_break(para['txt1'], entry.get('fields'), entry.get('body'), entry.get('typography'))
            items.append(para)
    if not items:
        return None
    col['items'] = items
    return result


def notice_panel(seed, notices, warnings):
    panel = clone(seed)
    title_seed, body_seed = panel['col1']['items'][:2]
    items = []
    for entry in notices:
        title = str(entry.get('title', '')).strip()
        if not title:
            raise ValueError('Notice missing title')
        if len(title) > 32:
            warnings.append(f'提醒标题较长，请检查：{title[:50]}')
        title_el = clone(title_seed)
        txt = title_el['col1']['items'][0]['txt1']
        txt['text'] = replace_visible_text(txt['text'], '【本期提示标题】', title)
        box = title_el['col1']['style']
        box['flex'] = '0 1 auto'; box['maxWidth'] = '100%'; box['minWidth'] = '0'; box['width'] = 'auto'
        items.append(title_el)
        body_el = clone(body_seed)
        body_el['txt1']['text'] = body_html(entry.get('fields'), None, False, entry.get('body'), typography=entry.get('typography'))
        apply_native_western_break(body_el['txt1'], entry.get('fields'), entry.get('body'), entry.get('typography'))
        items.append(body_el)
    panel['col1']['items'] = items
    return panel if items else None


def shows_panel(seed):
    """Required manual-fill section; keeps the native frame and a single empty text node."""
    panel = clone(seed)
    items = panel['col1']['items']
    if len(items) != 2 or items[1].get('txt1',{}).get('text') != '<p><br></p>':
        raise ValueError('shows_panel native seed must contain its heading and one empty text node')
    return panel


def contact_block(seed, config):
    c = clone(seed)
    email = str(config.get('email', 'weekly@example.com')).strip()
    desc = no_final_period(config.get('message', '如果您对学生会工作有意见建议，或有需要协助解决的问题，欢迎通过以下方式联系我们'))
    ps = [
        '<p><strong>// 【联系我们】</strong></p>',
        '<p>'+html.escape(desc)+'</p>',
        '<p><strong>学生会公共邮箱：</strong>'+html.escape(email)+'</p>'
    ]
    if config.get('other'):
        ps.append('<p>'+html.escape(no_final_period(config['other']))+'</p>')
    c['col1']['items'][0]['txt1']['text'] = ''.join(ps)
    return c


def credits_block(seed, config):
    c = clone(seed)
    org = html.escape(str(config.get('organization','北京大学信息科学技术学院学生会')))
    lines = [f'<p style="text-align: right;">{org}</p>']
    for key, caption in [('copy','文案'),('layout','排版'),('proofread','校对')]:
        lines.append('<p style="text-align: right;"><strong>' + caption + '丨</strong>' + html.escape(str(config.get(key,''))) + '</p>')
    c['txt1']['text'] = ''.join(lines)
    return c


def scan_slots(modules):
    slots = []
    def walk(x, path):
        if isinstance(x, dict):
            if x.get('type') == 'text' and isinstance(x.get('text'), str):
                soup = BeautifulSoup(x['text'], 'html.parser')
                runs = [s for s in soup.descendants if isinstance(s, NavigableString) and not isinstance(s, Comment)]
                # A blank text component is editable in Xiumi but has no DOM text run.
                # Do not invent a phantom replacement slot for <p><br></p>.
                for i, n in enumerate(runs):
                    txt=str(n)
                    if txt.strip():
                        slots.append({'id':f't:{json.dumps(path,ensure_ascii=False,separators=(",",":"))}:{i}','kind':'text','module':path[0],'path':path,'run':i,'original':txt})
            if x.get('type')=='image':
                for key in ['src','url','uri','imageUrl','imageURL']:
                    if isinstance(x.get(key),str) and x[key].strip():
                        p = path + [key]
                        slots.append({'id':f'i:{json.dumps(p,ensure_ascii=False,separators=(",",":"))}','kind':'image','module':path[0],'path':path,'field':key,'original':x[key]})
                        break
            for k,v in x.items():
                if isinstance(v,(dict,list)):
                    walk(v, path+[k])
        elif isinstance(x,list):
            for i,v in enumerate(x):walk(v,path+[i])
    for i, mod in enumerate(modules):
        walk(mod,[i])
    if len(slots)>SLOT_LIMIT:
        raise ValueError('Too many text/image slots')
    return slots


def build(data, design):
    if design.get('schema') != SCHEMA:
        raise ValueError('Unsupported native design schema')
    if not isinstance(data,dict):
        raise ValueError('Weekly content must be a JSON object')
    warnings=[]
    seeds = design['seeds']
    mods=[]
    def emit(mod):
        if len(mods)>=ITEM_LIMIT:
            raise ValueError('Too many native modules')
        c=clone(mod);new_uuids(c);mods.append(c);return len(mods)-1
    def divider():emit(seeds['divider'])
    def group_panel(key, section_title, categories):
        if not categories or not any(g.get('items') for g in categories):return False
        emit(section_heading(seeds['section'], section_title))
        p=news_panel(seeds['news_panel'],categories,bool(data.get('links_enabled',True)),warnings,section=key)
        if p:emit(p)
        return True

    emit(seeds['banner'])
    emit(seeds['code_intro'])
    divider()
    if data.get('submission',{}).get('enabled',True):
        emit(seeds['submission'])
        warnings.append('投稿二维码沿用参考推文，请确认本期入口是否仍有效')
        divider()
    have_review = group_panel('review','上周回顾',data.get('review',[]))
    upcoming_groups=data.get('upcoming',[])
    if upcoming_groups and any(g.get('items') for g in upcoming_groups):
        if have_review:
            divider()
            emit(seeds['transition_review'])
        group_panel('upcoming','下周及后续',upcoming_groups)
    # Always insert the native Baijiang performance box after upcoming news and before notices.
    # Its body stays empty; the user completes this section directly in Xiumi.
    divider()
    emit(shows_panel(seeds['shows_panel']))
    notes=data.get('notices',[])
    if notes:
        divider()
        emit(seeds['transition_notice'])
        emit(section_heading(seeds['section'],'重要提示'))
        emit(notice_panel(seeds['notice_panel'],notes,warnings))
    if data.get('contact',{}).get('enabled',True):
        divider()
        emit(contact_block(seeds['contact'],data.get('contact',{})))
    emit(seeds['code_outro'])
    emit(credits_block(seeds['credits'],data.get('credits',{})))
    emit(seeds['footer'])
    if len(mods)>500:
        raise ValueError('Template exceeds plugin module limit')
    source=design['source']
    slots=scan_slots(mods)
    bp={
      'schema':'opslion-native-blueprint/v1',
      'adapter':'xiumi-v5-model/0.6.0',
      'source': source,
      'capturedAt':design['capturedAt'],
      'modules':mods,
      'pageStyle':clone(design['pageStyle']),
      'slots':slots
    }
    sequence=[{'id':f'block-{i+1}','source':i,'edits':{}} for i in range(len(mods))]
    if any(q in json.dumps(mods,ensure_ascii=False) for q in ['【待替换】','【以本期资料为准】','【填写来源支持的活动要点】']):
        warnings.append('当前包含示例占位信息，正式发布前需替换或删除')
    output={
      'schema':'xiumi-bridge/v4',
      'mode':'native-layout',
      'title': str(data.get('title') or 'Hello Week丨本期'),
      'nativeLayout':{'schema':'opslion-native-layout-plan/v1','blueprint':bp,'sequence':sequence}
    }
    size=len(json.dumps({'modules':mods,'pageStyle':bp['pageStyle']},ensure_ascii=False))
    if size>8_000_000:
        raise ValueError('Native model exceeds 8MB bridge limit')
    return output,warnings


def main():
    ap=argparse.ArgumentParser(description='Build Hello Week v4 native import bundle')
    ap.add_argument('weekly_json',help='A weekly-content.json file')
    ap.add_argument('-o','--output',help='Path to output .xiumi.json')
    ap.add_argument('--design',default=str(ROOT/'hello-week.template.json'),help='Native design seeds')
    args=ap.parse_args()
    content=json.loads(Path(args.weekly_json).read_text(encoding='utf-8'))
    design=json.loads(Path(args.design).read_text(encoding='utf-8'))
    packet,warnings=build(content,design)
    output=Path(args.output or (ROOT/(re.sub(r'[^\w\u3400-\u9fff\-]+','_',packet['title'])+'.xiumi.json')))
    output.write_text(json.dumps(packet,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Generated',output)
    print('Native modules:',len(packet['nativeLayout']['blueprint']['modules']))
    print('Native text/image slots:',len(packet['nativeLayout']['blueprint']['slots']))
    for w in list(dict.fromkeys(warnings)):
        print('REVIEW:',w)

if __name__=='__main__':
    main()
