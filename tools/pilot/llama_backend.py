"""Owned, offline llama.cpp backend. Callers pin binaries/model and sandbox resources.

No shared Ollama service is contacted. Tokenization and completion use only the
owned UNIX socket. A failed request terminates the backend rather than assuming
that closing HTTP cancels GPU work. The caller supplies an absolute monotonic
deadline, full raw prompt (including framing), and a private socket directory.
"""
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import signal
import re
import threading
import socket
import stat
import subprocess
import sys
import time

from tools.pilot.ollama_adapter import _json

MAX_WIRE = 131072
MAX_PROMPT = 65536


def _deadline(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= time.monotonic():
        raise TimeoutError("deadline expired")


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def _http(path, endpoint, payload, timeout):
    connection = UnixHTTPConnection(path, timeout)
    try:
        raw = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
        if len(raw) > MAX_WIRE:
            raise ValueError("request too large")
        connection.request("POST", endpoint, body=raw,
                           headers={"Content-Type": "application/json", "Connection": "close"})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("HTTP status")
        body = response.read(MAX_WIRE + 1)
        if not body or len(body) > MAX_WIRE:
            raise ValueError("response too large")
        parsed = _json(body)
        if type(parsed) is not dict:
            raise ValueError("object required")
        return parsed
    finally:
        connection.close()


def _worker(path):
    try:
        request = _json(sys.stdin.buffer.read(MAX_WIRE + 1))
        if type(request) is not dict or set(request) != {"endpoint", "payload", "timeout"}:
            return 2
        if request["endpoint"] not in ("/tokenize", "/completion"):
            return 2
        timeout = request["timeout"]
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 20:
            return 2
        result = _http(path, request["endpoint"], request["payload"], timeout)
        raw = json.dumps(result, allow_nan=False, separators=(",", ":")).encode()
        if len(raw) > MAX_WIRE:
            return 2
        sys.stdout.buffer.write(raw)
        return 0
    except Exception:
        return 1


def _reap_group(process):
    """Terminate all members, reap leader, and verify that the process group is gone."""
    if process is None:
        return {"backend_reaped": True, "group_gone": True, "returncode": None,
                "term_sent": False, "kill_sent": False}
    term = kill = False
    try:
        os.killpg(process.pid, signal.SIGTERM)
        term = True
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
        kill = True
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    gone = False
    end = time.monotonic() + 1
    while time.monotonic() < end:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            gone = True
            break
        time.sleep(.02)
    return {"backend_reaped": process.returncode is not None, "group_gone": gone,
            "returncode": process.returncode, "term_sent": term, "kill_sent": kill}


class OwnedLlamaBackend:
    def __init__(self, runtime, model, socket_path, *, cancel=None, env=None, gpu_layers="all", require_gpu=False):
        self.runtime, self.model, self.socket_path = map(Path, (runtime, model, socket_path))
        self.cancel = cancel
        self.env = dict(env) if env is not None else {
            "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
            "LD_LIBRARY_PATH": "/usr/local/lib/ollama:/usr/local/lib/ollama/cuda_v13:/usr/lib/wsl/lib"}
        if gpu_layers not in ("all", "0"):
            raise ValueError("explicit all-GPU or CPU-only backend required")
        if type(require_gpu) is not bool:
            raise ValueError("require_gpu must be boolean")
        self.require_gpu = require_gpu
        self.gpu_layers = gpu_layers
        self.log = bytearray()
        self.log_truncated = False
        self.log_tail = bytearray()
        self.log_thread = None
        self._log_lock = threading.Lock()
        self._log_hash = hashlib.sha256()
        self._log_bytes = 0
        self._log_overlap = b""
        self._gpu_device_seen = False
        self._gpu_offload_seen = False
        self._gpu_offload_line = None
        self.process = None
        self.closed = False
        self.cleanup = None
        self.started = False
        self.http_worker_reaped = True

    def _capture_log(self, chunk):
        """Hash/drain everything; retain bounded head/tail and incremental evidence."""
        with self._log_lock:
            self._log_hash.update(chunk)
            self._log_bytes += len(chunk)
            room = 65536-len(self.log)
            if len(chunk) > room:
                self.log_truncated = True
            self.log.extend(chunk[:room])
            self.log_tail.extend(chunk)
            del self.log_tail[:-8192]
            combined = self._log_overlap + chunk
            self._gpu_device_seen |= b"CUDA0" in combined
            match = re.search(rb"offloaded [1-9][0-9]*/[0-9]+ layers to GPU", combined)
            if match:
                self._gpu_offload_seen = True
                self._gpu_offload_line = match.group().decode("ascii")
            # Covers split evidence phrases, independently of retained prefix/tail.
            self._log_overlap = combined[-512:]

    def _drain_log(self):
        try:
            while True:
                chunk = self.process.stdout.read(4096)
                if not chunk:
                    return
                self._capture_log(chunk)
        finally:
            self.process.stdout.close()

    def _log_receipt(self):
        with self._log_lock:
            return {"log_sha256": self._log_hash.copy().hexdigest(),
                    "log_bytes": self._log_bytes, "log_truncated": self.log_truncated,
                    "gpu_device_seen": self._gpu_device_seen,
                    "gpu_offload_evidence": self._gpu_offload_line,
                    "gpu_verified": self._gpu_device_seen and self._gpu_offload_seen}

    def _gpu_verified(self):
        return self._log_receipt()["gpu_verified"]

    def _guard(self, deadline):
        _deadline(deadline)
        if self.cancel is not None and self.cancel.is_set():
            raise InterruptedError("cancelled")
        if self.closed:
            raise ValueError("backend closed")

    def start(self, deadline):
        self._guard(deadline)
        if self.process is not None:
            raise ValueError("backend already started")
        for path in (self.runtime, self.model):
            if not path.is_absolute() or not path.is_file():
                raise ValueError("absolute existing runtime/model required")
        parent = self.socket_path.parent
        if (not self.socket_path.is_absolute() or len(os.fsencode(self.socket_path)) > 100
                or self.socket_path.suffix != ".sock" or self.socket_path.exists()
                or parent.resolve() != parent or not parent.is_dir()
                or stat.S_IMODE(parent.stat().st_mode) & 0o077):
            raise ValueError("new socket in private canonical directory required")
        argv = [str(self.runtime), "--model", str(self.model),
                "--host", str(self.socket_path), "--offline", "--no-agent", "--no-webui",
                "--ctx-size", "8448", "--n-predict", "256", "--parallel", "1",
                "--threads", "2", "--threads-batch", "2", "--threads-http", "2",
                "--gpu-layers", self.gpu_layers, "--timeout", "20", "--no-cache-prompt",
                "--verbosity", "5"]
        started = time.monotonic()
        try:
            self.process = subprocess.Popen(argv, env=self.env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, close_fds=True,
                bufsize=0, start_new_session=True)
            self.log_thread = threading.Thread(target=self._drain_log, daemon=True)
            self.log_thread.start()
            gpu_proof_deadline = None
            while True:
                self._guard(deadline)
                if self.process.poll() is not None:
                    raise RuntimeError("backend exited during startup")
                if self.socket_path.exists():
                    connection = UnixHTTPConnection(str(self.socket_path), min(.2, deadline-time.monotonic()))
                    try:
                        connection.request("GET", "/health")
                        response = connection.getresponse()
                        body = response.read(4097)
                        if response.status == 200 and len(body) <= 4096:
                            health = _json(body)
                            if type(health) is dict and health.get("status") == "ok":
                                self._guard(deadline)
                                if self.require_gpu and not self._gpu_verified():
                                    if gpu_proof_deadline is None:
                                        gpu_proof_deadline = min(deadline, time.monotonic()+.5)
                                    if time.monotonic() < gpu_proof_deadline:
                                        time.sleep(.01)
                                        continue
                                    raise RuntimeError("GPU offload not verified")
                                self.started = True
                                return {"status": "ready", "startup_seconds": time.monotonic()-started,
                                        "pid": self.process.pid, **self._log_receipt()}
                    except (OSError, ValueError, http.client.HTTPException):
                        pass
                    finally:
                        connection.close()
                time.sleep(min(.05, max(0, deadline-time.monotonic())))
        except Exception:
            self.close()
            raise

    def _request(self, endpoint, payload, deadline):
        self._guard(deadline)
        if not self.started or self.process.poll() is not None:
            raise RuntimeError("backend unavailable")
        timeout = min(20, deadline-time.monotonic())
        wire = json.dumps({"endpoint": endpoint, "payload": payload, "timeout": timeout},
                          allow_nan=False, separators=(",", ":")).encode()
        if len(wire) > MAX_WIRE:
            raise ValueError("request too large")
        worker = subprocess.Popen([sys.executable, "-m", "tools.pilot.llama_backend",
            "--worker", str(self.socket_path)], cwd=Path(__file__).resolve().parents[2],
            env={"PATH": os.defpath, "LANG": "C.UTF-8"},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            close_fds=True, start_new_session=True)
        self.http_worker_reaped = False
        first = True
        try:
            while True:
                self._guard(deadline)
                try:
                    output, _ = worker.communicate(input=wire if first else None,
                        timeout=min(.05, deadline-time.monotonic()))
                    self._guard(deadline)
                    if worker.returncode != 0 or not output or len(output) > MAX_WIRE:
                        raise ValueError("backend HTTP failed")
                    result = _json(output)
                    if type(result) is not dict:
                        raise ValueError("backend object required")
                    return result
                except subprocess.TimeoutExpired:
                    first = False
        finally:
            if worker.poll() is None:
                worker.kill()
            worker.communicate(timeout=2)
            self.http_worker_reaped = worker.returncode is not None

    def complete(self, prompt, deadline, output_limit=256):
        started = time.monotonic()
        result = {"schema_version": 1, "status": "failed", "worker_reaped": True,
                  "input_tokens": None, "output_tokens": None, "reserved_output_tokens": output_limit}
        try:
            self._guard(deadline)
            deadline = min(deadline, started + 20)
            if type(prompt) is not str or not prompt or len(prompt.encode()) > MAX_PROMPT:
                raise ValueError("bounded raw prompt required")
            if type(output_limit) is not int or not 1 <= output_limit <= 256:
                raise ValueError("output limit")
            result["prompt_sha256"] = hashlib.sha256(prompt.encode()).hexdigest()
            tokenized = self._request("/tokenize", {"content": prompt, "add_special": False,
                                                    "parse_special": True}, deadline)
            tokens = tokenized.get("tokens")
            if (type(tokens) is not list or not 1 <= len(tokens) <= 8192
                    or any(type(x) is not int or x < 0 or x >= 2**31 for x in tokens)):
                raise ValueError("bounded token IDs required")
            result["input_tokens"] = len(tokens)
            data = self._request("/completion", {"prompt": tokens, "n_predict": output_limit,
                "stream": False, "temperature": 0, "seed": 0, "cache_prompt": False,
                "json_schema": {"type": "object"}}, deadline)
            content = data.get("content")
            count, evaluated = data.get("tokens_predicted"), data.get("tokens_evaluated")
            if (data.get("stop") is not True or data.get("truncated") is not False
                    or data.get("stop_type") not in ("eos", "word") or type(count) is not int or not 0 < count <= output_limit
                    or type(evaluated) is not int or evaluated != len(tokens)
                    or type(content) is not str or not content or len(content.encode()) > 4096
                    or type(_json(content.encode())) is not dict):
                raise ValueError("invalid completion receipt")
            self._guard(deadline)
            result.update(status="completed", content=content, output_tokens=count,
                          stop_type=data["stop_type"], truncated=data["truncated"],
                          tokens_evaluated=evaluated)
        except InterruptedError:
            result["status"] = "cancelled"
            result["cleanup"] = self.close()
        except TimeoutError:
            result["status"] = "timeout"
            result["cleanup"] = self.close()
        except Exception:
            result["cleanup"] = self.close()
        result["worker_reaped"] = self.http_worker_reaped
        if not self.http_worker_reaped:
            result["status"] = "cleanup_uncertain"
            result.pop("content", None)
        result["elapsed_seconds"] = time.monotonic()-started
        return result

    def close(self):
        if self.cleanup is not None:
            return self.cleanup
        self.closed = True
        self.cleanup = _reap_group(self.process)
        if self.log_thread is not None:
            self.log_thread.join(2)
        self.cleanup["log_reader_stopped"] = self.log_thread is None or not self.log_thread.is_alive()
        self.cleanup["process_group_gone"] = self.cleanup["group_gone"]
        self.cleanup.update(self._log_receipt())
        self.cleanup["status"] = ("closed" if self.cleanup["backend_reaped"] and
                                  self.cleanup["group_gone"] and self.cleanup["log_reader_stopped"]
                                  else "cleanup_uncertain")
        return self.cleanup


if __name__ == "__main__":
    raise SystemExit(_worker(sys.argv[2]) if len(sys.argv) == 3 and sys.argv[1] == "--worker" else 2)
