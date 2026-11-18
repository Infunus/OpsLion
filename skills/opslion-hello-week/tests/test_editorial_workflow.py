"""Regression coverage for native builder + merged editorial conventions."""
import sys,copy,json,pathlib
from bs4 import BeautifulSoup
P=pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0,str(P/'scripts'))
from build import build
from audit_content import audit
DESIGN=json.loads((P/'hello-week.template.json').read_text(encoding='utf-8'))

def text_cells(obj):
    if isinstance(obj,dict):
        if obj.get('type')=='text' and isinstance(obj.get('text'),str): yield obj
        for v in obj.values(): yield from text_cells(v)
    elif isinstance(obj,list):
        for v in obj: yield from text_cells(v)

def base():
    return {'title':'Hello Week丨测试','links_enabled':False,'submission':{'enabled':False},
            'review':[],'upcoming':[],'notices':[],'contact':{'enabled':False},'credits':{}}

def test_regression_blank_baijiang():
    data=base();data['performances']=[{'title':'旧海报','url':'https://not-for-output.example.com'}]
    packet,_=build(data,DESIGN);mods=packet['nativeLayout']['blueprint']['modules']
    positions=[i for i,m in enumerate(mods) if '下周百讲演出速览' in json.dumps(m,ensure_ascii=False)]
    assert len(positions)==1
    shows=mods[positions[0]]
    assert shows['col1']['items'][1]['txt1']['text']=='<p><br></p>'
    assert '旧海报' not in json.dumps(mods,ensure_ascii=False)

def test_nonlink_and_period():
    data=base();data['upcoming']=[{'name':'活动信息','items':[{'title':'可参与活动',
      'fields':[{'label':'时间','value':'11月20日。'}], 'body':'一段正文。第二句。',
      'link':{'label':'原始标题。','url':'https://example.com/abc'}}]}]
    p,_=build(data,DESIGN)
    raw=json.dumps(p['nativeLayout']['blueprint']['modules'],ensure_ascii=False)
    assert '原始标题。' in raw and 'https://example.com/abc' not in raw
    assert '时间：11月20日。' not in raw
    assert '一段正文。第二句。' not in raw

def test_collected_links_enabled_by_default_and_explicitly():
    url='https://mp.weixin.qq.com/s?__biz=example&mid=123&idx=1&sn=abc#wechat_redirect'
    for explicit in (False, True):
        data=base();data.pop('links_enabled')
        if explicit:
            data['links_enabled']=True
        for section in ('review','upcoming'):
            data[section]=[{'name':'活动信息','items':[{'title':'资讯标题',
                'link':{'label':'完整原标题 & 标点。','url':url}}]}]
        packet,_=build(data,DESIGN)
        raw=''.join(c['text'] for c in text_cells(packet['nativeLayout']['blueprint']['modules']))
        links=[a for a in BeautifulSoup(raw,'html.parser').find_all('a') if a.get_text()=='完整原标题 & 标点。']
        assert len(links)==2
        assert all(a['href']==url for a in links)
        assert all('text-decoration: none' in a.get('style','') for a in links)


def test_missing_collected_url_keeps_title_and_reports_missing():
    data=base();data.pop('links_enabled')
    data['review']=[{'name':'活动信息','items':[{'title':'资讯标题',
        'link':{'label':'缺少地址的原标题','url':''}}]}]
    packet,warnings=build(data,DESIGN)
    raw=''.join(c['text'] for c in text_cells(packet['nativeLayout']['blueprint']['modules']))
    soup=BeautifulSoup(raw,'html.parser')
    assert '详情请见：缺少地址的原标题' in soup.get_text()
    assert not any(a.get_text()=='缺少地址的原标题' for a in soup.find_all('a'))
    assert any('原文链接缺失' in w for w in warnings)


def test_invalid_collected_url_is_rejected_by_default():
    for url in ('javascript:alert(1)', '/s/example'):
        data=base();data.pop('links_enabled')
        data['review']=[{'name':'活动信息','items':[{'title':'资讯标题',
            'link':{'label':'原标题','url':url}}]}]
        try:
            build(data,DESIGN)
        except ValueError as e:
            assert 'http(s)' in str(e)
        else:
            raise AssertionError('Invalid link was accepted')


def test_long_body_remains_unindented_by_default():
    data=base(); data['upcoming']=[{'name':'活动信息','items':[{'title':'长文测试',
        'body':'一段用于验证信息面板正常排版的中文叙述。'*15}]}]
    p,_=build(data,DESIGN)
    cells=list(text_cells(p['nativeLayout']['blueprint']['modules']))
    target=next(c for c in cells if '一段用于验证信息面板' in c['text'])
    assert 'text-indent:' not in target['text']


def test_explicit_indent_is_scoped_to_one_news_item():
    data=base(); data['upcoming']=[{'name':'活动信息','items':[
      {'title':'特殊叙事','body':'只有这一段需要显式缩进',
       'typography':{'first_line_indent':'2em'}},
      {'title':'普通资讯','body':'另一条较长的正文不需要任何首行缩进'*12}
    ]}]
    p,_=build(data,DESIGN)
    cells=list(text_cells(p['nativeLayout']['blueprint']['modules']))
    special=next(c for c in cells if '只有这一段需要显式缩进' in c['text'])
    ordinary=next(c for c in cells if '另一条较长的正文' in c['text'])
    assert 'text-indent: 2em;' in special['text']
    assert 'text-indent:' not in ordinary['text']


def test_legacy_auto_indent_is_not_a_character_threshold():
    data=base();data['upcoming']=[{'name':'学术信息','items':[{'title':'普通长正文',
      'body':'长段自然不等于要求缩进'*30,'typography':{'first_line_indent':'auto'}}]}]
    p,_=build(data,DESIGN)
    cell=next(c for c in text_cells(p['nativeLayout']['blueprint']['modules'])
              if '长段自然不等于要求缩进' in c['text'])
    assert 'text-indent:' not in cell['text']

def test_western_break_is_opt_in_not_forced_by_length():
    long_token='https://example.net/'+'some-long-identifier-'*5
    data=base();data['upcoming']=[{'name':'活动信息','items':[{'title':'普通资讯','body':long_token}]}]
    p,_=build(data,DESIGN)
    c=next(c for c in text_cells(p['nativeLayout']['blueprint']['modules']) if long_token in c['text'])
    assert c.get('constraint',{}).get('wordBreakMode')!='breakAll'
    assert 'word-break: break-all;' not in c['text']
    data['upcoming'][0]['items'][0]['typography']={'western_break':True}
    p,_=build(data,DESIGN)
    c=next(c for c in text_cells(p['nativeLayout']['blueprint']['modules']) if long_token in c['text'])
    assert c.get('constraint',{}).get('wordBreakMode')=='breakAll'
    assert 'word-break: break-all;' in c['text']

def test_native_break_override_off():
    data=base();data['upcoming']=[{'name':'活动信息','items':[{'title':'活动',
        'body':'longIdentifier'*10,'typography':{'western_break':False}}]}]
    p,_=build(data,DESIGN)
    cells=list(text_cells(p['nativeLayout']['blueprint']['modules']))
    assert not any(c.get('constraint',{}).get('wordBreakMode')=='breakAll' for c in cells)

def test_editorial_hints():
    data=base();data['review']=[{'name':'活动信息','items':[{'title':'活动A',
        'fields':[{'label':'报名人数','value':'500人'}],'body':'今年共有500人报名。'}]}]
    data['upcoming']=[{'name':'活动信息','items':[{'title':'活动A','body':'这是一条重复报道'}]}]
    result=' '.join(audit(data))
    assert '报名' in result and '重复' in result and '句号' in result

def test_no_legacy_contract():
    p,_=build(base(),DESIGN)
    assert p['schema']=='xiumi-bridge/v4' and p['mode']=='native-layout'
    assert ':::news' not in json.dumps(p,ensure_ascii=False)

if __name__=='__main__':
    tests=[v for k,v in list(globals().items()) if k.startswith('test_') and callable(v)]
    for test in tests:
        test();print('PASS',test.__name__)
    print('ALL',len(tests),'passed')
