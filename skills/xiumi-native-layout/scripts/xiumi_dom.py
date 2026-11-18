"""Small loss-aware DOM for captured (browser-serialized) HTML. No network/dependencies.
Not an HTML5 browser. Use browser_check.py for browser round-trip and visual checks.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from html.parser import HTMLParser
from html import escape
import copy, re, hashlib, json

VOID = set('area base br col embed hr img input link meta param source track wbr'.split())
SVG_CASE = {s.lower(): s for s in ('foreignObject textPath clipPath linearGradient radialGradient animateTransform '
 'feBlend feColorMatrix feComponentTransfer feFuncR feFuncG feFuncB feFuncA feComposite feFlood feGaussianBlur '
 'feMerge feMergeNode feMorphology feOffset feDropShadow feTurbulence feDisplacementMap feTile').split()}
ATTR_CASE = {s.lower(): s for s in ('viewBox preserveAspectRatio pathLength textLength lengthAdjust gradientUnits '
 'gradientTransform spreadMethod patternUnits patternContentUnits patternTransform clipPathUnits maskUnits '
 'maskContentUnits refX refY markerUnits markerWidth markerHeight filterUnits primitiveUnits stdDeviation '
 'baseFrequency numOctaves stitchTiles kernelMatrix kernelUnitLength targetX targetY edgeMode preserveAlpha '
 'attributeName attributeType repeatCount repeatDur calcMode keyTimes keySplines').split()}
PAGE_PROPERTIES = 'font-family font-size line-height letter-spacing color text-align text-indent padding-top padding-right padding-bottom padding-left background-color background-image background-size background-position background-repeat'.split()
URL_RE = re.compile(r'''url\(\s*(["']?)([^"')]+)\1\s*\)''', re.I)
BAD_STYLE = re.compile(r'[\\]|/\*|(?:expression|var|attr|env|image-set)\s*\(|(?:javascript|vbscript)\s*:', re.I)
BLOCKS = set('section article main header footer div p h1 h2 h3 h4 h5 h6 blockquote ul ol li table tr td th figure figcaption'.split())

class LayoutError(ValueError): pass

@dataclass
class Node:
    tag: str = '#text'
    attrs: dict[str,str] = field(default_factory=dict)
    children: list['Node'] = field(default_factory=list)
    text: str = ''
    uid: str = ''
    parent: 'Node | None' = field(default=None, repr=False, compare=False)
    def add(self, n):
        n.parent=self; self.children.append(n); return n
    def walk(self):
        yield self
        for c in self.children: yield from c.walk()
    def clone(self):
        n=Node(self.tag, dict(self.attrs), text=self.text, uid=self.uid)
        for c in self.children: n.add(c.clone())
        return n
    def plain(self):
        if self.tag=='#text': return self.text
        if self.tag=='br': return '\n'
        if self.tag in ('#comment','script','style'): return ''
        return ''.join(c.plain() for c in self.children)
    def html(self):
        if self.tag=='#text': return escape(self.text, quote=False)
        if self.tag=='#comment': return '<!--'+self.text.replace('--','—')+'-->'
        inner=''.join(c.html() for c in self.children)
        if self.tag=='#root': return inner
        attrs=''.join(' '+k+'="'+escape(str(v),quote=True)+'"' for k,v in self.attrs.items())
        if self.tag.lower() in VOID: return '<'+self.tag+attrs+'>'
        return '<'+self.tag+attrs+'>'+inner+'</'+self.tag+'>'

def ancestors(n):
    while n.parent:
        n=n.parent; yield n

def nearest(n, tag):
    return next((x for x in [n,*ancestors(n)] if x.tag==tag), None)

class CaptureParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True); self.root=Node('#root');self.stack=[self.root];self.problems=[]
    def handle_starttag(self, tag, attrs):
        svg=tag=='svg' or any(n.tag=='svg' for n in self.stack)
        tag=SVG_CASE.get(tag,tag) if svg else tag
        vals={ATTR_CASE.get(k,k) if svg else k: v or '' for k,v in attrs}
        n=self.stack[-1].add(Node(tag,vals))
        if tag.lower() not in VOID: self.stack.append(n)
    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs)
        if tag.lower() not in VOID: self.stack.pop()
    def handle_endtag(self,tag):
        if tag in VOID: return
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag.lower()==tag.lower():
                if i!=len(self.stack)-1: self.problems.append('隐式闭合: '+tag)
                self.stack=self.stack[:i];return
        self.problems.append('无对应开始标签: '+tag)
    def handle_data(self,data):
        if data:
            p=self.stack[-1]
            if p.children and p.children[-1].tag=='#text': p.children[-1].text+=data
            else: p.add(Node(text=data))
    def handle_comment(self,data): self.stack[-1].add(Node('#comment',text=data))
    def handle_decl(self,decl): pass

def parse_html(text, strict=True):
    p=CaptureParser();p.feed(text);p.close()
    if len(p.stack)>1: p.problems.append('未闭合: '+','.join(n.tag for n in p.stack[1:]))
    if strict and p.problems: raise LayoutError('模板不是可靠的浏览器序列化片段: '+'; '.join(p.problems[:5]))
    for i,n in enumerate(p.root.walk()): n.uid=('t' if n.tag=='#text' else 'e')+str(i).zfill(5)
    return p.root

def get_node(root,uid):
    matches=[n for n in root.walk() if n.uid==uid]
    if len(matches)!=1: raise LayoutError(f'节点 {uid} 匹配 {len(matches)} 处；请在对应 repeat 实例内编辑')
    return matches[0]

def replace_node(old,items):
    if old.parent is None: raise LayoutError('不能替换文档根')
    p=old.parent; i=p.children.index(old)
    for n in items: n.parent=p
    p.children[i:i+1]=items

def css_parse(raw):
    # Semicolons inside quoted data URLs/functions must not split declarations.
    out={};chunk=[];quote=None;level=0
    def add(s):
        if ':' in s:
            k,v=s.split(':',1);out[k.strip().lower()]=v.strip()
    for c in raw+';':
        if quote:
            chunk.append(c)
            if c==quote: quote=None
        elif c in ('"',"'"): quote=c;chunk.append(c)
        elif c=='(': level+=1;chunk.append(c)
        elif c==')': level-=1;chunk.append(c)
        elif c==';' and level==0: add(''.join(chunk));chunk=[]
        else: chunk.append(c)
    return out

def css_string(d): return ';'.join(k+':'+v for k,v in d.items() if v!='')

def content_root(root):
    els=[c for c in root.children if c.tag not in ('#text','#comment')]
    if len(els)==1 and not any(c.tag=='#text' and c.text.strip() for c in root.children): return els[0]
    n=Node('section',uid='wrapper')
    for c in root.children: n.add(c)
    root.children=[n];n.parent=root;return n

def top_modules(root):
    targets=[n for n in root.walk() if 'tn-comp-top-level' in n.attrs.get('class','').split() and not any('tn-comp-top-level' in a.attrs.get('class','').split() for a in ancestors(n))]
    return targets

def partition(root, targets, page_format):
    """Port of bridge-contract.ts partitionNativeArticle: retain ancestor shells."""
    indexes={id(n):i for i,n in enumerate(targets or [root])};current=[0]
    def split(n):
        if id(n) in indexes:
            current[0]=indexes[id(n)];return {current[0]:n.clone()}
        if not n.children: return {current[0]:n.clone()}
        pieces={}
        for c in n.children:
            for k,child in split(c).items():
                if k not in pieces: pieces[k]=Node(n.tag,dict(n.attrs),text=n.text,uid=n.uid)
                pieces[k].add(child)
        return pieces
    out=[]
    for k,n in split(root).items():
        if n.tag=='#root':
            holder=Node('section');[holder.add(c) for c in n.children];n=holder
        st=css_parse(n.attrs.get('style',''))
        for prop in PAGE_PROPERTIES: st.pop(prop,None)
        # Shorthands duplicate page padding/background when copied across modules.
        if all('padding-'+x in page_format for x in ('top','right','bottom','left')): st.pop('padding',None)
        if any(x.startswith('background-') for x in page_format): st.pop('background',None)
        if st: n.attrs['style']=css_string(st)
        else: n.attrs.pop('style',None)
        for el in n.walk():
            for a in list(el.attrs):
                if re.match(r'^data-(op-|layout-)',a): del el.attrs[a]
        out.append(n)
    return out

def scope_clone_ids(root, suffix):
    ids={n.attrs['id']:n.attrs['id']+'_'+suffix for n in root.walk() if 'id' in n.attrs}
    # A repeated fragment must contain its referenced defs; check dangling later.
    for n in root.walk():
        if 'id' in n.attrs: n.attrs['id']=ids[n.attrs['id']]
        for k,v in list(n.attrs.items()):
            if k=='id':continue
            if k in ('href','xlink:href') and v.startswith('#') and v[1:] in ids: v='#'+ids[v[1:]]
            for old,new in ids.items():
                v=re.sub(r'(url\(\s*[\'\"]?#)'+re.escape(old)+r'(?=[\'\"]?\s*\))',lambda m:m.group(1)+new,v)
                if k in ('begin','end'): v=re.sub(r'(?<![\w.-])'+re.escape(old)+r'\.',new+'.',v)
            n.attrs[k]=v

def digest(value):
    if not isinstance(value,(str,bytes)): value=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))
    if isinstance(value,str):value=value.encode()
    return hashlib.sha256(value).hexdigest()
