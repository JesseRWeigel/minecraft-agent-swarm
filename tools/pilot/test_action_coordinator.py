import json
import os
import subprocess
import sys
import unittest

from tools.pilot.action_coordinator import audit_action_eof, run_action_script
from tools.pilot.action_descriptors import ActionDescriptors

DESCRIPTOR_ADAPTER = os.path.join(os.path.dirname(__file__), "action_descriptors.py")


CHILD = r'''import json, os, sys, time
mode=sys.argv[1]
for expected in range(1, 3):
 line=b""
 while not line.endswith(b"\n"):
  chunk=os.read(3,1)
  if not chunk: raise SystemExit(2)
  line += chunk
 request=json.loads(line)
 if mode == "idle": time.sleep(.2)
 if mode == "malformed": os.write(4,b'{"sequence":1}\n'); raise SystemExit(0)
 if mode == "duplicate": os.write(4,b'{"schema_version":1,"sequence":1,"sequence":1,"status":"completed","observation":{"source":"participant_bot"}}\n'); raise SystemExit(0)
 if mode == "nonfinite": os.write(4,b'{"schema_version":1,"sequence":1,"status":"completed","observation":{"source":"participant_bot","n":1e999}}\n'); raise SystemExit(0)
 if mode == "huge": os.write(4,b"x"*20480); raise SystemExit(0)
 if mode == "deep": os.write(4,b'{"schema_version":1,"sequence":1,"status":"completed","observation":{"source":"participant_bot","x":'+b"["*1200+b"0"+b"]"*1200+b"}}\n"); raise SystemExit(0)
 reply={"schema_version":1,"sequence":request["sequence"],"status":"finished" if expected==2 else "completed"}
 if request["action"]["kind"] == "observe": reply["observation"]={"source":"participant_bot"}
 raw=(json.dumps(reply)+"\n").encode()
 if mode == "partial":
  for byte in raw: os.write(4,bytes([byte]))
 else: os.write(4,raw)
if mode == "trailing":
 time.sleep(.1)
 os.write(4,b"x")
'''


class CoordinatorTests(unittest.TestCase):
    def start(self, mode):
        descriptors = ActionDescriptors.create()
        process = subprocess.Popen([
            sys.executable, DESCRIPTOR_ADAPTER, "--adapter", str(descriptors.child_read), str(descriptors.child_write), "--",
            sys.executable, "-c", CHILD, mode,
        ], close_fds=True, pass_fds=(descriptors.child_read, descriptors.child_write))
        descriptors.close_child()
        return descriptors, process

    def cleanup(self, descriptors, process):
        descriptors.close_host()
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=2)

    def test_partial_replies_are_serialized_and_eof_audited(self):
        descriptors, process = self.start("partial")
        try:
            result = run_action_script(descriptors, [{"kind":"observe"}, {"kind":"finish"}], timeout=2)
            self.assertEqual(result["status"], "finished")
            self.assertEqual([record["request"]["sequence"] for record in result["records"]], [1, 2])
            self.assertTrue(all(type(record["started_monotonic"]) is float and type(record["finished_monotonic"]) is float for record in result["records"]))
            self.assertEqual(process.wait(timeout=2), 0)
            self.assertEqual(audit_action_eof(descriptors, timeout=1)["status"], "verified")
        finally:
            self.cleanup(descriptors, process)

    def test_malformed_reply_is_sticky_and_closes_host_endpoints(self):
        descriptors, process = self.start("malformed")
        try:
            result = run_action_script(descriptors, [{"kind":"observe"}, {"kind":"finish"}], timeout=2)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(descriptors.host_read, None)
            self.assertEqual(descriptors.host_write, None)
        finally:
            self.cleanup(descriptors, process)

    def test_duplicate_or_nonfinite_reply_is_rejected(self):
        for mode in ("duplicate", "nonfinite"):
            descriptors, process = self.start(mode)
            try:
                result = run_action_script(descriptors, [{"kind":"observe"}, {"kind":"finish"}], timeout=2)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["records"][0]["reply"], None)
            finally:
                self.cleanup(descriptors, process)

    def test_idle_huge_and_deep_replies_fail_under_the_shared_deadline(self):
        for mode, timeout in (("idle", .05), ("huge", 1), ("deep", 1)):
            descriptors, process = self.start(mode)
            try:
                self.assertEqual(run_action_script(descriptors, [{"kind":"observe"}, {"kind":"finish"}], timeout=timeout)["status"], "failed")
            finally:
                self.cleanup(descriptors, process)

    def test_audit_rejects_trailing_reply_bytes(self):
        descriptors, process = self.start("trailing")
        try:
            self.assertEqual(run_action_script(descriptors, [{"kind":"observe"}, {"kind":"finish"}], timeout=2)["status"], "finished")
            self.assertEqual(process.wait(timeout=2), 0)
            self.assertEqual(audit_action_eof(descriptors, timeout=1)["status"], "failed")
        finally:
            self.cleanup(descriptors, process)

    def test_stalled_write_is_bounded_without_a_reader_consuming_requests(self):
        descriptors=ActionDescriptors.create()
        try:
            os.set_blocking(descriptors.host_write,False)
            while True:
                try:os.write(descriptors.host_write,b'x'*4096)
                except BlockingIOError:break
            result=run_action_script(descriptors,[{'kind':'finish'}],timeout=.02)
            self.assertEqual(result['status'],'failed')
            self.assertEqual(result['records'][0]['reply'],None)
            self.assertIsNone(descriptors.host_write)
        finally:
            descriptors.close_child();descriptors.close_host()

    def test_finish_is_required_last(self):
        descriptors = ActionDescriptors.create()
        try:
            self.assertEqual(run_action_script(descriptors, [{"kind":"observe"}], timeout=1)["status"], "failed")
        finally:
            descriptors.close_child()
            descriptors.close_host()


if __name__ == "__main__":
    unittest.main()
