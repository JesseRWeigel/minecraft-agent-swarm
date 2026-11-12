"""Pin the existing local runtime/model without downloads or account changes."""
import hashlib
import json
import os
import stat
import pwd
import shutil
from pathlib import Path

RUNTIME_ROOT = Path("/usr/local/lib/ollama")
MODEL = Path("/usr/share/ollama/.ollama/models/blobs/sha256-dde5aa3fc5ffc17176b5e8bdc82f587b24b2678c6c66101bf7da77af9f7ccdff")
MODEL_SHA256 = "dde5aa3fc5ffc17176b5e8bdc82f587b24b2678c6c66101bf7da77af9f7ccdff"
ENV = {"PATH":"/usr/bin:/bin", "LANG":"C.UTF-8",
       "LD_LIBRARY_PATH":"/usr/local/lib/ollama:/usr/local/lib/ollama/cuda_v13:/usr/lib/wsl/lib",
       "GGML_BACKEND_PATH":"/usr/local/lib/ollama/cuda_v13/libggml-cuda.so"}


def _hash_file(path, *, service_model=False):
    original = path
    path = path.resolve(strict=True)
    info = path.stat()
    owners={0,pwd.getpwnam("ollama").pw_uid} if service_model else {0}
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o022 or info.st_size > (8 if service_model else 4)*1024**3:
        raise ValueError("unprotected runtime/model file")
    for parent in path.parents:
        p = parent.stat()
        if p.st_uid not in owners or p.st_mode & 0o022:
            raise ValueError("unprotected ancestor")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""):
            digest.update(chunk)
    return {"path":str(original),"resolved":str(path),"bytes":info.st_size,"sha256":digest.hexdigest()}


def pin_local_model(model_id="llama3.2:3b"):
    """Explicitly pin this machine's installed candidate; never downloads a model."""
    candidates={
        "llama3.2:3b":(MODEL,MODEL_SHA256,"llama3-v1","Llama 3.2 3B Q4_K_M"),
        "qwen3.5:9b":(Path("/usr/share/ollama/.ollama/models/blobs/sha256-dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c"),
            "dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c","qwen-chatml-v1","Qwen 3.5 9B")}
    if model_id not in candidates:raise ValueError("unsupported local candidate")
    model_path,model_hash,prompt_format,label=candidates[model_id]
    paths = [RUNTIME_ROOT/"llama-server"]
    paths += sorted(RUNTIME_ROOT.glob("*.so*"))
    paths += sorted((RUNTIME_ROOT/"cuda_v13").glob("*.so*"))
    # Include symlink names as well as canonical targets for loader reproducibility.
    cache = {}
    records = []
    for path in paths:
        canonical = str(path.resolve(strict=True))
        if canonical not in cache:
            cache[canonical] = _hash_file(path)
        records.append({**cache[canonical], "path":str(path)})
    model = _hash_file(model_path,service_model=True)
    if model["sha256"] != model_hash:
        raise ValueError("candidate model hash mismatch")
    payload = {"schema_version":1,"model":model,"runtime_files":records,
               "runtime":str(RUNTIME_ROOT/"llama-server"),"environment":ENV,
               "prompt_format":prompt_format,"model_label":label,"model_id":model_id}
    payload["sha256"] = hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    return payload


def verify_config(config):
    if not isinstance(config,dict):raise ValueError("invalid local model configuration")
    if json.dumps(config,sort_keys=True,allow_nan=False) != json.dumps(pin_local_model(config.get("model_id","llama3.2:3b")),sort_keys=True,allow_nan=False):
        raise ValueError("local model/runtime configuration changed")
    return config


def backend_cleanup_valid(value, *, require_gpu=True):
    return isinstance(value,dict) and value.get("status") == "closed" and value.get("backend_reaped") is True and value.get("process_group_gone") is True and value.get("log_reader_stopped") is True and (not require_gpu or value.get("gpu_verified") is True)

def capture_model(config, destination):
    """Exclusive verified snapshot; launch mounts this file read-only, not mutable service storage."""
    source=Path(config["model"]["path"])
    expected=config["model"]
    digest=hashlib.sha256()
    count=0
    fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
    with os.fdopen(fd,"wb") as output, source.open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""):
            count+=len(chunk)
            if count>expected["bytes"]:raise ValueError("model snapshot grew")
            digest.update(chunk);output.write(chunk)
        output.flush();os.fsync(output.fileno())
    if count!=expected["bytes"] or digest.hexdigest()!=expected["sha256"]:
        raise ValueError("model snapshot mismatch")
    return {"bytes":count,"sha256":digest.hexdigest()}

def preflight_model_space(directory, config, storage_capacity_bytes):
    from tools.pilot.bounded_storage import HOST_FREE_RESERVE_BYTES
    needed=HOST_FREE_RESERVE_BYTES + storage_capacity_bytes + config["model"]["bytes"] + 16*1024**2
    if shutil.disk_usage(directory).free < needed:
        raise ValueError("insufficient reserve for model snapshot plus game storage")
