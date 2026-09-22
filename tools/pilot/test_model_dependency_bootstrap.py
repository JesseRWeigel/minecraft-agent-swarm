"""Real dependency bootstrap with action FIFOs in a network-isolated namespace."""
import os,shutil,subprocess,tempfile,unittest
from pathlib import Path
from tools.pilot.action_descriptors import ActionDescriptors,spawn_action_sandbox
from tools.pilot.oak_qualification import capture_sources

class ModelDependencyBootstrapTests(unittest.TestCase):
 @unittest.skipUnless(os.environ.get('PILOT_TEST_BWRAP'),'explicit namespace qualification required')
 def test_mineflayer_loads_with_action_pipes_before_expected_connection_refusal(self):
  repo=Path(__file__).resolve().parents[2]
  modules=Path(os.environ.get('PILOT_TEST_NODE_MODULES',str(repo/'node_modules'))).resolve(strict=True)
  node=Path(os.environ.get('PILOT_TEST_NODE') or shutil.which('node')).resolve(strict=True)
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);capture_sources(root);d=ActionDescriptors.create();process=None
   args=[os.environ['PILOT_TEST_BWRAP'],'--die-with-parent','--new-session','--unshare-all','--cap-drop','ALL','--clearenv','--setenv','HOME','/tmp','--ro-bind','/usr','/usr']
   for path in ('/lib','/lib64'):
    if Path(path).exists():args+=['--ro-bind',path,path]
   args+=['--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/pilot-tools','--dir','/pilot-tools/bin','--ro-bind',str(node),'/pilot-tools/bin/node','--ro-bind',str(modules),'/pilot-tools/node_modules','--ro-bind',str(root/'participant-code'),'/participant-code','--chdir','/tmp','--','/pilot-tools/bin/node','/participant-code/oak-participant-cli.mjs','--trial-id','collect-oak-log-v1','--action-id','collect-01','--movement','model']
   try:
    process=spawn_action_sandbox(args,d,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    stdout,stderr=process.communicate(b'',timeout=8)
    self.assertEqual(process.returncode,1,stderr)
    self.assertEqual(stdout,b'')
    self.assertIn(b'"stage":"participant_run"',stderr)
    self.assertNotIn(b'"stage":"load_dependencies"',stderr)
   finally:
    if process is not None and process.poll() is None:process.kill();process.wait(timeout=2)
    d.close_child();d.close_host()
