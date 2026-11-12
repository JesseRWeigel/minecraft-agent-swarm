"""Fake backend + real Node broker; no GPU or real model calls."""
import copy
import json
import time
import unittest
from tools.pilot import test_model_coordinator as harness
from tools.pilot.action_coordinator import audit_action_eof
from tools.pilot.real_model_driver import run_real_model, real_model_receipt_valid, prompt_for, action_valid, response_valid


class Backend:
    def __init__(self, actions, delay=0, **updates):
        self.actions, self.delay, self.updates, self.calls = actions, delay, updates, []
    def complete(self, prompt, deadline, output_limit=256):
        self.calls.append((prompt,deadline,output_limit))
        time.sleep(self.delay)
        action=self.actions[min(len(self.calls)-1,len(self.actions)-1)]
        result=dict(schema_version=1,status="completed",content=json.dumps(action),input_tokens=100,
                    tokens_evaluated=100,stop_type="eos",truncated=False,reserved_output_tokens=output_limit,
                    output_tokens=10,elapsed_seconds=0,worker_reaped=True)
        result.update(self.updates)
        return result


@unittest.skipUnless(harness.NODE, "Node required")
class RealModelDriverTests(unittest.TestCase):
    setUp = harness.ModelLoopTests.setUp
    tearDown = harness.ModelLoopTests.tearDown

    def test_unprescribed_sequence_valid_and_eof(self):
        b=Backend([{"kind":"look_at","x":2,"y":200,"z":-1},{"kind":"observe"},{"kind":"finish"}])
        result=run_real_model(self.d,b,3)
        self.assertEqual(result["status"],"finished",result)
        self.assertTrue(real_model_receipt_valid(result),result)
        self.transport.wait_action_finished();self.transport.send_finalize();self.transport.wait_exit()
        self.assertEqual(audit_action_eof(self.d)["status"],"verified")
        self.assertEqual(len(b.calls),3)
        self.assertTrue(b.calls[0][0].startswith("<|begin_of_text|>"))
        self.assertIn("participant_bot", b.calls[0][0])
        self.assertEqual(b.calls[0][2],256)

    def test_recoverable_missing_dig_is_bound_and_next_prompt_includes_error(self):
        backend=Backend([{"kind":"dig","x":0,"y":200,"z":3},{"kind":"finish"}])
        result=run_real_model(self.d,backend,3)
        self.assertEqual(result["status"],"finished",result)
        self.assertTrue(real_model_receipt_valid(result),result)
        self.assertEqual(result["records"][1]["reply"]["status"],"rejected")
        self.assertIn("target_missing",backend.calls[1][0])
        changed=copy.deepcopy(result)
        changed["records"][1]["reply"]["error"]["code"]="unknown"
        self.assertFalse(real_model_receipt_valid(changed))
        changed=copy.deepcopy(result)
        changed["records"][2]["reply"]={"schema_version":1,"sequence":3,"status":"rejected",
                                      "error":{"code":"target_missing","recoverable":True}}
        self.assertFalse(real_model_receipt_valid(changed))

    def test_receipt_tampering(self):
        result=run_real_model(self.d,Backend([{"kind":"finish"}]),3)
        self.assertTrue(real_model_receipt_valid(result))
        for key,value in [("input_tokens",True),("output_tokens",257),("elapsed_seconds",float("nan")),
                          ("worker_reaped",False),("schema_version",True),("tokens_evaluated",99),
                          ("stop_type","limit"),("truncated",True),("reserved_output_tokens",32),("content",'{"kind":"observe"}')]:
            obj=copy.deepcopy(result);obj["real_model"]["calls"][0]["response"][key]=value
            self.assertFalse(real_model_receipt_valid(obj),key)
        for key,value in [("prompt","changed"),("output_limit",True),("started_monotonic",-1)]:
            obj=copy.deepcopy(result);obj["real_model"]["calls"][0][key]=value
            self.assertFalse(real_model_receipt_valid(obj),key)
        obj=copy.deepcopy(result);obj["records"][1]["request"]["sequence"]=True
        self.assertFalse(real_model_receipt_valid(obj))
        obj=copy.deepcopy(result);obj["real_model"]["finished_monotonic"]=obj["real_model"]["deadline_monotonic"]+1
        self.assertFalse(real_model_receipt_valid(obj))

    def test_late_result_not_dispatched(self):
        b=Backend([{"kind":"finish"}],delay=.12)
        result=run_real_model(self.d,b,.06)
        self.assertEqual(result["status"],"timeout")
        self.assertEqual(len(result["records"]),1)
        self.assertIsNone(self.d.host_write)

    def test_failed_backend_not_dispatched(self):
        result=run_real_model(self.d,Backend([{"kind":"finish"}],worker_reaped=False),3)
        self.assertEqual(result["status"],"failed")
        self.assertEqual(len(result["records"]),1)

    def test_invalid_action_not_dispatched(self):
        result=run_real_model(self.d,Backend([{"kind":"run_shell","command":"no"}]),3)
        self.assertEqual(result["status"],"failed")
        self.assertEqual(len(result["records"]),1)

    def test_eight_call_limit_requires_finish(self):
        b=Backend([{"kind":"observe"}])
        result=run_real_model(self.d,b,3)
        self.assertEqual(result["status"],"budget_exhausted")
        self.assertEqual(len(b.calls),8)
        self.assertEqual(len(result["records"]),9)

    def test_qwen_prompt_and_receipt_format_binding(self):
        backend=Backend([{"kind":"observe"},{"kind":"finish"}])
        result=run_real_model(self.d,backend,3,prompt_format="qwen-chatml-v1")
        self.assertEqual(result["status"],"finished")
        self.assertTrue(real_model_receipt_valid(result,"qwen-chatml-v1"))
        self.assertFalse(real_model_receipt_valid(result,"llama3-v1"))
        prompt=backend.calls[0][0]
        self.assertTrue(prompt.startswith("<|im_start|>system\n"))
        self.assertTrue(prompt.endswith("<|im_start|>assistant\n<think>\n\n</think>\n\n"))
        self.assertNotIn("started_monotonic",prompt)
        self.assertNotIn("finished_monotonic",prompt)
        changed=copy.deepcopy(result);changed["real_model"]["prompt_format"]="llama3-v1"
        self.assertFalse(real_model_receipt_valid(changed))
        changed=copy.deepcopy(result);del changed["real_model"]["prompt_format"]
        self.assertFalse(real_model_receipt_valid(changed))

    def test_preserve_failed_channel_never_invents_finish(self):
        backend=Backend([{"kind":"observe"}])
        result=run_real_model(self.d,backend,3,preserve_failed_channel=True)
        self.assertEqual(result["status"],"budget_exhausted")
        self.assertIsNotNone(self.d.host_write)
        self.assertIsNotNone(self.d.host_read)
        self.assertEqual(len(backend.calls),8)
        self.assertTrue(all(row["request"]["action"]["kind"]=="observe" for row in result["records"]))

    def test_unsupported_format_has_no_actions(self):
        backend=Backend([{"kind":"finish"}])
        result=run_real_model(self.d,backend,3,prompt_format="unknown")
        self.assertEqual(result["status"],"failed")
        self.assertFalse(result["records"])
        self.assertFalse(backend.calls)

    def test_invalid_allowance_does_nothing(self):
        b=Backend([{"kind":"finish"}])
        result=run_real_model(self.d,b,0)
        self.assertEqual(result["status"],"failed")
        self.assertFalse(b.calls)
        self.assertFalse(result["records"])


class SchemaTests(unittest.TestCase):
    def test_malformed_receipts(self):
        for value in (None,{},[],True,{"schema_version":True}):
            self.assertFalse(real_model_receipt_valid(value))
    def test_action_schema(self):
        for action in ({"kind":"move","direction":"up","ticks":1},
                       {"kind":"move","direction":"forward","ticks":True},
                       {"kind":"look","yaw":float("nan"),"pitch":0},
                       {"kind":"dig","x":0,"y":320,"z":3},
                       {"kind":"finish","extra":1},
                       {"kind":"look_at","x":True,"y":200,"z":3},
                       {"kind":"look_at","x":0,"y":320,"z":3}):
            self.assertFalse(action_valid(action))
        for action in ({"kind":"finish"},{"kind":"look","yaw":0,"pitch":0},
                       {"kind":"move","direction":"back","ticks":20},
                       {"kind":"look_at","x":0,"y":200,"z":3}):
            self.assertTrue(action_valid(action))


if __name__ == "__main__":
    unittest.main()
