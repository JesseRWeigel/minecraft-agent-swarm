import json,threading,time,unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from tools.pilot.inference_budget import InferenceBudget
from tools.pilot.ollama_adapter import call_ollama

class Server:
 def __init__(self,mode='ok'):
  self.requests=[];self.entered=threading.Event();self.closed=threading.Event();outer=self
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    raw=self.rfile.read(int(self.headers['Content-Length']));outer.requests.append((self.path,json.loads(raw)));outer.entered.set()
    if mode=='trickle':
     self.send_response(200);self.send_header('Content-Length','1000');self.end_headers()
     try:
      for _ in range(1000):self.wfile.write(b' ');self.wfile.flush();time.sleep(.08)
     except OSError:outer.closed.set()
     return
    if mode=='stall':
     self.connection.settimeout(3)
     try:
      if self.connection.recv(1)==b'':outer.closed.set()
     except OSError:pass
     return
    value={'model':'fixture:1','done':True,'done_reason':'stop','message':{'role':'assistant','content':'{"kind":"observe"}'},'prompt_eval_count':10,'eval_count':7}
    if mode=='input_mismatch':value['prompt_eval_count']=9
    if mode=='missing_usage':value.pop('eval_count')
    if mode=='mismatch':value['model']='other'
    if mode=='unfinished':value['done']=False
    if mode=='over_tokens':value['eval_count']=257
    if mode=='bad_action':value['message']['content']='not json'
    if mode=='duplicate_action':value['message']['content']='{"kind":"observe","kind":"finish"}'
    if mode=='huge_content':value['message']['content']='x'*4097
    if mode=='thinking':value['message']['thinking']='hidden reasoning'
    raw=json.dumps(value).encode()
    if mode=='huge_body':raw=b'x'*65537
    if mode=='duplicate_envelope':raw=b'{"done":true,"done":false}'
    if mode=='redirect':self.send_response(302);self.send_header('Location','http://example.invalid');self.end_headers();return
    self.send_response(200)
    if mode=='chunked':
     self.send_header('Transfer-Encoding','chunked');self.end_headers();self.wfile.write(('%x\r\n'%len(raw)).encode()+raw+b'\r\n0\r\n\r\n')
    else:
     self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
  self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True
  self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
 def __enter__(self):return self
 def __exit__(self,*args):self.server.shutdown();self.server.server_close();self.thread.join(2)
 @property
 def port(self):return self.server.server_port

class AdapterTests(unittest.TestCase):
 def call(self,server,budget=None,**kw):
  return call_ollama(port=server.port,model='fixture:1',messages=[{'role':'user','content':'Choose one action'}],input_tokens=10,budget=budget or InferenceBudget(),**kw)
 def test_completed_content_and_actual_usage_with_chunked_http(self):
  for mode in ('ok','chunked'):
   with Server(mode) as s:
    b=InferenceBudget();r=self.call(s,b)
    self.assertEqual(r['status'],'completed');self.assertEqual(json.loads(r['content']),{'kind':'observe'})
    self.assertEqual(b.output_tokens_used,7);self.assertTrue(r['worker_reaped']);self.assertEqual(r['worker_returncode'],0)
    path,request=s.requests[0];self.assertEqual(path,'/api/chat');self.assertIs(request['stream'],False);self.assertEqual(request['options']['num_predict'],256)
 def test_missing_usage_keeps_full_reservation(self):
  with Server('missing_usage') as s:
   b=InferenceBudget();r=self.call(s,b);self.assertEqual(r['status'],'completed');self.assertEqual(b.output_tokens_used,256);self.assertFalse(b.records[0].usage_known)
 def test_invalid_responses_never_return_content(self):
  for mode in ('input_mismatch','mismatch','unfinished','over_tokens','bad_action','duplicate_action','huge_content','thinking','huge_body','duplicate_envelope','redirect'):
   with self.subTest(mode=mode),Server(mode) as s:
    b=InferenceBudget();r=self.call(s,b);self.assertEqual(r['status'],'failed');self.assertNotIn('content',r);self.assertEqual(b.calls_used,1);self.assertEqual(b.output_tokens_used,256);self.assertTrue(r['worker_reaped'])
 def test_wall_timeout_reaps_worker_and_closes_socket(self):
  with Server('stall') as s:
   b=InferenceBudget();start=time.monotonic();r=self.call(s,b,timeout_cap=.3)
   self.assertEqual(r['status'],'timeout');self.assertLess(time.monotonic()-start,2);self.assertTrue(r['worker_reaped']);self.assertTrue(s.closed.wait(1));self.assertEqual(b.output_tokens_used,256)
 def test_cancellation_after_dispatch_reaps_worker(self):
  with Server('stall') as s:
   cancel=threading.Event()
   def stop():s.entered.wait(2);cancel.set()
   t=threading.Thread(target=stop);t.start()
   try:r=self.call(s,cancel=cancel);self.assertEqual(r['status'],'cancelled');self.assertTrue(r['worker_reaped']);self.assertTrue(s.closed.wait(1))
   finally:t.join(3)
 def test_pre_cancelled_call_does_not_dispatch(self):
  with Server() as s:
   cancel=threading.Event();cancel.set();b=InferenceBudget();r=self.call(s,b,cancel=cancel)
   self.assertEqual(r['status'],'cancelled');self.assertEqual(b.calls_used,0);self.assertEqual(s.requests,[])
 def test_exhausted_budget_never_dispatches(self):
  b=InferenceBudget()
  for _ in range(8):b.begin(1);b.finish(None,outcome='failed')
  with Server() as s:
   self.assertEqual(self.call(s,b)['status'],'failed');self.assertEqual(s.requests,[])
 def test_invalid_request_is_rejected_before_dispatch(self):
  with Server() as s:
   for messages in ([{'role':'tool','content':'x'}],[{'role':'user','content':'x'*65536}],[]):
    b=InferenceBudget();r=call_ollama(port=s.port,model='fixture:1',messages=messages,input_tokens=1,budget=b)
    self.assertEqual(r['status'],'failed');self.assertEqual(b.calls_used,0)
   self.assertEqual(s.requests,[])
 def test_slow_body_cannot_reset_total_deadline(self):
  with Server('trickle') as s:
   start=time.monotonic();r=self.call(s,timeout_cap=.3)
   self.assertEqual(r['status'],'timeout');self.assertLess(time.monotonic()-start,2);self.assertTrue(r['worker_reaped']);self.assertNotIn('content',r)
 def test_cancellation_during_final_cleanup_suppresses_success(self):
  from unittest.mock import patch
  from tools.pilot import ollama_adapter
  cancel=threading.Event();original=ollama_adapter._reap
  def reap(process):
   result=original(process);cancel.set();return result
  with Server() as s,patch.object(ollama_adapter,'_reap',side_effect=reap):
   b=InferenceBudget();r=self.call(s,b,cancel=cancel)
   self.assertEqual(r['status'],'cancelled');self.assertNotIn('content',r);self.assertEqual(b.output_tokens_used,256)
 def test_transport_failure_still_consumes_attempt(self):
  from unittest.mock import patch
  with Server() as s,patch('tools.pilot.ollama_adapter.subprocess.Popen',side_effect=OSError('private path')):
   b=InferenceBudget();r=self.call(s,b)
   self.assertEqual(r['status'],'failed');self.assertEqual(b.calls_used,1);self.assertEqual(b.output_tokens_used,256);self.assertNotIn('private path',str(r));self.assertEqual(s.requests,[])


 def test_delayed_spawn_cannot_return_late_content(self):
  from unittest.mock import patch
  from tools.pilot import ollama_adapter
  original=ollama_adapter.subprocess.Popen
  def delayed(*args,**kwargs):
   process=original(*args,**kwargs);time.sleep(.15);return process
  with Server() as s,patch.object(ollama_adapter.subprocess,'Popen',side_effect=delayed):
   b=InferenceBudget();r=self.call(s,b,timeout_cap=.05)
   self.assertEqual(r['status'],'timeout');self.assertNotIn('content',r);self.assertTrue(r['worker_reaped']);self.assertEqual(b.output_tokens_used,256);self.assertEqual(s.requests,[])
