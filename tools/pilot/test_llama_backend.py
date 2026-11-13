"""Real UNIX HTTP worker and owned process lifecycle tests; no models or GPU."""
import json
import hashlib
import os
from pathlib import Path
import signal
import tempfile
import threading
import time
import unittest
from tools.pilot.llama_backend import OwnedLlamaBackend, _json

SERVER = r'''#!/usr/bin/python3
import sys,os,json,time,socketserver
from http.server import BaseHTTPRequestHandler
mode=os.environ.get("MODE","ok")
path=sys.argv[sys.argv.index("--host")+1]
if mode=="startup_slow":time.sleep(10)
if mode=="gpu":print("CUDA0: RTX test\nload_tensors: offloaded 29/29 layers to GPU",flush=True)
if mode=="log_flood":print("x"*140000,flush=True)
if mode=="late_gpu":
 print("x"*140000,flush=True)
 print("CUDA0: RTX test\nload_tensors: offloaded 29/29 layers to GPU",flush=True)
class Server(socketserver.UnixStreamServer):pass
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def send(self,data):
  raw=data if isinstance(data,bytes) else json.dumps(data).encode()
  self.send_response(200);self.send_header("Content-Length",str(len(raw)));self.end_headers()
  try:self.wfile.write(raw)
  except OSError:pass
 def do_GET(self):self.send({"status":"ok"})
 def do_POST(self):
  payload=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
  if self.path=="/tokenize":
   if mode=="oversize_input":self.send({"tokens":[1]*8193})
   else:self.send({"tokens":[1,2,3]})
   return
  if mode=="slow":time.sleep(10)
  if mode=="duplicate":self.send(b'{"content":"{}","content":"{}"}');return
  if mode=="oversize_response":self.send({"content":"x"*140000});return
  if payload["prompt"] != [1,2,3] or payload["cache_prompt"] is not False:
   self.send({"error":"wrong token replay"});return
  self.send({"content":'{"kind":"finish"}',"tokens_predicted":7,
   "tokens_evaluated":4 if mode=="count_mismatch" else 3,
   "stop":True,"stop_type":"eos","truncated":mode=="truncated"})
server=Server(path,Handler)
server.serve_forever()
'''


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="llama-test-")
        self.root = Path(self.tmp.name)
        self.runtime = self.root/"runtime"
        self.runtime.write_text(SERVER)
        self.runtime.chmod(0o700)
        self.model = self.root/"model.gguf"
        self.model.write_bytes(b"not-a-model")
        self.backends = []

    def tearDown(self):
        for backend in self.backends:
            backend.close()
        self.tmp.cleanup()

    def backend(self, mode="ok", cancel=None):
        backend = OwnedLlamaBackend(self.runtime,self.model,self.root/"backend.sock",
            env={"MODE":mode,"PATH":"/usr/bin:/bin"},gpu_layers="0",cancel=cancel)
        self.backends.append(backend)
        return backend

    def test_tokenizes_then_completes_with_ids_and_reaps_group(self):
        backend=self.backend()
        ready=backend.start(time.monotonic()+3)
        self.assertEqual(ready["status"],"ready")
        result=backend.complete("full raw prompt",time.monotonic()+3)
        self.assertEqual(result["status"],"completed")
        self.assertEqual(result["input_tokens"],3)
        self.assertEqual(result["tokens_evaluated"],3)
        self.assertEqual(result["output_tokens"],7)
        self.assertEqual(json.loads(result["content"]),{"kind":"finish"})
        cleanup=backend.close()
        self.assertEqual(cleanup["status"],"closed")
        self.assertTrue(cleanup["backend_reaped"])
        self.assertTrue(cleanup["group_gone"])
        with self.assertRaises(ProcessLookupError):
            os.killpg(ready["pid"],0)
        self.assertEqual(backend.close(),cleanup)

    def test_timeout_stops_backend_not_just_http_worker(self):
        backend=self.backend("slow")
        backend.start(time.monotonic()+3)
        start=time.monotonic()
        result=backend.complete("raw",time.monotonic()+.15)
        self.assertEqual(result["status"],"timeout")
        self.assertLess(time.monotonic()-start,3)
        self.assertEqual(result["cleanup"]["status"],"closed")

    def test_cancellation_stops_owned_backend(self):
        cancel=threading.Event()
        backend=self.backend("slow",cancel)
        backend.start(time.monotonic()+3)
        timer=threading.Timer(.15,cancel.set);timer.start()
        try:result=backend.complete("raw",time.monotonic()+3)
        finally:timer.join()
        self.assertEqual(result["status"],"cancelled")
        self.assertEqual(result["cleanup"]["status"],"closed")

    def test_startup_timeout_reaps(self):
        backend=self.backend("startup_slow")
        with self.assertRaises(TimeoutError):
            backend.start(time.monotonic()+.1)
        self.assertEqual(backend.cleanup["status"],"closed")

    def test_invalid_receipts_fail_closed(self):
        for mode in ("count_mismatch","truncated","duplicate","oversize_response","oversize_input"):
            with self.subTest(mode=mode):
                backend=OwnedLlamaBackend(self.runtime,self.model,self.root/(mode+".sock"),
                    env={"MODE":mode,"PATH":"/usr/bin:/bin"},gpu_layers="0")
                self.backends.append(backend)
                backend.start(time.monotonic()+3)
                result=backend.complete("raw",time.monotonic()+3)
                self.assertEqual(result["status"],"failed")
                self.assertNotIn("content",result)
                self.assertEqual(result["cleanup"]["status"],"closed")

    def test_invalid_prompts_and_limits_never_dispatch(self):
        backend=self.backend()
        backend.start(time.monotonic()+3)
        result=backend.complete("x"*65537,time.monotonic()+3)
        self.assertEqual(result["status"],"failed")
        self.assertIsNone(result["input_tokens"])
        self.assertEqual(result["cleanup"]["status"],"closed")

    def test_public_socket_parent_rejected(self):
        parent=self.root/"public";parent.mkdir(mode=0o755)
        backend=OwnedLlamaBackend(self.runtime,self.model,parent/"a.sock")
        with self.assertRaises(ValueError):backend.start(time.monotonic()+3)
        self.assertIsNone(backend.process)

    def test_existing_socket_path_rejected(self):
        (self.root/"backend.sock").write_text("preserve")
        backend=self.backend()
        with self.assertRaises(ValueError):backend.start(time.monotonic()+3)
        self.assertEqual((self.root/"backend.sock").read_text(),"preserve")

    def test_required_gpu_rejects_cpu_fallback(self):
        backend=self.backend()
        backend.require_gpu=True
        with self.assertRaises(RuntimeError):backend.start(time.monotonic()+3)
        self.assertEqual(backend.cleanup["status"],"closed")
        self.assertFalse(backend.cleanup["gpu_verified"])

    def test_required_gpu_accepts_positive_runtime_evidence(self):
        backend=self.backend("gpu")
        backend.require_gpu=True
        ready=backend.start(time.monotonic()+3)
        self.assertTrue(ready["gpu_verified"])
        self.assertTrue(backend.close()["gpu_verified"])

    def test_log_capture_is_bounded_and_drained(self):
        backend=self.backend("log_flood")
        backend.start(time.monotonic()+3)
        self.assertEqual(len(backend.log),65536)
        self.assertTrue(backend.log_truncated)
        self.assertTrue(backend.close()["log_reader_stopped"])

    def test_gpu_evidence_after_prefix_limit_is_preserved(self):
        backend=self.backend("late_gpu")
        backend.require_gpu=True
        ready=backend.start(time.monotonic()+3)
        self.assertTrue(ready["gpu_verified"])
        self.assertTrue(ready["log_truncated"])
        self.assertGreater(ready["log_bytes"],140000)
        self.assertNotIn(b"CUDA0",backend.log)
        self.assertIn(b"CUDA0",backend.log_tail)
        self.assertEqual(ready["gpu_offload_evidence"],"offloaded 29/29 layers to GPU")
        self.assertTrue(backend.close()["gpu_verified"])

    def test_split_evidence_and_full_stream_hash(self):
        backend=self.backend()
        parts=[b"x"*70000,b"CU",b"DA0: device\n",b"offloaded 29/",b"29 layers to G",b"PU\n",b"y"*10000]
        for part in parts:backend._capture_log(part)
        receipt=backend._log_receipt()
        self.assertTrue(receipt["gpu_verified"])
        self.assertEqual(receipt["log_sha256"],hashlib.sha256(b"".join(parts)).hexdigest())
        self.assertEqual(receipt["log_bytes"],sum(map(len,parts)))
        self.assertEqual(len(backend.log),65536)
        self.assertEqual(len(backend.log_tail),8192)
        self.assertLessEqual(len(backend._log_overlap),512)

    def test_invalid_deadline_does_not_start(self):
        backend=self.backend()
        with self.assertRaises(TimeoutError):backend.start(float("nan"))
        self.assertIsNone(backend.process)


if __name__=="__main__":unittest.main()
