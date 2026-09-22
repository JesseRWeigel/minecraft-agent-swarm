"""Fresh-world generation worker, run only inside the generator sandbox."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import time


def main():
    if os.readlink("/proc/self/ns/net") == Path("/fixture-code/host-netns").read_text():
        raise RuntimeError("private network required")
    result = {"ready": False, "stop_sent": False, "forced_cleanup": False, "returncode": None}
    child = None
    selector = selectors.DefaultSelector()
    tail = bytearray()
    total = 0
    try:
        child = subprocess.Popen(["/usr/bin/java", "-Xms512M", "-Xmx2G", "-Djava.awt.headless=true",
            "-jar", "server.jar", "--nogui"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, close_fds=True, env={"PATH":"/usr/bin:/bin", "LANG":"C.UTF-8"})
        os.set_blocking(child.stdout.fileno(), False)
        selector.register(child.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + 120
        with open("generation.log", "xb") as log:
            os.chmod("generation.log", 0o600)
            while selector.get_map() or child.poll() is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError("generation deadline")
                for key, _ in selector.select(.05):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > 1024*1024:
                        raise ValueError("generation log limit")
                    log.write(chunk)
                    tail.extend(chunk); tail[:] = tail[-8192:]
                    if not result["ready"] and b"Done (" in tail and b'For help, type "help"' in tail:
                        result["ready"] = True
                        child.stdin.write(b"save-all flush\nstop\n"); child.stdin.flush()
                        result["stop_sent"] = True
                        deadline = time.monotonic() + 30
        result["returncode"] = child.wait(timeout=1)
    except Exception:
        result["error"] = "generation_failed"
    finally:
        if child is not None:
            if child.poll() is None:
                result["forced_cleanup"] = True
                child.kill(); child.wait(timeout=5)
            result["returncode"] = child.returncode
            child.stdin.close(); child.stdout.close()
        selector.close()
        fd=os.open("generation-result.json",os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,"w") as f:json.dump(result,f)
    return 0 if result["ready"] and result["stop_sent"] and not result["forced_cleanup"] and result["returncode"]==0 and not result.get("error") else 1


if __name__ == "__main__":
    raise SystemExit(main())
