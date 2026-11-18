#!/usr/bin/env python3
"""Review bold/emphasis transfer from a Word file to a native Xiumi v4 packet.

This is an editorial candidate audit. It cannot verify the real editor's rendering
or infer arbitrary semantic title groups. Title groups are supplied by the AI,
never by the user, after it has identified heading roles in the workplan.
"""
import argparse, html, json, re, sys
from html.parser import HTMLParser
from pathlib import Path
from docx import Document
from docx.table import _Cell


def weight(style):
    if not isinstance(style,dict):return False
    v=style.get('fontWeight',style.get('font-weight',''))
    return str(v).lower() in ('bold','bolder') or (str(v).isdecimal() and int(v)>=600)


def word_runs(doc):
    yield from doc.paragraphs
    for table in doc.tables:
        for row in table.rows:
            # Actual XML cells only: merged table cells can appear multiple times
            # in python-docx row.cells, but must be audited once.
            for tc in row._tr.tc_lst:
                yield from _Cell(tc,table).paragraphs


def source_emphasis(path):
    doc=Document(path);spans=[]
    for paragraph in word_runs(doc):
        current=''
        for run in paragraph.runs:
            bold=run.bold
            if bold is None:
                try:bold=run.style.font.bold
                except Exception:bold=None
            if bold is None:
                try:bold=paragraph.style.font.bold
                except Exception:bold=None
            if bold and run.text:current+=run.text
            elif current:
                if current.strip():spans.append(current.strip())
                current=''
        if current.strip():spans.append(current.strip())
    return spans


class BoldHTML(HTMLParser):
    def __init__(self,edit_runs,full_bold=False):
        super().__init__(convert_charrefs=True)
        self.edits=edit_runs;self.default=bool(full_bold);self.flags=[]
        self.index=0;self.bold_segments=[];self.current=''
    def _flush(self):
        if self.current.strip():self.bold_segments.append(self.current)
        self.current=''
    def handle_starttag(self,tag,attrs):
        # HTML void tags do not receive closing events, and must not remain
        # on the font-weight stack (else following text is falsely bold).
        if tag in ('br','hr','img','meta','input','wbr'):
            self._flush()
            return
        props=dict(attrs)
        style=props.get('style','')
        match=re.search(r'font-weight\s*:\s*(bold|bolder|[6-9]00)',style,re.I)
        flag=tag in ('strong','b') or bool(match)
        self.flags.append(self.default or flag or (self.flags[-1] if self.flags else False))
    def handle_startendtag(self,tag,attrs):
        if tag=='br':self._flush()
    def handle_endtag(self,tag):
        if tag in ('p','div','br'):self._flush()
        if self.flags:self.flags.pop()
    def handle_data(self,data):
        t=self.edits.get(self.index,data);self.index+=1
        if self.default or (self.flags and self.flags[-1]):self.current+=t
        else:self._flush()
    def segments(self):
        self._flush();return self.bold_segments


def output_emphasis(packet):
    blueprint=packet['nativeLayout']['blueprint'];slot_lookup={s['id']:s for s in blueprint['slots']}
    bold_segments=[];alltexts=[]
    def traverse(obj,path):
        if isinstance(obj,dict):
            if obj.get('type')=='text' and isinstance(obj.get('text'),str):
                yield path,obj
            for k,v in obj.items():
                if k not in ('poster','_$raHTML','_viewport'):
                    yield from traverse(v,path+[k])
        elif isinstance(obj,list):
            for i,v in enumerate(obj):yield from traverse(v,path+[i])
    for seq in packet['nativeLayout']['sequence']:
        source=seq['source']
        edits={}
        for key,val in seq['edits'].items():
            slot=slot_lookup[key]
            if slot['kind']=='text':edits.setdefault(tuple(slot['path']),{})[slot['run']]=val
        for path,cell in traverse(blueprint['modules'][source],[source]):
            parsed=BoldHTML(edits.get(tuple(path),{}),weight(cell.get('style')))
            parsed.feed(cell['text'])
            bold_segments.extend(parsed.segments())
            # A second parser for text with edits, without stripping real markup
            class Plain(HTMLParser):
                def __init__(self,edits):super().__init__(convert_charrefs=True);self.edits=edits;self.i=0;self.acc=''
                def handle_data(self,t):self.acc+=self.edits.get(self.i,t);self.i+=1
            plain=Plain(edits.get(tuple(path),{}));plain.feed(cell['text']);alltexts.append(plain.acc)
    return bold_segments,alltexts


def normalize(s):return re.sub(r'\s+','',html.unescape(s))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',required=True,help='Word .docx source')
    p.add_argument('--packet',required=True,help='Native .xiumi.json output')
    p.add_argument('--title-groups',help='JSON of AI-identified groups of same-role heading titles')
    p.add_argument('--out')
    args=p.parse_args()
    spans=source_emphasis(args.source)
    blob,alltext=output_emphasis(json.loads(Path(args.packet).read_text('utf-8')))
    joined='|'.join(normalize(x) for x in blob)
    missing=[s for s in spans if normalize(s) and normalize(s) not in joined]
    group_reports=[]
    if args.title_groups:
        groups=json.loads(Path(args.title_groups).read_text('utf-8'))['groups']
        for group in groups:
            name=group['name'];titles=group['titles']
            rows=[{'title':t,'present':any(normalize(t) in normalize(x) for x in alltext),
                   'bold':any(normalize(t) in normalize(x) for x in blob)} for t in titles]
            group_reports.append({'name':name,'members':rows,'consistent_bold':bool(rows) and all(r['present'] and r['bold'] for r in rows)})
    report={'ok':not missing and all(g['consistent_bold'] for g in group_reports),
            'source_bold_spans':len(spans),'missing_bold_spans':missing,
            'output_bold_segments':len(blob),'title_groups':group_reports,
            'warning':'This is a markup-based check; manually inspect Word inherited formatting, title hierarchy and real Xiumi rendering.'}
    if args.out:Path(args.out).write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report['ok'] else 1

if __name__=='__main__':sys.exit(main())
