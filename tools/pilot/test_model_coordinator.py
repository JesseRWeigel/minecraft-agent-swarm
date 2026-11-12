"""Real HTTP adapter + real Node action broker, with a fake bot and no game."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from tools.pilot import model_coordinator
from tools.pilot.action_coordinator import audit_action_eof
from tools.pilot.action_descriptors import ActionDescriptors, spawn_action_sandbox
from tools.pilot.participant_transport import ParticipantTransport

NODE = os.environ.get("PILOT_TEST_NODE") or shutil.which("node")


class FakeModel:
    def __init__(self, actions, delay=0):
        self.actions, self.requests, self.delay = actions, [], delay
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                request=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append(request)
                time.sleep(outer.delay)
                action=outer.actions[min(len(outer.requests)-1, len(outer.actions)-1)]
                raw=json.dumps({"model":"fixture:1","done":True,"done_reason":"stop",
                    "message":{"role":"assistant","content":json.dumps(action)},
                    "prompt_eval_count":10,"eval_count":7}).encode()
                self.send_response(200);self.send_header("Content-Length",str(len(raw)));self.end_headers()
                try:self.wfile.write(raw)
                except OSError:pass
        self.server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
    def __enter__(self):
        self.thread.start()
        return self
    def __exit__(self,*args):
        self.server.shutdown();self.server.server_close();self.thread.join(2)
    @property
    def port(self):return self.server.server_port


@unittest.skipUnless(NODE, "Node required")
class ModelLoopTests(unittest.TestCase):
    def setUp(self):
        module=(Path(__file__).parent/"oak-participant-cli.mjs").resolve().as_uri()
        source="""import {EventEmitter} from 'node:events';import {runParticipantProcess} from MODULE;
const b=new EventEmitter();b.entity={position:{x:.5,y:200,z:.5},yaw:0,pitch:0};b.health=20;b.inventory={slots:[]};
b._client={write(){}};b.waitForTicks=b.look=b.dig=async()=>{};b.blockAt=b.blockAtCursor=()=>null;b.canDigBlock=()=>false;
b.setControlState=b.clearControlStates=b.stopDigging=()=>{};b.end=()=>b.emit('end');b.quit=async()=>b.emit('end');
const code=await runParticipantProcess({argv:['--trial-id','collect-oak-log-v1','--action-id','collect-01','--movement','model'],loadMineflayer:async()=>({createBot:()=>b}),hardExitOnWatchdog:true,watchdogMs:8000});process.exit(code);
""".replace("MODULE",repr(module))
        self.d=ActionDescriptors.create()
        self.child=spawn_action_sandbox([NODE,"--input-type=module","-e",source],self.d,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
        self.transport=ParticipantTransport(self.child,trial_id="collect-oak-log-v1",action_id="collect-01")
        self.transport.wait_ready();self.transport.send_begin()
    def tearDown(self):
        if self.child.poll() is None:self.child.kill()
        self.child.wait(timeout=2)
        self.transport.close();self.d.close_child();self.d.close_host()
    def run_loop(self,server,**kwargs):
        return model_coordinator.run_model_actions(self.d,port=server.port,model="fixture:1",
            build_prompt=lambda records:[{"role":"user","content":json.dumps(records)}],
            count_tokens=lambda messages:10,timeout=kwargs.pop("timeout",3),**kwargs)
    def test_http_to_actual_broker_and_lifecycle(self):
        with FakeModel([{"kind":"look","yaw":0,"pitch":0},{"kind":"observe"},{"kind":"finish"}]) as server:
            result=self.run_loop(server)
        self.assertEqual(result["status"],"finished",result)
        self.assertEqual([a["request"]["sequence"] for a in result["actions"]],[1,2,3,4])
        self.assertEqual(len(result["calls"]),3)
        self.assertEqual(len(result["budget"]),3)
        self.assertEqual(sum(r["charged_output_tokens"] for r in result["budget"]),21)
        self.assertIn("participant_bot",result["calls"][0]["messages"][0]["content"])
        self.transport.wait_action_finished();self.transport.send_finalize();self.transport.wait_exit()
        self.assertEqual(self.child.returncode,0)
        self.assertEqual(audit_action_eof(self.d)["status"],"verified")
    def test_invalid_action_is_rejected_by_real_broker(self):
        with FakeModel([{"kind":"run_shell","command":"ignored"}]) as server:
            result=self.run_loop(server)
        self.assertEqual(result["status"],"failed")
        self.assertIsNone(result["actions"][-1]["reply"])
        self.assertIsNone(self.d.host_write)
    def test_pre_cancelled_does_not_observe_or_infer(self):
        cancel=threading.Event();cancel.set()
        with FakeModel([{"kind":"finish"}]) as server:
            result=self.run_loop(server,cancel=cancel)
        self.assertEqual(result["status"],"cancelled")
        self.assertEqual(result["actions"],[])
        self.assertEqual(server.requests,[])
    def test_cancel_after_adapter_success_never_dispatches_model_action(self):
        cancel=threading.Event();original=model_coordinator.call_ollama
        def call(**kwargs):
            result=original(**kwargs);cancel.set();return result
        with FakeModel([{"kind":"finish"}]) as server,patch.object(model_coordinator,"call_ollama",side_effect=call):
            result=self.run_loop(server,cancel=cancel)
        self.assertEqual(result["status"],"cancelled")
        self.assertEqual(len(result["actions"]),1)
        self.assertEqual(len(result["calls"]),1)
    def test_delayed_output_cannot_start_action(self):
        with FakeModel([{"kind":"finish"}],delay=.3) as server:
            result=self.run_loop(server,timeout=.1)
        self.assertEqual(result["status"],"timeout")
        self.assertEqual(len(result["actions"]),1)
        self.assertTrue(result["calls"][0]["response"]["worker_reaped"])
    def test_eight_calls_are_hard_limit(self):
        with FakeModel([{"kind":"observe"}]) as server:
            result=self.run_loop(server)
        self.assertEqual(result["status"],"budget_exhausted",result)
        self.assertEqual(len(server.requests),8)
        self.assertEqual(len(result["actions"]),9)
        self.assertIsNone(self.d.host_write)
    def test_tokenizer_failure_stops_before_inference(self):
        with FakeModel([{"kind":"finish"}]) as server:
            result=model_coordinator.run_model_actions(self.d,port=server.port,model="fixture:1",
                build_prompt=lambda records:[{"role":"user","content":"fixture"}],
                count_tokens=lambda messages:(_ for _ in ()).throw(ValueError()))
        self.assertEqual(result["status"],"failed")
        self.assertEqual(server.requests,[])
    def test_oversized_prompt_is_not_copied_retained_or_tokenized(self):
        with FakeModel([{"kind":"finish"}]) as server:
            tokenized=[]
            result=model_coordinator.run_model_actions(self.d,port=server.port,model="fixture:1",
                build_prompt=lambda records:[{"role":"user","content":"x"*65537}],
                count_tokens=lambda messages:(tokenized.append(True) or 10))
        self.assertEqual(result["status"],"failed")
        self.assertEqual(result["calls"],[])
        self.assertEqual(tokenized,[])
        self.assertEqual(server.requests,[])
    def test_tokenizer_cannot_mutate_stored_prompt(self):
        def tokenizer(messages):
            messages[0]["content"]="changed by tokenizer"
            return 10
        with FakeModel([{"kind":"finish"}]) as server:
            result=model_coordinator.run_model_actions(self.d,port=server.port,model="fixture:1",
                build_prompt=lambda records:[{"role":"user","content":"original"}],
                count_tokens=tokenizer)
        self.assertEqual(result["status"],"finished")
        self.assertEqual(result["calls"][0]["messages"][0]["content"],"original")
        self.assertEqual(server.requests[0]["messages"][0]["content"],"original")
    def test_deadline_includes_prompt_builder(self):
        with FakeModel([{"kind":"finish"}]) as server:
            result=model_coordinator.run_model_actions(self.d,port=server.port,model="fixture:1",
                build_prompt=lambda records:(time.sleep(.1) or [{"role":"user","content":"fixture"}]),
                count_tokens=lambda messages:10,timeout=.05)
        self.assertEqual(result["status"],"timeout")
        self.assertEqual(server.requests,[])

if __name__=="__main__":unittest.main()
