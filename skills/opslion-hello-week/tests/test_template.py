import json, pathlib, sys, re, copy
from bs4 import BeautifulSoup
P=pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0,str(P/'scripts'))
from build import build
DESIGN=json.loads((P/'hello-week.template.json').read_text(encoding='utf8'))
EXAMPLE=json.loads((P/'starter.json').read_text(encoding='utf8'))


def output(x):return build(x,DESIGN)[0]

def test_original_native():
    x=output(EXAMPLE)
    assert x['schema']=='xiumi-bridge/v4'
    assert x['nativeLayout']['schema']=='opslion-native-layout-plan/v1'
    b=x['nativeLayout']['blueprint']
    assert b['schema']=='opslion-native-blueprint/v1'
    assert b['source']['paperId']=='123456'
    assert len(b['modules'])==18
    assert b['pageStyle']['lineHeight']=='2'
    assert len(x['nativeLayout']['sequence'])==len(b['modules'])


def test_reuse_items_and_categories():
    x=copy.deepcopy(EXAMPLE)
    x['review']=[{'name': '学术信息', 'items': [{'title':'活动A','body':'描述A'},{'title':'活动B','fields':[{'label':'时间','value':'明天'}]}]},
                 {'name':'通知','items':[{'title':'活动C','body':'描述C'}]}]
    x['upcoming']=[]
    z=output(x);mods=z['nativeLayout']['blueprint']['modules']
    panel=next(m for m in mods if m.get('col1',{}).get('items') and len(m['col1']['items'])==8)
    full=json.dumps(panel,ensure_ascii=False)
    assert all(q in full for q in ['活动A','活动B','活动C','描述C'])
    assert '2026年5月10日' not in json.dumps(mods,ensure_ascii=False)
    assert '2026年4月25日' not in json.dumps(mods,ensure_ascii=False)


def test_long_title_is_shrinkable():
    x=copy.deepcopy(EXAMPLE)
    title='非常长的活动标题：'+'单字' * 60
    x['review'][0]['items'][0]['title']=title
    packet,warnings=build(x,DESIGN)
    assert any('长标题' in w for w in warnings)
    s=json.dumps(packet,ensure_ascii=False)
    assert title in s
    for m in packet['nativeLayout']['blueprint']['modules']:
        if '【' not in json.dumps(m,ensure_ascii=False) and title not in json.dumps(m,ensure_ascii=False):continue
        if 'col1' in m and len(m['col1'].get('items',[]))==3 and title in json.dumps(m,ensure_ascii=False):
            obj=m['col1']['items'][1]['col1']['style']
            assert obj['flex']=='0 1 auto' and obj['minWidth']=='0'


def test_sparse_structure():
    x=copy.deepcopy(EXAMPLE)
    x['review']=[];x['upcoming']=[];x['notices']=[]
    z=output(x);s=json.dumps(z,ensure_ascii=False)
    assert '上周回顾' not in s and '下周及后续' not in s and '中期退课进行中' not in s
    assert len(find_shows(z['nativeLayout']['blueprint']['modules']))==1


def find_shows(modules):
    return [(i,m) for i,m in enumerate(modules) if '下周百讲演出速览' in
            json.dumps(m,ensure_ascii=False)]


def test_mandatory_blank_baijiang():
    # The manual performance box is always included exactly once, even in a sparse week.
    for name in ('starter.json','examples/01-regular.json','examples/05-brief.json'):
        x=json.loads((P/name).read_text(encoding='utf8'))
        x['review']=[];x['upcoming']=[];x['notices']=[]
        # A legacy input must not leak poster/link content into the user-only section.
        x['performances']=[{'image':'https://assets.example.org/poster.png',
                            'label':'展演详情','url':'https://example.org/show'}]
        z=output(x); b=z['nativeLayout']['blueprint'];mods=b['modules']
        found=find_shows(mods)
        assert len(found)==1
        i,m=found[0]
        assert len(m['col1']['items'])==2
        text=m['col1']['items'][1]
        assert text['txt1']['text']=='<p><br></p>'
        assert text['txt1']['type']=='text'
        assert 'link' not in text['_comp']
        assert 'link' not in text['txt1']
        assert 'img1' not in text
        assert not z['nativeLayout']['sequence'][i]['edits']
        assert 'https://assets.example.org/poster.png' not in json.dumps(z,ensure_ascii=False)
        assert '展演详情' not in json.dumps(z,ensure_ascii=False)
        # Even without review/upcoming/notices, it remains before the contact section.
        assert i < next(j for j,mm in enumerate(mods) if '【联系我们】' in json.dumps(mm,ensure_ascii=False))


def test_baijiang_before_notices_and_contact():
    x=copy.deepcopy(EXAMPLE)
    x['notices']=[{'title':'提醒一','body':'注意事项一'}, {'title':'提醒二','fields':[{'label':'时间','value':'周一'}]}]
    z=output(x);mods=z['nativeLayout']['blueprint']['modules']
    pos=find_shows(mods)[0][0]
    notice_pos=next(i for i,m in enumerate(mods) if '【本期提示标题】' not in json.dumps(m,ensure_ascii=False)
                    and '提醒一' in json.dumps(m,ensure_ascii=False))
    contact_pos=next(i for i,m in enumerate(mods) if '【联系我们】' in json.dumps(m,ensure_ascii=False))
    assert pos<notice_pos<contact_pos
    assert '提醒二' in json.dumps(mods,ensure_ascii=False)


def test_unique_uuids_and_slots():
    x=copy.deepcopy(EXAMPLE)
    x['review'][0]['items'] *= 10
    z=output(x);b=z['nativeLayout']['blueprint']
    ids=[]
    def find(o):
        if isinstance(o,dict):
            for k,v in o.items():
                if k=='_$uuid':ids.append(v)
                find(v)
        elif isinstance(o,list):
            for v in o:find(v)
    find(b['modules']); assert len(ids)==len(set(ids))
    slots=b['slots']; assert len(slots)==len({s['id'] for s in slots})
    for s in slots:
        node=b['modules'][s['module']]
        for k in s['path'][1:]: node=node[k]
        if s['kind']=='text':
            assert node['type']=='text'
        else:
            assert node[s['field']]==s['original']


def test_no_private_original_phone():
    s=(P/'hello-week.template.json').read_text(encoding='utf8')
    assert not re.search(r'(?<!\d)1[3-9]\d{9}(?!\d)', s)


def test_source_is_native():
    s=DESIGN['seeds']
    for key in ['banner','code_intro','submission','section','news_panel','shows_panel','notice_panel','contact','credits','footer']:
        assert isinstance(s[key].get('_comp',{}).get('tplId'),str)

def test_dynamic_prose_ends_without_full_stop():
    content=copy.deepcopy(EXAMPLE)
    content['review']=[{'name':'活动信息','items':[{'title':'某次活动',
        'fields':[{'label':'内容','value':'第一句。第二句。'},
                  {'label':'地点','value':'理科楼。'}],
        'body':['本次活动已结束。','参与者交流了心得。'] }]}]
    content['upcoming']=[{'name':'通知','items':[{'title':'下周讲座',
        'fields':[{'label':'参加条件','value':'信科本科生可以报名。'}],
        'body':'第一句话。第二句话。'}]}]
    packet,warnings=build(content,DESIGN)
    from bs4 import BeautifulSoup
    para=[]
    def walk(obj):
        if isinstance(obj,dict):
            if obj.get('type')=='text' and isinstance(obj.get('text'),str):
                for p0 in BeautifulSoup(obj['text'],'html.parser').find_all('p'):
                    para.append(p0.get_text().strip())
            for v in obj.values():walk(v)
        elif isinstance(obj,list):
            for v in obj:walk(v)
    walk(packet['nativeLayout']['blueprint']['modules'])
    for value in ('✔ 内容：第一句。第二句','✔ 地点：理科楼',
                  '本次活动已结束','参与者交流了心得',
                  '✔ 参加条件：信科本科生可以报名','第一句话。第二句话'):
        assert value in para, (value,para)
    assert not any('内容：第一句。第二句。' in p for p in para)


def test_past_signup_stats_omitted_or_flagged():
    content=copy.deepcopy(EXAMPLE)
    content['review']=[{'name':'活动信息','items':[{
        'title':'过去的一场活动',
        'fields':[{'label':'报名人数','value':'300人'},
                  {'label':'成果','value':'完成了一场讨论。'}],
        'body':'已有300人报名。还有其他细节需要编辑核对。'
    }]}]
    packet,warnings=build(content,DESIGN)
    tree=json.dumps(packet['nativeLayout']['blueprint']['modules'],ensure_ascii=False)
    assert '报名人数：300人' not in tree
    assert '成果：完成了一场讨论' in tree
    assert any('报名统计字段' in w for w in warnings)
    assert any('报名统计' in w and '正文' in w for w in warnings)


def test_nopunctuation_does_not_touch_official_title_or_link():
    content=copy.deepcopy(EXAMPLE)
    content['upcoming']=[{'name':'学术信息','items':[{
        'title':'官方题目。',
        'fields':[{'label':'时间','value':'12:00。'}],
        'link':{'label':'公众号原文标题。','url':'https://example.org/intro.a'}
    }]}]
    packet,warnings=build(content,DESIGN)
    data=json.dumps(packet,ensure_ascii=False)
    assert '官方题目。' in data
    assert '公众号原文标题。' in data
    assert '时间：12:00。' not in data
    assert 'https://example.org/intro.a' in data  # collected links enabled by default


if __name__=='__main__':
    funcs=[v for k,v in globals().copy().items() if k.startswith('test_') and callable(v)]
    for f in funcs:
        f();print('PASS',f.__name__)
    print('ALL',len(funcs),'passed')
