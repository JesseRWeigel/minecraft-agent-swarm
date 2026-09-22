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
