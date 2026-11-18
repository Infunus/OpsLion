import json,pathlib,collections
from playwright.sync_api import sync_playwright
p=pathlib.Path(__file__).resolve().parent.parent/'HelloWeek_原生模板示范稿.xiumi.json'
pkg=json.loads(p.read_text(encoding='utf8'))
b=pkg['nativeLayout']['blueprint']
cells={}
for s in b['slots']:
 if s['kind']!='text':continue
 node=b['modules'][s['module']]
 for k in s['path'][1:]:node=node[k]
 cells[json.dumps(s['path'],ensure_ascii=False)]=node['text']
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 page=browser.new_page()
 result=page.evaluate('''(cells) => {
 const result={};
 for(const [k,v] of Object.entries(cells)){
  const holder=document.createElement('template'); holder.innerHTML=v;
  const walk=document.createTreeWalker(holder.content,NodeFilter.SHOW_TEXT),out=[];
  while(walk.nextNode()) out.push(walk.currentNode.nodeValue);
  result[k]=out;
 }
 return result;
 }''',cells)
 browser.close()
for s in b['slots']:
 if s['kind']!='text':continue
 r=result[json.dumps(s['path'],ensure_ascii=False)]
 if not (0<=s['run']<len(r) and r[s['run']]==s['original']):
  print('FAIL',s,'actual',r[s['run']] if s['run']<len(r) else 'missing')
  raise SystemExit(1)
print('PASS browser DOM TreeWalker: all',sum(x['kind']=='text' for x in b['slots']),'text runs match')
