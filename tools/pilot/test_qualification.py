import json,os,tempfile,unittest
from pathlib import Path
from unittest import mock
from tools.pilot.qualification import run_qualification,QualificationError,QUAL_PROPERTIES
from tools.pilot.server import ProcessResult
class Tests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.root=Path(self.t.name);self.tools=self.root/'tools';(self.tools/'bin').mkdir(parents=True);(self.tools/'node_modules').mkdir();(self.tools/'bin/node').write_text('node');(self.tools/'qualification-client.mjs').write_text('client')
 def tearDown(self):self.t.cleanup()
 def restore(self,output,**kw):
  output.mkdir(mode=0o700);os.chmod(output,0o700);(output/'server.properties').write_text('base');os.chmod(output/'server.properties',0o600);(output/'runtime-manifest.json').write_text('{}');os.chmod(output/'runtime-manifest.json',0o600);return {'snapshot_sha256':'a'*64,'server_jar_sha256':'b'*64}
 def result(self,code=0):return ProcessResult('exited',code,None,False,False,False,False,False,False,b'',b'',False,False,.1)
 def test_fixed_namespace_contract_private_delta_and_no_secret_argv(self):
  seen={}
  def runner(argv,**kw):
   seen["argv"]=argv;seen["kw"]=kw;e=kw["cwd"]/"qualification-evidence.json";e.write_text(json.dumps({"status":"passed"}));os.chmod(e,0o600);return self.result()
  with mock.patch('tools.pilot.qualification.restore_mod.verify_runtime',return_value={}), mock.patch('tools.pilot.qualification.verify_tools',return_value={}):
   report=run_qualification(workspace=self.root/'work',restore_kwargs={},tool_snapshot=self.tools,tool_manifest_sha256="c"*64,runner=runner,restore_fn=self.restore,validate_bwrap=False)
  self.assertEqual(report['status'],'completed');self.assertFalse(report['independent_observer_process']);self.assertIn('--unshare-net',seen['argv']);self.assertIn('/pilot-tools',seen['argv']);self.assertIn('/pilot-code',seen['argv']);self.assertNotIn('rcon.password',' '.join(seen['argv']));self.assertNotIn('PILOT_RCON_PASSWORD',seen['kw']['env']);self.assertFalse((self.root/'work/runtime/.qualification-rcon-password').exists());self.assertEqual((self.root/'work').stat().st_mode&0o777,0o700);props=(self.root/'work/runtime/server.properties').read_text();self.assertIn(QUAL_PROPERTIES,props);self.assertRegex(props,r'rcon.password=\S+');self.assertEqual((self.root/'work/qualification-summary.json').stat().st_mode&0o777,0o600)
 def test_requires_new_workspace_and_complete_snapshot(self):
  existing=self.root/'existing';existing.mkdir()
  with self.assertRaises(QualificationError):run_qualification(workspace=existing,restore_kwargs={},tool_snapshot=self.tools,tool_manifest_sha256="c"*64)
  (self.tools/'bin/node').unlink()
  with mock.patch("tools.pilot.qualification.verify_tools",return_value={}):
   with self.assertRaises(QualificationError):run_qualification(workspace=self.root/"new",restore_kwargs={},tool_snapshot=self.tools,tool_manifest_sha256="c"*64,validate_bwrap=False)
 def test_failure_is_preserved(self):
  with mock.patch('tools.pilot.qualification.restore_mod.verify_runtime',return_value={}), mock.patch('tools.pilot.qualification.verify_tools',return_value={}):
   report=run_qualification(workspace=self.root/'failed',restore_kwargs={},tool_snapshot=self.tools,tool_manifest_sha256="c"*64,restore_fn=self.restore,validate_bwrap=False,runner=lambda *a,**k:self.result(1))
  self.assertEqual(report['status'],'failed')
if __name__=='__main__':unittest.main()