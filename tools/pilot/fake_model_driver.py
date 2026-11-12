"""Explicit synthetic provider for protected game plumbing, never a real model."""
import json
import math
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from tools.pilot.model_coordinator import run_model_actions
from tools.pilot.oak_script import scripted_actions, script_receipt_valid

MODEL = "synthetic-oak-fixture:1"


def fake_model_receipt_valid(value, mode):
    try:
        if not script_receipt_valid(value, mode):
            return False
        run = value["synthetic_model"]
        if not isinstance(run, dict) or type(run.get("schema_version")) is not int or run["schema_version"] != 1:
            return False
        if run.get("status") != "finished" or json.dumps(run.get("actions"), sort_keys=True, allow_nan=False) != json.dumps(value["records"], sort_keys=True, allow_nan=False):
            return False
        calls = run["calls"]
        expected = scripted_actions(mode)[1:]
        if not isinstance(calls, list) or not isinstance(run["budget"], list) or len(calls) != len(expected) or len(run["budget"]) != len(expected):
            return False
        total_elapsed = 0
        for sequence, (call, action, row) in enumerate(zip(calls, expected, run["budget"]), 1):
            if not isinstance(call, dict) or not isinstance(row, dict):
                return False
            response = call["response"]
            if not isinstance(response, dict):
                return False
            constants = {"sequence": sequence, "input_tokens": 10, "reserved_output_tokens": 256, "actual_output_tokens": 7, "charged_output_tokens": 7}
            if set(row) != set(constants) | {"usage_known", "elapsed_seconds", "outcome"}:
                return False
            if any(type(row[k]) is not int or row[k] != v for k,v in constants.items()):
                return False
            if row["usage_known"] is not True or row["outcome"] != "completed":
                return False
            for key, count in (("provider_input_tokens",10), ("provider_output_tokens",7)):
                if type(response.get(key)) is not int or response[key] != count:
                    return False
            elapsed, limit = row["elapsed_seconds"], response.get("effective_timeout_seconds")
            if any(type(x) not in (int,float) or not math.isfinite(x) for x in (elapsed,limit)):
                return False
            if not 0 <= elapsed <= limit <= 20:
                return False
            total_elapsed += elapsed
            if (call["messages"] != [{"role": "user", "content": "next synthetic fixture action"}]
                    or type(call["input_tokens"]) is not int or call["input_tokens"] != 10
                    or type(response.get("schema_version")) is not int or response["schema_version"] != 1
                    or response.get("status") != "completed"
                    or response.get("worker_reaped") is not True
                    or type(response.get("worker_returncode")) is not int or response["worker_returncode"] != 0
                    or json.dumps(json.loads(response["content"]), sort_keys=True, allow_nan=False) != json.dumps(action, sort_keys=True, allow_nan=False)):
                return False
        if total_elapsed > value["records"][-1]["finished_monotonic"] - value["records"][0]["started_monotonic"]:
            return False
        return value.get("provider") == MODEL and value.get("provider_stopped") is True
    except (KeyError, TypeError, ValueError, OverflowError, RecursionError):
        return False


def run_fake_model(descriptors, mode, allowance):
    """Private-namespace HTTP fixture; fixed sequence, no inference or token claims."""
    actions = scripted_actions(mode)[1:]
    index = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            nonlocal index
            self.connection.settimeout(2)
            length = int(self.headers.get("Content-Length", "0"))
            if self.path != "/api/chat" or not 0 < length <= 65536 or index >= len(actions):
                self.send_error(400)
                return
            request = json.loads(self.rfile.read(length))
            if request.get("model") != MODEL:
                self.send_error(400)
                return
            action = actions[index]
            index += 1
            raw = json.dumps({"model": MODEL, "done": True, "done_reason": "stop",
                "message": {"role": "assistant", "content": json.dumps(action)},
                "prompt_eval_count": 10, "eval_count": 7}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .05}, daemon=True)
    thread.start()
    try:
        run = run_model_actions(descriptors, port=server.server_port, model=MODEL,
            build_prompt=lambda records: [{"role": "user", "content": "next synthetic fixture action"}],
            count_tokens=lambda messages: 10, timeout=allowance)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)
    return {"schema_version": 1, "status": run["status"], "error": None,
            "records": run["actions"], "provider": MODEL,
            "provider_stopped": not thread.is_alive(), "synthetic_model": run}
