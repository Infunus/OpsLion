"""Regression tests: small changes accepted with documented editorial review."""
import json, tempfile, unittest
from pathlib import Path
import subprocess, sys
from docx import Document

SCRIPT=Path(__file__).resolve().parents[1]/'scripts'/'verify_source_fidelity.py'

class EditorialReviewTests(unittest.TestCase):
 def run_case(self,paras,changes=None):
  with tempfile.TemporaryDirectory() as tmp:
   d=Path(tmp);doc=Document();doc.add_paragraph('林子川高举赵乐际的球衣。')
   t=doc.add_table(rows=1,cols=2);t.cell(0,0).text="31'";t.cell(0,1).text='生日夜，帽子戏法！'
   src=d/'source.docx';doc.save(src)
   module={'_comp':{'tplId':'paper-cp:header/1-txt-normal'},'txt1':{'type':'text','text':''.join('<p>'+p+'</p>' for p in paras)}}
   pkt={'nativeLayout':{'blueprint':{'modules':[module],'slots':[]},'sequence':[{'id':'0','source':0,'edits':{}}]}}
   path=d/'pkt.json';path.write_text(json.dumps(pkt,ensure_ascii=False),'utf-8')
   cmd=[sys.executable,str(SCRIPT),'--source',str(src),'--packet',str(path),'--content-module','0']
   if changes is not None:
    c=d/'changes.json';c.write_text(json.dumps({'changes':changes},ensure_ascii=False),'utf-8');cmd+=['--changes',str(c)]
   res=subprocess.run(cmd,capture_output=True,text=True)
   self.assertTrue(res.stdout,res.stderr)
   return res.returncode,json.loads(res.stdout)
 def sample_change(self,reason='修正明显用词错误',reviewed=True):
  return {'location':'比赛现场段','kind':'wording','before':'林子川高举赵乐际的球衣。','after':'林子川举起赵乐际的球衣。','reason':reason,'reviewed':reviewed}
 def test_unchanged_passes(self):
  rc,r=self.run_case(['林子川高举赵乐际的球衣。',"31'",'生日夜，帽子戏法！'])
  self.assertEqual(rc,0);self.assertTrue(r['ok'])
 def test_visual_line_break_does_not_count_as_word_edit(self):
  rc,r=self.run_case(['林子川高举<br/>赵乐际的球衣。',"31'",'生日夜，帽子戏法！'])
  self.assertEqual(rc,0)
  self.assertTrue(r['ok'])
  self.assertEqual(r['pending_missing_count'],0)
 def test_short_layout_deletion_must_be_logged(self):
  rc,r=self.run_case(['林子川高举赵乐际球衣。',"31'",'生日夜，帽子戏法！'])
  self.assertEqual(rc,1)
  change={'location':'居中短句','kind':'layout','before':'林子川高举赵乐际的球衣。','after':'林子川高举赵乐际球衣。','reason':'居中后仅余一个字在末行，删去不影响句意的“的”以改善对齐','reviewed':True}
  rc,r=self.run_case(['林子川高举赵乐际球衣。',"31'",'生日夜，帽子戏法！'],[change])
  self.assertEqual(rc,0)
  self.assertTrue(r['ok'])
 def test_unlogged_wording_change_needs_review(self):
  rc,r=self.run_case(['林子川举起赵乐际的球衣。',"31'",'生日夜，帽子戏法！'])
  self.assertEqual(rc,1);self.assertEqual(r['pending_missing_count'],1)
 def test_logged_small_change_accepted(self):
  rc,r=self.run_case(['林子川举起赵乐际的球衣。',"31'",'生日夜，帽子戏法！'],[self.sample_change()])
  self.assertEqual(rc,0);self.assertTrue(r['ok']);self.assertEqual(len(r['reviewed_changes']),1)
 def test_logged_but_reasonless_rejected(self):
  rc,r=self.run_case(['林子川举起赵乐际的球衣。',"31'",'生日夜，帽子戏法！'],[self.sample_change(reason='')])
  self.assertEqual(rc,1);self.assertTrue(r['ledger_errors'])
 def test_logged_but_unreviewed_rejected(self):
  rc,r=self.run_case(['林子川举起赵乐际的球衣。',"31'",'生日夜，帽子戏法！'],[self.sample_change(reviewed=False)])
  self.assertEqual(rc,1)
 def test_large_unlogged_omission_rejected(self):
  rc,r=self.run_case(["31'",'生日夜，帽子戏法！'])
  self.assertEqual(rc,1);self.assertGreater(r['pending_missing_count'],0)
 def test_unlisted_added_sentence_rejected(self):
  rc,r=self.run_case(['林子川高举赵乐际的球衣。',"31'",'生日夜，帽子戏法！','赛后全队拥抱庆祝。'])
  self.assertEqual(rc,1);self.assertGreater(r['pending_unexpected_count'],0)
 def test_factual_correction_requires_evidence(self):
  e=self.sample_change();e['kind']='factual_correction'
  rc,r=self.run_case(['林子川举起赵乐际的球衣。',"31'",'生日夜，帽子戏法！'],[e])
  self.assertEqual(rc,1);self.assertTrue(r['ledger_errors'])
 def test_suggestion_is_not_approval(self):
  rc,r=self.run_case(['林子川举起赵乐际的球衣。',"31'",'生日夜，帽子戏法！'])
  self.assertEqual(rc,1);self.assertTrue(r['suggested_unreviewed_pairs'])
  self.assertFalse(r['suggested_unreviewed_pairs'][0]['reviewed'])
 def test_logged_addition_accepted(self):
  change={'location':'段落结尾','kind':'add_sentence','before':'','after':'球队将进入八强。','reason':'补充简短衔接句','reviewed':True}
  rc,r=self.run_case(['林子川高举赵乐际的球衣。',"31'",'生日夜，帽子戏法！','球队将进入八强。'],[change])
  self.assertEqual(rc,0)

if __name__=='__main__':unittest.main()
