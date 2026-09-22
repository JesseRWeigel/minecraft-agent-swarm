import copy,unittest
from tools.pilot.oak_script import scripted_actions,script_receipt_valid

def receipt(mode):
 rows=[]
 for i,action in enumerate(scripted_actions(mode),1):
  reply={'schema_version':1,'sequence':i,'status':'finished' if action['kind']=='finish' else 'completed'}
  if action['kind']=='observe':reply['observation']={'source':'participant_bot'}
  rows.append({'request':{'schema_version':1,'trial_id':'collect-oak-log-v1','action_id':'collect-01','sequence':i,'action':action},'reply':reply,'started_monotonic':float(i),'finished_monotonic':i+.1})
 return {'schema_version':1,'status':'finished','error':None,'records':rows}

class OakScriptTests(unittest.TestCase):
 def test_explicit_actions_and_stationary_control(self):
  self.assertEqual([a['kind'] for a in scripted_actions('forward')],['observe','look','dig','look','move','observe','finish'])
  self.assertEqual([a['kind'] for a in scripted_actions('stationary')],['observe','finish'])
  with self.assertRaises(ValueError):scripted_actions('blocked')
 def test_finished_receipts_require_exact_plan_and_valid_ordered_replies(self):
  for mode in ('forward','stationary'):
   good=receipt(mode);self.assertTrue(script_receipt_valid(good,mode))
   variants=[]
   for key,val in [('status','failed'),('error','deadline'),('schema_version',True)]:
    bad=copy.deepcopy(good);bad[key]=val;variants.append(bad)
   for mutate in [lambda b:b['records'].pop(),lambda b:b['records'][0]['request'].update(sequence=2),lambda b:b['records'][-1]['reply'].update(status='completed'),lambda b:b['records'][0]['reply'].update(extra='forged'),lambda b:b['records'][0]['reply']['observation'].update(source='server_rcon'),lambda b:b['records'][0].update(finished_monotonic=float('nan')),lambda b:b['records'][-1].update(finished_monotonic=1000),lambda b:b['records'][1].update(started_monotonic=0)]:
    bad=copy.deepcopy(good);mutate(bad);variants.append(bad)
   for bad in variants:self.assertFalse(script_receipt_valid(bad,mode),bad)


class ScriptedHostAcceptanceTests(unittest.TestCase):
 def test_missing_or_failed_action_receipt_cannot_be_promoted_by_successful_endpoint(self):
  import json
  from pathlib import Path
  from tools.pilot.oak_qualification import validate_result
  row=json.loads((Path(__file__).parents[2]/'docs/research/oak-negative-results-2026-09-22.json').read_text())['attempts'][2]
  fixture={'schema_version':1,'phase':'fixture','baseline':row['before'],'baselineVerification':{'status':'verified'},'setup':{'status':'configured','fixture':{'sha256':'b8d4a036e735f449674c207c94af99be2dc40680245ceb56c4f7c2a76e91a942'},'parentSetup':{'status':'configured'},'commandReceipts':[{'outcome':'issued'}]*7,'blockChecks':[{'status':'verified'}]*7}}
  value={**row['lifecycle'],'schema_version':1,'status':'qualified','failure_case':'none','control_mode':'forward','trial_id':'collect-oak-log-v1','action_id':'collect-01','independent_observer_process':True,'error':None,'network_policy':'game_only_unix_v1','fixture':fixture,'before':row['before'],'terminal':row['terminal'],'action_started_monotonic':10,'action_finished_monotonic':14,'injection':None,'action_driver':'scripted','action_script':receipt('forward'),'action_output_eof':True}
  self.assertTrue(validate_result(value,'forward',row['host_score'],action_driver='scripted'))
  for mutate in [lambda v:v.pop('action_script'),lambda v:v['action_script'].update(status='failed'),lambda v:v.update(action_output_eof=False),lambda v:v.pop('action_driver'),lambda v:v['action_script']['records'].pop(2)]:
   bad=copy.deepcopy(value);mutate(bad)
   self.assertFalse(validate_result(bad,'forward',row['host_score'],action_driver='scripted'))

 def test_action_receipt_file_must_match_worker_and_be_pinned(self):
  import tempfile,json
  from pathlib import Path
  from tools.pilot.oak_qualification import capture_action_record
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);value={'action_script':receipt('stationary')}
   self.assertFalse(capture_action_record(root,value,'scripted')[0])
   file=root/'action-script.json';file.write_text(json.dumps(value['action_script']));file.chmod(0o600)
   valid,pin=capture_action_record(root,value,'scripted');self.assertTrue(valid);self.assertEqual(len(pin),64)
   other=copy.deepcopy(value);other['action_script']['status']='failed';self.assertFalse(capture_action_record(root,other,'scripted')[0])
   self.assertFalse(capture_action_record(root,value,'fixed')[0])

class ScriptedDeadlineTests(unittest.TestCase):
 def test_fault_requires_scripted_forward_driver(self):
  from tools.pilot.oak_worker import action_driver_valid
  for driver in ('fixed','scripted'):
   for mode in ('forward','stationary','mine_only','blocked'):
    self.assertEqual(action_driver_valid(driver,mode,'scripted_deadline'),driver=='scripted' and mode=='forward')
  self.assertTrue(action_driver_valid('scripted','forward','none'))
  self.assertTrue(action_driver_valid('fixed','forward','mid_action_disconnect'))
  self.assertFalse(action_driver_valid('scripted','forward','mid_action_disconnect'))
 def test_deadline_fault_bounds_coordinator_and_preserves_partial_receipt(self):
  from unittest.mock import patch
  from tools.pilot.oak_worker import run_scripted_actions
  partial={'schema_version':1,'status':'failed','error':'action coordinator failed','records':[{'reply':None}]}
  result={}
  with patch('tools.pilot.oak_worker.write_result'), patch('tools.pilot.oak_worker.run_action_script',return_value=partial) as run:
   run_scripted_actions(object(),'forward','scripted_deadline',20,result)
  self.assertEqual(run.call_args.kwargs['timeout'],.5)
  self.assertEqual(result['action_script'],partial)
  self.assertEqual(result['injection']['kind'],'scripted_deadline')
  self.assertEqual(result['injection']['timeout_seconds'],.5)
  self.assertGreaterEqual(result['injection']['finished_monotonic'],result['injection']['started_monotonic'])
