import unittest
from pathlib import Path
from tools.pilot.oak_qualification import run_oak_qualification, validate_result

class OakQualificationTests(unittest.TestCase):
 def test_launch_requires_explicit_opt_in(self):
  with self.assertRaisesRegex(ValueError,"launch=True"):
   run_oak_qualification(workspace=Path('/never-created'),restore_kwargs={},tool_snapshot=None,tool_manifest_sha256=None)
 def test_rejects_malformed_or_movement_evidence(self):
  for value in (None,{},[],{'schema_version':1,'status':'qualified','trial_id':'movement-fixture-v1','action_id':'walk-01'}):
   self.assertFalse(validate_result(value,'forward',None))
 def test_rejects_unsupported_failure_before_mutation(self):
  with self.assertRaises(ValueError):
   run_oak_qualification(launch=True,workspace=Path('/never-created'),restore_kwargs={},tool_snapshot=None,tool_manifest_sha256=None,failure_case='death')

 def test_source_manifest_binds_generated_mount_inputs(self):
  import tempfile,json,hashlib,os
  from tools.pilot.oak_qualification import capture_sources
  with tempfile.TemporaryDirectory() as name:
   root=Path(name);pin=capture_sources(root);m=json.loads((root/'source-manifest.json').read_text())
   self.assertEqual(hashlib.sha256(json.dumps({'files':m['files'],'generated':m['generated']},sort_keys=True,separators=(',',':')).encode()).hexdigest(),pin)
   for relative,item in m['generated'].items():
    if item['type']=='file':self.assertEqual(hashlib.sha256((root/relative).read_bytes()).hexdigest(),item['sha256'])
    else:self.assertEqual(os.readlink(root/relative),item['target'])
   self.assertIn('observer-code/host-network-namespace',m['generated'])

 def test_fixture_rejects_incomplete_or_mismatched_setup(self):
  from tools.pilot.oak_worker import fixture_valid
  for v in [None,{}, {'setup':None},{'setup':{'fixture':None}},{'setup':{'fixture':{'sha256':'incorrect'},'status':'configured'},'baselineVerification':{'status':'verified'}}]:
   self.assertFalse(fixture_valid(v))

 def test_negative_controls_require_complete_expected_endpoints(self):
  from copy import deepcopy
  from tools.pilot.oak_worker import endpoint_valid
  score={'baselineVerification':{'status':'verified'},'endpoint':{'status':'observed','gameplayQualified':False,'acquired':False}}
  before={'actorSample':{'observations':{'position':{'x':.5,'y':200,'z':.5}}}}
  for mode,block,z in [('mine_only','minecraft:air',.5),('blocked','minecraft:oak_log',1.7)]:
   terminal={**deepcopy(before),'inventory':[],'targetBlock':block}
   terminal['actorSample']['observations']['position']['z']=z
   self.assertTrue(endpoint_valid(score,mode,before,terminal))
   for key in ('inventory','targetBlock','actorSample'):
    broken=deepcopy(terminal);del broken[key]
    self.assertFalse(endpoint_valid(score,mode,before,broken))
   broken=deepcopy(terminal);broken['inventory']=[{'id':'minecraft:oak_log','count':1,'slot':0}]
   self.assertFalse(endpoint_valid(score,mode,before,broken))
   broken=deepcopy(score);broken['endpoint']['acquired']=True
   self.assertFalse(endpoint_valid(broken,mode,before,terminal))
   broken=deepcopy(terminal);broken['actorSample']['observations']['position']['z']=.5 if mode=='blocked' else 1.7
   self.assertFalse(endpoint_valid(score,mode,before,broken))

 def test_observer_records_require_fixture_and_successful_process_receipts(self):
  import tempfile,json,hashlib
  from tools.pilot.oak_qualification import capture_observer_records
  with tempfile.TemporaryDirectory() as name:
   root=Path(name);result={phase:{'phase':phase,'payload':'original'} for phase in ('fixture','before','terminal')}
   original={}
   for phase in result:
    raw=json.dumps({'returncode':0,'error':None,'result':result[phase]})
    original[phase]=raw;(root/f'observer-{phase}.json').write_text(raw);(root/f'observer-{phase}.json').chmod(0o600)
   valid,pins=capture_observer_records(root,result)
   self.assertTrue(valid)
   self.assertEqual(set(pins),{'fixture','before','terminal'})
   for phase in result:
    self.assertEqual(pins[phase],hashlib.sha256(original[phase].encode()).hexdigest())
    path=root/f'observer-{phase}.json'
    for bad in ({'returncode':0,'error':None,'result':{'phase':phase,'payload':'altered'}},
                {'returncode':1,'error':None,'result':result[phase]},
                {'returncode':False,'error':None,'result':result[phase]},
                {'returncode':0,'error':'observer_deadline','result':result[phase]},
                {'result':result[phase]},None):
     path.write_text(json.dumps(bad));self.assertFalse(capture_observer_records(root,result)[0])
    path.unlink();self.assertFalse(capture_observer_records(root,result)[0])
    path.write_text(original[phase]);path.chmod(0o600)
   self.assertFalse(capture_observer_records(root,None)[0])

 def test_fault_modes_cannot_run_with_unrelated_clients(self):
  from tools.pilot.oak_worker import fault_mode_valid
  for fault in ('item_only','item_and_block'):
   self.assertTrue(fault_mode_valid(fault,'stationary'))
   for mode in ('forward','mine_only','blocked'):
    self.assertFalse(fault_mode_valid(fault,mode))
  self.assertTrue(fault_mode_valid('observer_timeout','forward'))
  self.assertTrue(fault_mode_valid('mid_action_disconnect','forward'))
  self.assertFalse(fault_mode_valid('mid_action_disconnect','stationary'))
  self.assertFalse(fault_mode_valid('observer_timeout','stationary'))
  self.assertFalse(fault_mode_valid('unknown','forward'))

 def test_valid_looking_endpoint_cannot_promote_declared_fault(self):
  for fault in ('item_only','item_and_block','observer_timeout'):
   self.assertFalse(validate_result({'schema_version':1,'failure_case':fault,'status':'qualified'},'forward',{'endpoint':{'acquired':True}}))

 def test_published_controls_and_forged_completion_evidence(self):
  import json,copy
  rows=json.loads((Path(__file__).parents[2]/'docs/research/oak-negative-results-2026-09-22.json').read_text())['attempts']
  # The public derivative omits fixture receipts; test endpoint and completion
  # tampering directly against independently recorded real samples.
  from tools.pilot.oak_worker import endpoint_valid
  for row in rows:
   mode=row['control_mode'];score=row['host_score']
   self.assertTrue(endpoint_valid(score,mode,row['before'],row['terminal']))
   self.assertFalse(endpoint_valid(score,mode,row['before'],None))
   bad=copy.deepcopy(score);bad['endpoint']['status']='invalid'
   self.assertFalse(endpoint_valid(bad,mode,row['before'],row['terminal']))

 def test_injection_receipt_rejects_even_if_failure_label_removed(self):
  import json,copy
  row=json.loads((Path(__file__).parents[2]/'docs/research/oak-negative-results-2026-09-22.json').read_text())['attempts'][2]
  fixture={'schema_version':1,'phase':'fixture','baseline':row['before'],'baselineVerification':{'status':'verified'},'setup':{'status':'configured','fixture':{'sha256':'b8d4a036e735f449674c207c94af99be2dc40680245ceb56c4f7c2a76e91a942'},'parentSetup':{'status':'configured'},'commandReceipts':[{'outcome':'issued'}]*7,'blockChecks':[{'status':'verified'}]*7}}
  value={**row['lifecycle'],'schema_version':1,'status':'qualified','failure_case':'none','control_mode':'forward','trial_id':'collect-oak-log-v1','action_id':'collect-01','independent_observer_process':True,'error':None,'network_policy':'game_only_unix_v1','fixture':fixture,'before':row['before'],'terminal':row['terminal'],'action_started_monotonic':10,'action_finished_monotonic':14,'injection':None}
  self.assertTrue(validate_result(value,'forward',row['host_score']))
  value['injection']={'mode':'item_and_block','status':'completed'}
  self.assertFalse(validate_result(value,'forward',row['host_score']))
