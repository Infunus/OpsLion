"""Tests use a trimmed, user-captured paper-cp:layout/classic-table-normal model."""
import json,sys,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from native_packet import build,validate,PacketError,plaintext
from import_native_table import import_table

SAMPLE=Path(__file__).resolve().parents[1]/'examples'/'native-table.reference.xiumi.json'

def fixture():return json.loads(SAMPLE.read_text('utf8'))

def plan(rows,**kwargs):
    return {'schema':'opslion-native-workplan/v1','sequence':[{'id':'test-table','source':0,'nativeTables':[
        {'path':['col1','items',0],'rows':rows,**kwargs}]}]}

class CapturedNativeTableTests(unittest.TestCase):
 def test_table_from_real_reference_with_more_rows(self):
    f=fixture()
    rows=[[f"{i:02d}'",'林子川进球' if i%2 else '城环扳平'] for i in range(12)]
    p=build(f,plan(rows,columnWidths=[24,76])); self.assertTrue(validate(p)['ok'])
    native=p['nativeLayout']['blueprint']['modules'][1]['col1']['items'][0]
    self.assertEqual(native['_comp']['tplId'],'paper-cp:layout/classic-table-normal')
    self.assertEqual(len(native['classicTable1']['items']),12)
    self.assertEqual(native['classicTable1']['thead'][0]['style']['width'],'24.00%')
    self.assertEqual(native['classicTable1']['thead'][1]['style']['width'],'76.00%')
    self.assertIn('林子川进球',native['classicTable1']['items'][1]['tds'][1]['items'][0]['txt1']['text'])
    self.assertEqual(f['nativeLayout']['blueprint']['modules'][0]['col1']['items'][0]['classicTable1']['items'][0]['tds'][0]['items'][0]['txt1']['text'],'<p>场次1</p>')
    self.assertTrue(any('items",11' in s['id'] for s in p['nativeLayout']['blueprint']['slots']))

 def test_bold_within_table_text_and_multi_paragraph(self):
    p=build(fixture(),plan([[{'runs':[{'text':'12′ ','bold':True},{'text':'进球'}]},
                              {'paragraphs':['林子川完成进球',{'runs':[{'text':'祝福','bold':True},{'text':'队友'}]}]}]]))
    c=p['nativeLayout']['blueprint']['modules'][-1]['col1']['items'][0]['classicTable1']['items'][0]['tds']
    self.assertIn('<strong>12′ </strong>',c[0]['items'][0]['txt1']['text'])
    self.assertIn('<strong>祝福</strong>队友',c[1]['items'][0]['txt1']['text'])
    self.assertEqual(plaintext(c[1]['items'][0]['txt1']['text']),'林子川完成进球祝福队友')
    self.assertTrue(validate(p)['ok'])

 def test_column_merge_from_captured_cell(self):
    p=build(fixture(),plan([[{'text':'半场 2:1','colSpan':2}],['50′','林子川进球']]))
    r=p['nativeLayout']['blueprint']['modules'][-1]['col1']['items'][0]['classicTable1']['items']
    self.assertEqual(len(r[0]['tds']),1);self.assertEqual(r[0]['tds'][0]['colSpan'],2)
    self.assertEqual(len(r[1]['tds']),2)
    self.assertTrue(validate(p)['ok'])

 def test_stripes_and_rows_are_unique_objects(self):
    p=build(fixture(),plan([['一','第一'],['二','第二'],['三','第三']]))
    rows=p['nativeLayout']['blueprint']['modules'][1]['col1']['items'][0]['classicTable1']['items']
    self.assertNotEqual(rows[0]['_comp']['_$uuid'],rows[2]['_comp']['_$uuid'])
    self.assertNotEqual(rows[0]['tds'][0]['items'][0]['_comp']['_$uuid'],rows[2]['tds'][0]['items'][0]['_comp']['_$uuid'])
    self.assertEqual(rows[0]['tds'][0]['style']['backgroundColor'],rows[2]['tds'][0]['style']['backgroundColor'])
    self.assertNotEqual(rows[0]['tds'][0]['style']['backgroundColor'],rows[1]['tds'][0]['style']['backgroundColor'])

 def test_refuse_invalid_table_values_or_wrong_path(self):
    cases=[([['仅一列']*3],{}),([['正常','两个']],{'columnWidths':[40,40]}),([['正常','两个']],{'columnWidths':[20,20,60]}),
           ([[{'text':'危险','colSpan':3}]],{}),([['a',{'paragraphs':[]}]],{}),([['a',{'runs':[{'text':'x','bold':'yes'}]}]],{}),
           ([['a','b']],{'path':['col1','items',0,'txt1']})]
    for rows,kwargs in cases:
        path=kwargs.pop('path',['col1','items',0]);pl={'schema':'opslion-native-workplan/v1','sequence':[{'id':'t','source':0,'nativeTables':[{'path':path,'rows':rows,**kwargs}]}]}
        with self.subTest(rows=rows,kwargs=kwargs),self.assertRaises(PacketError):build(fixture(),pl)

 def test_no_old_edits_in_rebuilt_table(self):
    f=fixture(); sid=f['nativeLayout']['blueprint']['slots'][0]['id']
    pl=plan([['12′','林子川']]);pl['sequence'][0]['edits']={sid:'旧格错位'}
    with self.assertRaises(PacketError):build(f,pl)

 def test_import_table_from_separate_json(self):
    tgt=fixture();ref=fixture();newidx=import_table(tgt,ref,0)
    self.assertEqual(newidx,1);self.assertEqual(len(tgt['nativeLayout']['blueprint']['modules']),2)
    self.assertEqual(len(tgt['nativeLayout']['sequence']),1)
    self.assertTrue(validate(tgt)['ok'])
    pl={'schema':'opslion-native-workplan/v1','sequence':[{'id':'table','source':1,'nativeTables':[
          {'path':['col1','items',0],'rows':[['12′','林子川进球']]}]}]}
    built=build(tgt,pl)
    self.assertTrue(validate(built)['ok'])

if __name__=='__main__':unittest.main()
