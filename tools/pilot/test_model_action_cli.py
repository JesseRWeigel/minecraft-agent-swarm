"""Actual descriptor-alias rejection at the Node CLI boundary; no game/model."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

NODE = os.environ.get("PILOT_TEST_NODE") or shutil.which("node")

class ModelActionCliTests(unittest.TestCase):
 @unittest.skipUnless(NODE, "Node required")
 def test_duplicated_lifecycle_pipes_rejected_before_dependencies_load(self):
  module=(Path(__file__).parent/"oak-participant-cli.mjs").resolve().as_uri()
  source="""import {runParticipantProcess} from MODULE;
const code=await runParticipantProcess({argv:['--trial-id','collect-oak-log-v1','--action-id','collect-01','--movement','model'],loadMineflayer:async()=>{process.exit(42);}});process.exit(code);
""".replace("MODULE",repr(module))
  adapter="import os,sys; os.dup2(0,3,inheritable=True); os.dup2(1,4,inheritable=True); os.execv(sys.argv[1],[sys.argv[1],'--input-type=module','-e',sys.argv[2]])"
  result=subprocess.run([sys.executable,'-c',adapter,NODE,source],input=b'',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5,close_fds=True)
  self.assertEqual(result.returncode,1,result.stderr)
  self.assertEqual(result.stdout,b'')
  self.assertEqual(result.stderr,b'participant failed\n')


 @unittest.skipUnless(NODE, "Node required")
 def test_real_node_cli_keeps_actions_and_lifecycle_on_separate_pipes(self):
  import json,select
  from tools.pilot.action_descriptors import ActionDescriptors,spawn_action_sandbox
  from tools.pilot.participant_transport import ParticipantTransport
  module=(Path(__file__).parent/"oak-participant-cli.mjs").resolve().as_uri()
  source="""import {EventEmitter} from 'node:events';import {runParticipantProcess} from MODULE;
const b=new EventEmitter();b.entity={position:{x:.5,y:200,z:.5},yaw:0,pitch:0};b.health=20;b.inventory={slots:[]};
b._client={write(){}};b.waitForTicks=b.look=b.dig=async()=>{};b.blockAt=b.blockAtCursor=()=>null;b.canDigBlock=()=>false;
b.setControlState=b.clearControlStates=b.stopDigging=()=>{};b.end=()=>b.emit('end');b.quit=async()=>b.emit('end');
const code=await runParticipantProcess({argv:['--trial-id','collect-oak-log-v1','--action-id','collect-01','--movement','model'],loadMineflayer:async()=>({createBot:()=>b}),hardExitOnWatchdog:true,watchdogMs:4000});process.exit(code);
""".replace("MODULE",repr(module))
  d=ActionDescriptors.create();child=transport=None
  try:
   child=spawn_action_sandbox([NODE,'--input-type=module','-e',source],d,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
   transport=ParticipantTransport(child,trial_id='collect-oak-log-v1',action_id='collect-01')
   transport.wait_ready();transport.send_begin()
   os.write(d.host_write,json.dumps({'schema_version':1,'trial_id':'collect-oak-log-v1','action_id':'collect-01','sequence':1,'action':{'kind':'finish'}}).encode()+b'\n')
   os.close(d.host_write);d.host_write=None
   self.assertTrue(select.select([d.host_read],[],[],2)[0]);raw=os.read(d.host_read,20481)
   self.assertEqual(json.loads(raw),{'schema_version':1,'sequence':1,'status':'finished'})
   transport.wait_action_finished();transport.send_finalize();transport.wait_exit()
   self.assertEqual(child.returncode,0);self.assertEqual(transport.stderr,b'')
  finally:
   if child is not None and child.poll() is None:child.kill();child.wait(timeout=2)
   if transport is not None:transport.close()
   d.close_child();d.close_host()
