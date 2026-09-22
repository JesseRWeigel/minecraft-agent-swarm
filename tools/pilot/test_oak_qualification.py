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
