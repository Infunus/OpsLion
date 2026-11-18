#!/usr/bin/env python3
"""Xiumi v4 editorial diff and change-ledger review.

A small, explained wording change is permitted. Unreviewed changes are not.
The script cannot judge meaning, factual correctness, or editorial necessity.
"""
import argparse
import copy
import html
import json
import re
import sys
import unicodedata
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from html.parser import HTMLParser

CATEGORIES={"punctuation", "typo", "wording", "grammar", "layout", "add_sentence", "delete_sentence", "factual_correction", "other"}

class ParagraphCollector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth=0; self.chunks=[]; self.paragraphs=[]
    def handle_starttag(self,tag,attrs):
        if tag=='p':
            if self.depth==0:self.chunks=[]
            self.depth+=1
        elif tag=='br' and self.depth:self.chunks.append('\n')
    def handle_startendtag(self,tag,attrs):
        if tag=='br' and self.depth:self.chunks.append('\n')
    def handle_data(self,data):
        if self.depth:self.chunks.append(data)
    def handle_endtag(self,tag):
        if tag=='p' and self.depth:
            self.depth-=1
            if self.depth==0:self.paragraphs.append(''.join(self.chunks))

def norm(text):
    """Ignore layout-only whitespace, not Chinese punctuation or word choice."""
    return re.sub(r'\s+','',unicodedata.normalize('NFC',html.unescape(text or '')))

def source_units(path):
    if path.suffix.lower()=='.docx':
        from docx import Document
        from docx.text.paragraph import Paragraph
        from docx.table import Table,_Cell
        doc=Document(path); text=[]; photos=0; tables=0
        for e in doc.element.body.iterchildren():
            if e.tag.endswith('}p'):
                p=Paragraph(e,doc)
                if p.text.strip():text.append(p.text)
                photos+=len(e.xpath('.//a:blip'))
            elif e.tag.endswith('}tbl'):
                tables+=1;table=Table(e,doc)
                for row in table.rows:
                    for tc in row._tr.tc_lst: # actual cells, no duplicate merged aliases
                        c=_Cell(tc,table)
                        for p in c.paragraphs:
                            if p.text.strip():text.append(p.text)
        return text,photos,tables
    if path.suffix.lower() in ('.txt','.md'):
        return [s for s in path.read_text('utf-8').splitlines() if s.strip()],None,None
    raise ValueError('Source must be .docx, .txt, or .md')

def walk(x):
    if isinstance(x,dict):
        yield x
        for k,v in x.items():
            if k not in ('poster','_$raHTML','_viewport','$$hashKey'):
                yield from walk(v)
    elif isinstance(x,list):
        for v in x:yield from walk(v)

def resolve_path(o,path):
    for p in path:o=o[p]
    return o

def apply_text_edit(cell,run,value,original):
    # Edits in an OpsLion packet address an individual HTML text run.
    # BeautifulSoup is not a required dependency: use a simple token approach and
    # fail visibly on ambiguous markup rather than silently ignoring edits.
    chunks=re.split(r'(<[^>]*>)',cell.get('text',''))
    pos=[i for i in range(0,len(chunks),2) if chunks[i]]
    if run<0 or run>=len(pos):
        raise ValueError('Text edit run index outside captured HTML nodes')
    i=pos[run]
    if html.unescape(chunks[i]) != original:
        raise ValueError('Text edit original no longer matches captured HTML; inspect manually')
    chunks[i]=html.escape(value,quote=False)
    cell['text']=''.join(chunks)

def target_units(packet,content_module):
    data=packet['nativeLayout'];bp=data['blueprint'];mods=bp['modules'];slots={s['id']:s for s in bp.get('slots',[])}
    texts=[]; image_edit_count=0
    for entry in data['sequence']:
        i=entry['source']
        if content_module is not None and i!=content_module:continue
        model=copy.deepcopy(mods[i]);edits=entry.get('edits',{})
        for key,val in edits.items():
            slot=slots.get(key)
            if slot is None or slot['module']!=i:
                raise ValueError('Unresolved edit slot: '+key)
            node=resolve_path(model,slot['path'][1:])
            if slot['kind']=='text':
                apply_text_edit(node,slot['run'],val,slot['original'])
            elif slot['kind']=='image':
                node[slot['field']]=val
                if isinstance(val,str) and val.startswith('data:image/'):
                    image_edit_count+=1
        for node in walk(model):
            if node.get('type')=='text' and isinstance(node.get('text'),str):
                col=ParagraphCollector();col.feed(node['text']);texts.extend(col.paragraphs)
    return texts,image_edit_count

def image_srcs(obj):
    return [x['src'] for x in walk(obj) if x.get('type')=='image' and isinstance(x.get('src'),str)]

def diff_counter(source,target):
    sc=Counter(norm(s) for s in source if norm(s))
    tc=Counter(norm(s) for s in target if norm(s))
    return sc,tc,sc-tc,tc-sc

def change_review(missing,unexpected,changes):
    missing=missing.copy();unexpected=unexpected.copy()
    errors=[];accepted=[];high_risk=[]
    for i,entry in enumerate(changes):
        before=norm(entry.get('before',''));after=norm(entry.get('after',''))
        reason=str(entry.get('reason','')).strip();loc=str(entry.get('location','')).strip()
        category=entry.get('kind')
        errs=[]
        if not before and not after:errs.append('before and after are both blank')
        if before==after:errs.append('no text difference in registered change')
        if not reason:errs.append('missing reason')
        if not loc:errs.append('missing location')
        if not entry.get('reviewed',False):errs.append('not reviewed')
        if category not in CATEGORIES:errs.append('invalid kind')
        if category=='factual_correction' and not str(entry.get('evidence','')).strip():errs.append('factual correction must cite evidence')
        if before and missing[before]<1:errs.append('before is not an unmatched original paragraph')
        if after and unexpected[after]<1:errs.append('after is not an unmatched output paragraph')
        if errs:
            errors.append({'index':i,'errors':errs})
            continue
        if before:missing[before]-=1
        if after:unexpected[after]-=1
        accepted.append(entry)
        if before and after and len(before)>=80 and len(after)<len(before)*0.4:
            high_risk.append({'index':i,'issue':'large paragraph contraction; assess loss of substantive details'})
        if len(before)>=50 and not after:
            high_risk.append({'index':i,'issue':'deletion of a full substantial paragraph; confirm necessity'})
    return missing,unexpected,accepted,errors,high_risk

def suggest_pairs(missing,unexpected):
    """Only propose likely text-unit matches. Never auto-approve an edit."""
    originals=list(missing.elements()); outputs=list(unexpected.elements())
    suggestions=[]
    while originals and outputs:
        candidates=[(SequenceMatcher(None,a,b).ratio(),i,j) for i,a in enumerate(originals) for j,b in enumerate(outputs)]
        ratio,i,j=max(candidates,default=(0,None,None))
        if ratio<0.35:break
        source=originals.pop(i);target=outputs.pop(j)
        suggestions.append({'before':source,'after':target,'similarity':round(ratio,3),'kind':'wording','location':'（待定位）','reason':'（待编辑审核）','reviewed':False})
    return suggestions

def markdown(result):
    out=['# 文案改动说明','',f'原文文字单元：{result["source_paragraph_units"]}；逐字未变：{result["unchanged_paragraph_units"]}；已登记修改：{len(result["reviewed_changes"])}','']
    if not result['reviewed_changes']:
        out.append('本次未登记文字改动。')
    for i,c in enumerate(result['reviewed_changes'],1):
        out.extend([f'{i}. **{c["location"]}**（{c["kind"]}）',f'   - 原文：{c.get("before") or "（无，新增内容）"}',f'   - 成稿：{c.get("after") or "（无，删除内容）"}',f'   - 原因：{c["reason"]}'])
    if result['pending_missing_count'] or result['pending_unexpected_count']:
        out+=['','**仍有未登记的文字差异，不能作为最终改动说明。**']
    if result['high_risk_flags']:
        out+=['','**需要进一步人工审查的改动：**']+[f'- 第 {x["index"]+1} 项：{x["issue"]}' for x in result['high_risk_flags']]
    out+=['','备注：此报告仅记录/核对文字差异；事实准确性、叙事侧重点及真实秀米排版需另外审阅。']
    return '\n'.join(out)+'\n'

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',required=True)
    p.add_argument('--packet',required=True)
    p.add_argument('--out')
    p.add_argument('--changes',help='JSON ledger with changes:[{before,after,kind,location,reason,reviewed}]')
    p.add_argument('--markdown-report')
    p.add_argument('--template',help='Original native template, used to verify fixed tail image')
    p.add_argument('--content-module',type=int,default=3,help='Source native module (default 3, -1 for all)')
    a=p.parse_args()
    src,photos,tables=source_units(Path(a.source))
    pkt=json.loads(Path(a.packet).read_text('utf-8'))
    tgt,img_edits=target_units(pkt,None if a.content_module<0 else a.content_module)
    sc,tc,missing,unexpected=diff_counter(src,tgt)
    missing_before=missing.copy();unexpected_before=unexpected.copy()
    changes=[]
    if a.changes:
        data=json.loads(Path(a.changes).read_text('utf-8'))
        changes=data if isinstance(data,list) else data.get('changes',[])
        if not isinstance(changes,list):raise ValueError('changes must be an array')
    remaining_m,remaining_u,reviewed,errors,high_risk=change_review(missing,unexpected,changes)
    footer=None
    if a.template:
        original=json.loads(Path(a.template).read_text('utf-8'))
        before=image_srcs(original['nativeLayout']['blueprint']['modules'][-1]);after=image_srcs(pkt['nativeLayout']['blueprint']['modules'][-1]);footer=bool(before) and before==after
    image_ok=(photos is None) or photos==img_edits
    # Tool checks accountable differences only. It cannot judge whether an edit was wise.
    ok=not (sum(remaining_m.values()) or sum(remaining_u.values()) or errors) and image_ok and footer is not False
    result={
      'ok':ok,
      'status':'reviewed' if ok else 'review_needed',
      'source_paragraph_units':sum(sc.values()),
      'unchanged_paragraph_units':sum((sc & tc).values()),
      'initial_missing_count':sum(missing_before.values()),
      'initial_unexpected_count':sum(unexpected_before.values()),
      'pending_missing_count':sum(remaining_m.values()),
      'pending_unexpected_count':sum(remaining_u.values()),
      'pending_missing':[{'text':text,'count':cnt} for text,cnt in remaining_m.items() if cnt][:100],
      'pending_unexpected':[{'text':text,'count':cnt} for text,cnt in remaining_u.items() if cnt][:100],
      'reviewed_changes':reviewed,
      'suggested_unreviewed_pairs':suggest_pairs(remaining_m,remaining_u),
      'ledger_errors':errors,
      'high_risk_flags':high_risk,
      'word_tables':tables,
      'word_inline_images':photos,
      'data_image_edits':img_edits,
      'image_count_match':image_ok,
      'fixed_tail_image_preserved':footer,
      'scope_notice':'Checks raw Word body paragraphs and actual table-cell paragraphs against visible native text units; does not assess meaning, image positioning, embedded text boxes or actual Xiumi rendering. Editorial review remains necessary.',
      'source':a.source,
      'packet':a.packet
    }
    if a.out:Path(a.out).write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
    if a.markdown_report:Path(a.markdown_report).write_text(markdown(result),'utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if ok else 1

if __name__=='__main__':sys.exit(main())
