import copy, unittest
from tools.pilot.test_oak_script import receipt
from tools.pilot.scripted_interruption import deadline_interruption_valid

class DeadlineEvidenceTests(unittest.TestCase):
 def evidence(self):
  script=receipt('forward');script.update(status='failed',error='action coordinator failed');script['records']=script['records'][:3]
  for i,row in enumerate(script['records']):
   row.update(started_monotonic=10+i*.01,finished_monotonic=10+i*.01+.001)
  script['records'][-1].update(reply=None,finished_monotonic=None)
  injection={'schema_version':1,'kind':'scripted_deadline','timeout_seconds':.5,'started_monotonic':10.,'finished_monotonic':10.501}
  return script,injection
 def test_matching_partial_dig_receipt_is_required(self):
  script,injection=self.evidence()
  self.assertTrue(deadline_interruption_valid(script,injection,copy.deepcopy(injection)))
  for mutate in [lambda s:s.update(status='finished'),lambda s:s['records'].pop(),lambda s:s['records'][-1].update(reply={'status':'completed'}),lambda s:s['records'][0].update(reply=None),lambda s:s['records'][2]['request']['action'].update(kind='move'),lambda s:s['records'][1].update(started_monotonic=9)]:
   bad=copy.deepcopy(script);mutate(bad);self.assertFalse(deadline_interruption_valid(bad,injection,injection))
 def test_missing_forged_or_early_fault_receipts_are_rejected(self):
  script,injection=self.evidence()
  self.assertFalse(deadline_interruption_valid(script,None,injection))
  for key,value in [('timeout_seconds',20),('finished_monotonic',10.1),('finished_monotonic',13.),('started_monotonic',float('nan')),('schema_version',True),('kind','none')]:
   bad={**injection,key:value}
   self.assertFalse(deadline_interruption_valid(script,bad,bad))
   self.assertFalse(deadline_interruption_valid(script,bad,injection))
