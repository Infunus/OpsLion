import base64
import copy
import json
import sys
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from native_packet import (validate,build,audit,PacketError,slot_name,material_summary,plaintext,draft_plan)

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i4SoAAAAASUVORK5CYII=')
IMG='data:image/png;base64,'+base64.b64encode(PNG).decode()

def fixture():
    group={'_comp':{'tplId':'paper-cp:layout/row1-r1c2','_$uuid':'comp-x','style':{'display':'flex'}},
           'col1':{'type':'group','style':{'width':'auto','flex':'0 0 auto','height':'40px'},
                   'constraint':{'childLayout':'static'},'items':[{'_comp':{'tplId':'paper-cp:header/1-txt-normal','_$uuid':'comp-y'},
                     'txt1':{'type':'text','text':'<p><strong>栏目</strong></p>','style':{}}} ]}}
    photo={'_comp':{'tplId':'paper-cp:image/img-autowidth'},
           'img1':{'type':'image','src':'https://img.example.org/old.png','style':{'width':'100%'}}}
    modules=[group,photo]
    slots=[{'id':'t:[0,"col1","items",0,"txt1"]:0','kind':'text','module':0,
            'path':[0,'col1','items',0,'txt1'],'run':0,'original':'栏目'},
           {'id':'i:[1,"img1","src"]','kind':'image','module':1,'path':[1,'img1'],'field':'src','original':'https://img.example.org/old.png'}]
    return {'schema':'xiumi-bridge/v4','mode':'native-layout','title':'模板',
            'nativeLayout':{'schema':'opslion-native-layout-plan/v1',
              'blueprint':{'schema':'opslion-native-blueprint/v1','source':{'paperId':'123456','url':'https://xiumi.us/...'},
                           'modules':modules,'pageStyle':{'fontSize':'14px'},'slots':slots},
              'sequence':[{'id':'header','source':0,'edits':{}},{'id':'photo','source':1,'edits':{}}]}}

class Tests(unittest.TestCase):
    def test_roundtrip_and_shape(self):
        p=fixture();assert validate(p)['ok']
        clone=build(p,draft_plan(p));self.assertEqual(clone,p)
    def test_style_patch_single_instance(self):
        p=fixture();t=p['nativeLayout']['blueprint']['slots'][0]['id']
        plan={'schema':'opslion-native-workplan/v1','title':'合成测试稿','sequence':[
          {'id':'one','source':0,'edits':{t:'栏目标题与补充说明'},
            'stylePatches':[{'path':['col1','style','flex'],'expected':'0 0 auto','value':'0 1 auto'},
              {'path':['col1','style','height'],'expected':'40px','value':'auto'}]},
          {'id':'two','source':0,'edits':{t:'另一栏目'}}]}
        q=build(p,plan);b=q['nativeLayout']['blueprint'];s=q['nativeLayout']['sequence']
        self.assertEqual(len(b['modules']),3)
        self.assertEqual(s[0]['source'],2)
        self.assertEqual(s[1]['source'],0)
        self.assertEqual(b['modules'][0]['col1']['style']['height'],'40px')
        self.assertEqual(b['modules'][2]['col1']['style']['height'],'auto')
        self.assertIn('t:[2,"col1","items",0,"txt1"]:0',s[0]['edits'])
        self.assertEqual(s[1]['edits'][t],'另一栏目')
        self.assertTrue(validate(q)['ok'])
    def test_prepare_creates_empty_composition_plan(self):
        import tempfile
        from native_packet import save,load,cmd_prepare
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as td:
            source=Path(td)/'source.xiumi.json';save(source,fixture())
            dest=Path(td)/'work'
            cmd_prepare(SimpleNamespace(template=str(source),materials=None,out=str(dest)))
            self.assertEqual(load(dest/'composition.plan.json')['sequence'],[])
            self.assertEqual(len(load(dest/'layout.plan.json')['sequence']),2)

    def test_native_paragraph_indent_only_one_instance(self):
        p=fixture();t=p['nativeLayout']['blueprint']['slots'][0]['id']
        plan={'schema':'opslion-native-workplan/v1','sequence':[
          {'id':'narrative','source':0,'edits':{t:'第一段叙述。'},
           'textFormatting':[{'path':['col1','items',0,'txt1'],'firstLineIndent':'2em'}]},
          {'id':'heading','source':0,'edits':{t:'标题'}}]}
        q=build(p,plan)
        first=q['nativeLayout']['sequence'][0]['source']
        cell=q['nativeLayout']['blueprint']['modules'][first]['col1']['items'][0]['txt1']
        self.assertIn('text-indent: 2em;',cell['text'])
        self.assertNotIn('textIndent',cell['style'])
        self.assertNotIn('text-indent',p['nativeLayout']['blueprint']['modules'][0]['col1']['items'][0]['txt1']['text'])
        self.assertEqual(q['nativeLayout']['sequence'][0]['edits'][f't:[{first},"col1","items",0,"txt1"]:0'],'第一段叙述。')
        self.assertTrue(validate(q)['ok'])

    def test_western_break_native_fields_and_preserve_styles(self):
        p=fixture(); cell=p['nativeLayout']['blueprint']['modules'][0]['col1']['items'][0]['txt1']
        cell['text']='<p class="body" style="color: red;"><strong>栏目</strong></p><p style="text-align: left;">English example</p>'
        source=p['nativeLayout']['blueprint']['slots'][0]['id']
        plan={'schema':'opslion-native-workplan/v1','sequence':[
         {'id':'western','source':0,'edits':{source:'LongEnglishIdentifierThatNeedsBreaking'},
          'textFormatting':[{'path':['col1','items',0,'txt1'],'firstLineIndent':'2em','westernBreak':True}]},
         {'id':'normal','source':0,'edits':{}}]}
        q=build(p,plan);b=q['nativeLayout']['blueprint'];s=q['nativeLayout']['sequence']
        newcell=b['modules'][s[0]['source']]['col1']['items'][0]['txt1']
        self.assertEqual(newcell['constraint']['wordBreakMode'],'breakAll')
        self.assertEqual(newcell['text'].count('text-indent: 2em;'),2)
        self.assertEqual(newcell['text'].count('word-break: break-all;'),2)
        self.assertIn('color: red;',newcell['text'])
        self.assertIn('text-align: left;',newcell['text'])
        self.assertEqual(b['modules'][s[1]['source']]['col1']['items'][0]['txt1']['text'],cell['text'])
        self.assertTrue(validate(q)['ok'])

    def test_idempotent_paragraph_style_and_no_duplicate_css(self):
        p=fixture();cell=p['nativeLayout']['blueprint']['modules'][0]['col1']['items'][0]['txt1']
        cell['text']='<p style="text-indent: 2em; word-break: break-all;">栏目</p>'
        plan={'schema':'opslion-native-workplan/v1','sequence':[
          {'id':'x','source':0,'textFormatting':[{'path':['col1','items',0,'txt1'],
                                                 'firstLineIndent':'2em','westernBreak':True}]}]}
        q=build(p,plan); out=q['nativeLayout']['blueprint']['modules'][-1]['col1']['items'][0]['txt1']['text']
        self.assertEqual(out.count('text-indent:'),1)
        self.assertEqual(out.count('word-break:'),1)
        self.assertTrue(validate(q)['ok'])

    def test_refuse_unknown_text_formatting_or_nonparagraph(self):
        p=fixture()
        cases=[{'path':['col1'], 'westernBreak':True},
               {'path':['col1','items',0,'txt1'], 'firstLineIndent':'2em; color:red'},
               {'path':['col1','items',0,'txt1'], 'westernBreak':False},
               {'path':['col1','items',0,'txt1'], 'nonNative':True}]
        for item in cases:
            plan={'schema':'opslion-native-workplan/v1','sequence':[{'id':'x','source':0,'textFormatting':[item]}]}
            with self.subTest(item=item),self.assertRaises(PacketError):build(p,plan)
        p2=fixture();p2['nativeLayout']['blueprint']['modules'][0]['col1']['items'][0]['txt1']['text']='<span>栏目</span>'
        plan={'schema':'opslion-native-workplan/v1','sequence':[{'id':'x','source':0,
            'textFormatting':[{'path':['col1','items',0,'txt1'],'firstLineIndent':'2em'}]}]}
        with self.assertRaises(PacketError):build(p2,plan)

    def test_refuse_legacy_text_indent_style_patch(self):
        p=fixture()
        plan={'schema':'opslion-native-workplan/v1','sequence':[{'id':'x','source':0,
          'stylePatches':[{'path':['col1','items',0,'txt1','style','textIndent'],
                           'expected':None,'value':'2em'}]}]}
        with self.assertRaises(PacketError):build(p,plan)

    def test_audit_long_unbroken_western_text(self):
        p=fixture();t=p['nativeLayout']['blueprint']['slots'][0]['id']
        p['nativeLayout']['sequence'][0]['edits'][t]='https://some.example.org/'+('a'*64)
        self.assertIn('long-western-run',[x['kind'] for x in audit(p)['risks']])
        plan={'schema':'opslion-native-workplan/v1','sequence':[{'id':'u','source':0,
            'edits':{t:'https://some.example.org/'+('a'*64)},
            'textFormatting':[{'path':['col1','items',0,'txt1'],'westernBreak':True}]}]}
        q=build(p,plan)
        self.assertNotIn('long-western-run',[x['kind'] for x in audit(q)['risks']])

    def test_audit_flags_content_growth_under_constraints(self):
        p=fixture();t=p['nativeLayout']['blueprint']['slots'][0]['id']
        p['nativeLayout']['sequence'][0]['edits'][t]='栏目标题与补充说明'
        reasons=[r['kind'] for r in audit(p)['risks']]
        self.assertIn('constrained-text',reasons)
        self.assertIn('grow-in-flex',reasons)
    def test_embedded_asset(self):
        p=fixture();s=p['nativeLayout']['blueprint']['slots'][1]['id']
        plan={'schema':'opslion-native-workplan/v1','sequence':[{'id':'p','source':1,'edits':{s:{'asset':'A0001'}}}]}
        materials={'assets':[{'id':'A0001','src':IMG}]}
        q=build(p,plan,materials);self.assertEqual(q['nativeLayout']['sequence'][0]['edits'][s],IMG)
        self.assertTrue(validate(q,full_images=True)['ok'])
    def test_wrong_patch_expected(self):
        p=fixture()
        plan={'schema':'opslion-native-workplan/v1','sequence':[{'id':'p','source':0,'stylePatches':[
           {'path':['col1','style','flex'],'expected':'1 1 auto','value':'0 1 auto'}]}]}
        with self.assertRaises(PacketError):build(p,plan)
    def test_no_base64_bloat_in_catalog(self):
        p=fixture();p['nativeLayout']['blueprint']['modules'][1]['img1']['src']=IMG
        p['nativeLayout']['blueprint']['slots'][1]['original']=IMG
        from native_packet import catalog
        x=json.dumps(catalog(p))
        self.assertNotIn(base64.b64encode(PNG).decode(),x)
    def test_reject_wrong_slot_module(self):
        p=fixture();sid=p['nativeLayout']['blueprint']['slots'][0]['id']
        p['nativeLayout']['sequence'][1]['edits'][sid]='wrong module'
        with self.assertRaises(PacketError):validate(p)
    def test_output_same_format_as_input(self):
        p=fixture();q=build(p,draft_plan(p))
        self.assertEqual(q['schema'],p['schema'])
        self.assertEqual(q['nativeLayout']['schema'],p['nativeLayout']['schema'])
    def test_text_conversion(self):
        self.assertEqual(plaintext('<p>一<br>二 &amp; 三</p>'),'一\n二 & 三')
    def test_empty_or_non_native_rejected(self):
        with self.assertRaises(PacketError):validate({'schema':'xiumi-bridge/v3','html':'hello'})

if __name__=='__main__':unittest.main()

class BoldRenderingTests(unittest.TestCase):
    def test_word_bold_spans_as_native_strong_runs(self):
        p=fixture();path=['col1','items',0,'txt1']
        plan={'schema':'opslion-native-workplan/v1','sequence':[
            {'id':'summary','source':0,'richText':[{'path':path,'runs':[
                {'text':'进球球员：'}, {'text':'林子川','bold':True}, {'text':'完成帽子戏法'}]}]}]}
        q=build(p,plan)
        new_source=q['nativeLayout']['sequence'][0]['source']
        cell=q['nativeLayout']['blueprint']['modules'][new_source]['col1']['items'][0]['txt1']
        self.assertIn('<strong>林子川</strong>',cell['text'])
        self.assertEqual(plaintext(cell['text']),'进球球员：林子川完成帽子戏法')
        self.assertEqual(q['nativeLayout']['sequence'][0]['edits'],{})
        self.assertNotIn('林子川',p['nativeLayout']['blueprint']['modules'][0]['col1']['items'][0]['txt1']['text'])
        self.assertTrue(validate(q)['ok'])

    def test_same_title_type_consistent_bold_across_repeated_modules(self):
        p=fixture();path=['col1','items',0,'txt1']
        plan={'schema':'opslion-native-workplan/v1','sequence':[
            {'id':str(i),'source':0,'richText':[{'path':path,'runs':[{'text':title,'bold':True}]}]}
            for i,title in enumerate(['战报速览','首发十一人','赛事回顾'])]}
        q=build(p,plan);b=q['nativeLayout']['blueprint']
        for x in q['nativeLayout']['sequence']:
            self.assertIn('<strong>',b['modules'][x['source']]['col1']['items'][0]['txt1']['text'])
        self.assertTrue(validate(q)['ok'])

    def test_rich_text_escapes_input_and_preserves_paragraph_wrapper(self):
        p=fixture();path=['col1','items',0,'txt1']
        p['nativeLayout']['blueprint']['modules'][0]['col1']['items'][0]['txt1']['text']='<p style="color:blue"><strong>栏目</strong></p>'
        plan={'schema':'opslion-native-workplan/v1','sequence':[{'id':'escape','source':0,'richText':[
            {'path':path,'runs':[{'text':'林子川 <2026>','bold':True},{'text':' & 球队'}]}]}]}
        q=build(p,plan)
        cell=q['nativeLayout']['blueprint']['modules'][-1]['col1']['items'][0]['txt1']
        self.assertEqual(cell['text'],'<p style="color:blue"><strong>林子川 &lt;2026&gt;</strong> &amp; 球队</p>')
        self.assertTrue(validate(q)['ok'])

    def test_rich_text_conflicts_with_plain_edits(self):
        p=fixture();slot=p['nativeLayout']['blueprint']['slots'][0]['id']
        plan={'schema':'opslion-native-workplan/v1','sequence':[{'id':'bad','source':0,
            'edits':{slot:'整个文字'},'richText':[{'path':['col1','items',0,'txt1'],
            'runs':[{'text':'强调','bold':True}]}]}]}
        with self.assertRaises(PacketError):build(p,plan)

    def test_rich_text_invalid_runs_rejected(self):
        p=fixture();path=['col1','items',0,'txt1']
        cases=[[{'text':'x','bold':'yes'}],[{'text':'x','color':'red'}],[],[{'text':''}]]
        for runs in cases:
            with self.subTest(runs=runs),self.assertRaises(PacketError):
                build(p,{'schema':'opslion-native-workplan/v1','sequence':[
                    {'id':'test','source':0,'richText':[{'path':path,'runs':runs}]}]})
