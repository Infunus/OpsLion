"""Regression: source-bold runs and consistent native title emphasis."""
import json,sys,tempfile,unittest
from pathlib import Path
from docx import Document

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from native_packet import build
from audit_emphasis import source_emphasis,output_emphasis,normalize
from test_native_packet import fixture


class EmphasisAuditTests(unittest.TestCase):
 def test_word_source_bold_and_native_bold_are_matched(self):
  with tempfile.TemporaryDirectory() as td:
   src=Path(td)/'article.docx';doc=Document();p=doc.add_paragraph()
   p.add_run('最终比分：');r=p.add_run('4:3');r.bold=True
   p.add_run('，帽子戏法。');doc.save(src)
   self.assertEqual(source_emphasis(src),['4:3'])
   packet=fixture(); q=build(packet,{'schema':'opslion-native-workplan/v1','sequence':[
    {'id':'summary','source':0,'richText':[{'path':['col1','items',0,'txt1'],
      'runs':[{'text':'最终比分：'},{'text':'4:3','bold':True},{'text':'，帽子戏法。'}]}]}]})
   bold,all_text=output_emphasis(q)
   self.assertIn('4:3',bold)
   self.assertTrue(any('最终比分' in t for t in all_text))

 def test_detect_bold_missing_in_plain_replacement(self):
  p=fixture();slot=p['nativeLayout']['blueprint']['slots'][0]['id']
  # The template title is <strong>, but an ordinary nonbold template fragment can lose it.
  p['nativeLayout']['blueprint']['modules'][0]['col1']['items'][0]['txt1']['text']='<p>栏目</p>'
  q=build(p,{'schema':'opslion-native-workplan/v1','sequence':[
    {'id':'plain','source':0,'edits':{slot:'林子川'}}]})
  bold,alltext=output_emphasis(q)
  self.assertFalse(any(normalize('林子川') in normalize(s) for s in bold))
  self.assertTrue(any('林子川' in t for t in alltext))

if __name__=='__main__':unittest.main()

class InheritedBoldTests(unittest.TestCase):
 def test_paragraph_style_bold_detected(self):
  with tempfile.TemporaryDirectory() as td:
   src=Path(td)/'heading.docx';doc=Document();p=doc.add_paragraph('赛后展望',style='Heading 1');doc.save(src)
   # Standard Heading 1 is bold in built-in Word styles.
   self.assertIn('赛后展望',source_emphasis(src))
