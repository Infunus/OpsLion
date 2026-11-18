"""Raw material ingestion. ZIP, DOCX OOXML, text/Markdown, HTML, image files.
No model API; no network; no shell invocation; source bytes remain unchanged.
"""
from __future__ import annotations
import base64, io, json, re, posixpath, stat, zipfile, hashlib
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET
from xiumi_dom import LayoutError, parse_html, digest

NS={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
 'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
 'a':'http://schemas.openxmlformats.org/drawingml/2006/main',
 'wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
 'v':'urn:schemas-microsoft-com:vml'}
W='{'+NS['w']+'}'; R='{'+NS['r']+'}'
MAX_BYTES=256*1024*1024;MAX_FILE=64*1024*1024;MAX_IMAGE=12*1024*1024
IMAGES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif'}

def xml(data):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper(): raise LayoutError('拒绝 XML 外部实体 / DTD')
    return ET.fromstring(data)

def read_zip(data):
    z=zipfile.ZipFile(io.BytesIO(data)); infos=z.infolist()
    if len(infos)>4000 or sum(i.file_size for i in infos)>MAX_BYTES: raise LayoutError('压缩包展开量超限')
    seen=set();out={}
    for i in infos:
        name=i.filename.replace('\\','/')
        if i.is_dir():continue
        if name.startswith('/') or re.match(r'^[A-Za-z]:',name) or '..' in PurePosixPath(name).parts:raise LayoutError('压缩包包含越界路径')
        if stat.S_ISLNK(i.external_attr>>16):raise LayoutError('压缩包不能含符号链接')
        if i.flag_bits & 1:raise LayoutError('请先解密压缩包')
        if i.file_size>MAX_FILE:raise LayoutError('单文件展开量超过 64 MiB')
        if name in seen:raise LayoutError('压缩包有重名文件: '+name)
        seen.add(name)
        if '__MACOSX' in PurePosixPath(name).parts or PurePosixPath(name).name.startswith(('._','~$')):continue
        out[name]=z.read(i)
    return out

def decode(data):
    for enc in ['utf-8-sig','utf-16' if data[:2] in (b'\xff\xfe',b'\xfe\xff') else 'gb18030']:
        try:return data.decode(enc)
        except UnicodeError:pass
    raise LayoutError('无法无损识别文本编码')

def image_info(data, suffix):
    mime=IMAGES.get(suffix.lower())
    if not mime:raise LayoutError('图片格式不受原生导入协议支持: '+suffix)
    if len(data)>MAX_IMAGE:raise LayoutError('单张图片超过 12 MiB；请明确决定压缩或替换')
    expected = ((mime=='image/png' and data.startswith(b'\x89PNG\r\n\x1a\n')) or
      (mime=='image/jpeg' and data.startswith(b'\xff\xd8')) or (mime=='image/gif' and data[:6] in (b'GIF87a',b'GIF89a')) or
      (mime=='image/webp' and data[:4]==b'RIFF' and data[8:12]==b'WEBP') or
      (mime=='image/avif' and b'ftyp' in data[:32] and (b'avif' in data[:64] or b'avis' in data[:64])))
    if not expected:raise LayoutError('图片扩展名与内容不一致')
    size=None
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            size=list(im.size)
            if im.width*im.height>80_000_000:raise LayoutError('图片像素总量过大')
            im.verify()
    except ImportError:pass
    except LayoutError:raise
    except Exception as e:raise LayoutError('图片解码失败: '+str(e))
    return mime,size

class Ingest:
    def __init__(self):
        self.files=[];self.blocks=[];self.assets=[];self.issues=[];self._asset_hash={};self.total=0
    def issue(self,file,kind,message,blocking=True):
        item={'id':'Q'+str(len(self.issues)+1).zfill(4),'file':file,'kind':kind,'message':message,'blocking':blocking}
        self.issues.append(item);return item['id']
    def add_asset(self,data,name,origin):
        h=digest(data)
        if h in self._asset_hash:
            a=self._asset_hash[h];a['sources'].append({'name':name,'origin':origin});return a['id']
        mime,size=image_info(data,Path(name).suffix)
        a={'id':'A'+str(len(self.assets)+1).zfill(4),'sha256':h,'mime':mime,'bytes':len(data),'size':size,
           'src':'data:'+mime+';base64,'+base64.b64encode(data).decode(),'sources':[{'name':name,'origin':origin}]}
        self.assets.append(a);self._asset_hash[h]=a;return a['id']
    def block(self,file,kind,text='',runs=None,**meta):
        b={'id':'B'+str(len(self.blocks)+1).zfill(5),'file':file,'kind':kind,'text':text,'runs':runs or [],**meta}
        self.blocks.append(b);return b
    def visit(self,name,data,depth=0):
        if depth>4:raise LayoutError('嵌套压缩包深度超过 4')
        self.total+=len(data)
        if self.total>MAX_BYTES:raise LayoutError('材料总量超过限制')
        suffix=Path(name).suffix.lower()
        if suffix=='.zip':
            for child,raw in read_zip(data).items():self.visit(name+'!/'+child,raw,depth+1)
            return
        fid='F'+str(len(self.files)+1).zfill(4)
        self.files.append({'id':fid,'name':name,'sha256':digest(data),'bytes':len(data),'type':suffix})
        if suffix=='.docx': self.docx(fid,data);return
        if suffix in IMAGES:
            try:self.add_asset(data,name,fid)
            except LayoutError as e:self.issue(fid,'unsupported_image',str(e))
            return
        if suffix in ('.txt','.md'):
            text=decode(data).replace('\r\n','\n').replace('\r','\n')
            for line_no,line in enumerate(text.split('\n'),1):
                if line.strip():self.block(fid,'text',line,runs=[{'text':line}],line=line_no)
            return
        if suffix in ('.html','.htm'):
            root=parse_html(decode(data),strict=False)
            if any(n.tag in ('script','style','iframe') for n in root.walk()):self.issue(fid,'active_html','材料 HTML 含脚本/样式；不执行。需确认正文范围。')
            for n in root.walk():
                if n.tag=='#text' and n.text.strip() and not any(a.tag in ('script','style') for a in self._anc(n)):
                    self.block(fid,'text',n.text,runs=[{'text':n.text}],htmlNode=n.uid)
                if n.tag=='img': self.issue(fid,'html_image','材料 HTML 的图片需提供本地文件或明确远程素材绑定: '+n.attrs.get('src',''))
            return
        self.issue(fid,'unsupported_file','尚未解析此文件: '+name+'；请按 skill 的格式扩展流程读取，不能忽略。')
    def _anc(self,n):
        while n.parent:n=n.parent;yield n
    def docx(self,fid,data):
        members=read_zip(data)
        if 'word/document.xml' not in members:raise LayoutError('DOCX 缺少 word/document.xml')
        doc=xml(members['word/document.xml'])
        rels={}
        if 'word/_rels/document.xml.rels' in members:
            for e in xml(members['word/_rels/document.xml.rels']):rels[e.get('Id')]={'target':e.get('Target',''),'external':e.get('TargetMode')=='External'}
        styles={}
        if 'word/styles.xml' in members:
            for s in xml(members['word/styles.xml']).findall('w:style',NS):
                name=s.find('w:name',NS);ol=s.find('w:pPr/w:outlineLvl',NS)
                styles[s.get(W+'styleId')]={'name':name.get(W+'val','') if name is not None else '', 'level':int(ol.get(W+'val'))+1 if ol is not None else None,
                 'rpr':s.find('w:rPr',NS),'ppr':s.find('w:pPr',NS),'base':s.find('w:basedOn',NS).get(W+'val') if s.find('w:basedOn',NS) is not None else None}
        abstract={};nums={};counters={}
        if 'word/numbering.xml' in members:
            numroot=xml(members['word/numbering.xml'])
            for a in numroot.findall('w:abstractNum',NS):
                abstract[a.get(W+'abstractNumId')]={l.get(W+'ilvl'):l for l in a.findall('w:lvl',NS)}
            for n in numroot.findall('w:num',NS):
                aid=n.find('w:abstractNumId',NS)
                if aid is not None:nums[n.get(W+'numId')]=(aid.get(W+'val'),n)
        if doc.findall('.//w:del',NS) or doc.findall('.//w:ins',NS):self.issue(fid,'tracked_changes','Word 含修订；本次提取“插入保留、删除隐藏”的可见版本。须核对修订版本选择，原 XML 未更改。')
        if doc.findall('.//w:instrText',NS) or doc.findall('.//w:fldSimple',NS):self.issue(fid,'word_fields','Word 包含动态域；当前仅提取已有显示值，不重新计算。')
        if doc.findall('.//w:txbxContent',NS):self.issue(fid,'text_boxes','Word 有文本框；已单列其文字，须确认与正文的阅读顺序。')
        if doc.findall('.//w:altChunk',NS):self.issue(fid,'alt_chunk','Word 含外部嵌入正文，须解析相应关系目标。')
        count=[0]
        def val(parent,path,default=''):
            x=parent.find(path,NS) if parent is not None else None
            return x.get(W+'val',default) if x is not None else default
        def marks(rpr):
            m={}
            if rpr is None:return m
            for key,tag in [('bold','b'),('italic','i'),('underline','u'),('strike','strike'),('strike','dstrike')]:
                e=rpr.find('w:'+tag,NS)
                if e is not None:m[key]=e.get(W+'val','true') not in ('0','false','off','none')
            color=val(rpr,'w:color')
            if color and color!='auto':m['sourceColor']=color
            va=val(rpr,'w:vertAlign')
            if va:m['vertical']=va
            return m
        def inherited(sid,seen=None):
            seen=seen or set()
            if not sid or sid in seen or sid not in styles:return {}
            seen.add(sid);s=styles[sid]
            return {**inherited(s['base'],seen),**marks(s['rpr'])}
        def image(el,pno):
            embeds=[x.get(R+'embed') or x.get(R+'link') for x in el.findall('.//a:blip',NS)]
            embeds += [x.get(R+'id') for x in el.findall('.//v:imagedata',NS)]
            for rid in embeds:
                rel=rels.get(rid)
                if not rel:self.issue(fid,'broken_image','Word 图片关系缺失 '+str(rid));continue
                if rel['external']:
                    self.block(fid,'image',assetId=None,remoteSrc=rel['target'],paragraph=pno)
                    self.issue(fid,'linked_image','Word 外链图未内嵌，需明确解析: '+rel['target']);continue
                target=posixpath.normpath(posixpath.join('word',rel['target']))
                if target.startswith('../') or target not in members:self.issue(fid,'broken_image','Word 图片文件不存在: '+target);continue
                try:aid=self.add_asset(members[target],target,fid)
                except LayoutError as e:self.issue(fid,'unsupported_image',str(e));continue
                alt=next((x.get('descr') or x.get('title') for x in el.findall('.//wp:docPr',NS) if x.get('descr') or x.get('title')),'')
                self.block(fid,'image',assetId=aid,alt=alt,paragraph=pno)
        def paragraph(p,context=None):
            count[0]+=1;pno=count[0];sid=val(p,'w:pPr/w:pStyle')
            level=styles.get(sid,{}).get('level')
            sname=styles.get(sid,{}).get('name','')
            match=re.search(r'(?:Heading|标题)\s*([1-6])',sname or sid,re.I)
            if match:level=int(match.group(1))
            runs=[];chunk=0
            meta={'paragraph':pno,'styleId':sid,'headingLevel':level,**(context or {})}
            ppr=p.find('w:pPr',NS)
            np=p.find('w:pPr/w:numPr',NS)
            if np is None and sid in styles and styles[sid]['ppr'] is not None:np=styles[sid]['ppr'].find('w:numPr',NS)
            if np is not None:
                nid=val(np,'w:numId');lev=val(np,'w:ilvl','0');entry=nums.get(nid)
                if entry:
                    aid,ne=entry;ld=abstract.get(aid,{}).get(lev);start=int(val(ld,'w:start','1'));fmt=val(ld,'w:numFmt','decimal');pattern=val(ld,'w:lvlText','%1.')
                    override=next((x for x in ne.findall('w:lvlOverride',NS) if x.get(W+'ilvl')==lev),None)
                    if override is not None:start=int(val(override,'w:startOverride',str(start)))
                    key=(nid,lev);num=counters.get(key,start-1)+1;counters[key]=num
                    meta['numbering']={'numId':nid,'level':int(lev),'number':num,'format':fmt,'pattern':pattern,'start':start}
                    if lev!='0' or fmt not in ('decimal','bullet'):self.issue(fid,'complex_numbering',f'第 {pno} 段含复杂编号，需按 OOXML 编号定义确认可见标号。')
                    elif fmt=='decimal':meta['numbering']['display']=pattern.replace('%1',str(num))
                    else:meta['numbering']['display']='•'
                else:self.issue(fid,'unknown_numbering',f'第 {pno} 段编号定义缺失')
            def flush():
                nonlocal runs,chunk
                txt=''.join(r['text'] for r in runs)
                if txt:
                    self.block(fid,'heading' if level else 'text',txt,runs,chunk=chunk,**meta);chunk+=1
                runs=[]
            def walk(el,href=None):
                nonlocal runs
                if el.tag==W+'del':return
                if el.tag==W+'hyperlink':
                    rel=rels.get(el.get(R+'id'),{});h=rel.get('target') if rel.get('external') else None
                    if not h:self.issue(fid,'internal_link','Word 内部书签链接不能直接变成秀米发布链接，需处理。')
                    for c in el:walk(c,h)
                    return
                if el.tag==W+'r':
                    rp=el.find('w:rPr',NS);rsid=val(rp,'w:rStyle')
                    m={**inherited(sid),**inherited(rsid),**marks(rp)}
                    for c in el:
                        if c.tag in (W+'drawing',W+'pict'):
                            flush();image(c,pno)
                            # Extract text boxes separately, never silently lose them.
                            for tp in c.findall('.//w:txbxContent/w:p',NS):paragraph(tp,{'textBox':True})
                        elif c.tag in (W+'t',W+'tab',W+'br',W+'cr',W+'noBreakHyphen',W+'softHyphen'):
                            t={W+'tab':'\t',W+'br':'\n',W+'cr':'\n',W+'noBreakHyphen':'‑',W+'softHyphen':'\u00ad'}.get(c.tag,c.text or '')
                            if t:runs.append({'text':t,**m,**({'href':href} if href else {})})
                        elif c.tag in (W+'footnoteReference',W+'endnoteReference'):
                            self.issue(fid,'note_reference',f'第 {pno} 段有脚注/尾注引用 {c.get(W+"id")}；需确认正文中的安放位置。')
                        elif c.tag==W+'sym':self.issue(fid,'symbol',f'第 {pno} 段包含字体符号，需目视确认。')
                    return
                for c in el:
                    if c.tag not in (W+'pPr',W+'rPr'):walk(c,href)
            walk(p);flush()
        def walk_body(el,context=None):
            for c in el:
                if c.tag==W+'p':paragraph(c,context)
                elif c.tag==W+'tbl':
                    table_id='T'+str(count[0]+1)
                    self.issue(fid,'table',f'表格 {table_id} 已逐行逐单元格提取；严格模板中须选已有表格样式或明确批准转换，不能静默扁平化。')
                    for ri,row in enumerate(c.findall('w:tr',NS),1):
                        for ci,cell in enumerate(row.findall('w:tc',NS),1):
                            walk_body(cell,{'table':table_id,'row':ri,'column':ci,'colspan':val(cell,'w:tcPr/w:gridSpan','1'),'vMerge':val(cell,'w:tcPr/w:vMerge','')})
                elif c.tag in (W+'sdt',W+'sdtContent',W+'customXml'):walk_body(c,context)
                elif c.tag not in (W+'sectPr',W+'tblPr',W+'tblGrid',W+'tcPr'):
                    if ''.join(c.itertext()).strip():self.issue(fid,'unparsed_word_block','Word 未识别结构 '+c.tag.split('}')[-1])
        body=doc.find('w:body',NS)
        if body is None:raise LayoutError('Word 缺少正文')
        walk_body(body)
        for name,raw in members.items():
            if re.match(r'word/(?:footnotes|endnotes|header\d+|footer\d+)\.xml$',name):
                extra=xml(raw)
                texts=[''.join(p.itertext()) for p in extra.findall('.//w:p',NS)]
                if any(t.strip() for t in texts):
                    self.issue(fid,'ancillary_word_content','附加区域已提取，须确认沿用或排除: '+name)
                    for p in extra.findall('.//w:p',NS):paragraph(p,{'ancillary':name})
        if 'word/comments.xml' in members:
            self.issue(fid,'comments','Word 含批注；不是已审正文，应核对后分类为编辑说明。')
            cr=xml(members['word/comments.xml'])
            for p in cr.findall('.//w:p',NS):paragraph(p,{'ancillary':'comments'})
    def result(self):
        data={'schema':'opslion-web-materials/v1','files':self.files,'blocks':self.blocks,'assets':self.assets,'issues':self.issues}
        data['hash']=digest(data);return data

def ingest(paths):
    obj=Ingest()
    for path in paths:
        p=Path(path)
        if not p.is_file():raise LayoutError('材料文件不存在: '+str(p))
        if p.stat().st_size>MAX_FILE:raise LayoutError('单文件超过 64 MiB')
        obj.visit(p.name,p.read_bytes())
    return obj.result()
