"""Fixed in-namespace Java/qualification supervisor. No arbitrary commands."""
import os, socket, subprocess, sys, time
from pathlib import Path

def wait_port(port, deadline):
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.25): return
        except OSError: time.sleep(.25)
    raise TimeoutError(f"loopback port {port} unavailable")

def main():
    if len(sys.argv)!=2: raise SystemExit("evidence path required")
    evidence=Path(sys.argv[1]); root=Path.cwd(); secret=(root/".qualification-rcon-password").read_text().strip()
    if not secret: raise SystemExit("missing private RCON credential")
    env={"HOME":str(root),"LANG":"C.UTF-8","PATH":"/usr/bin:/bin"}
    server=subprocess.Popen(["/usr/bin/java","-Xms1G","-Xmx2G","-Djava.awt.headless=true","-jar","server.jar","--nogui"],stdin=subprocess.PIPE,stdout=sys.stdout,stderr=sys.stderr,env=env)
    client=None
    try:
        deadline=time.monotonic()+60
        wait_port(25585,deadline);wait_port(25595,deadline)
        client_env={**env,"PILOT_RCON_PASSWORD":secret}
        client=subprocess.run(["/pilot-tools/bin/node","/pilot-tools/qualification-client.mjs","--output",str(evidence)],env=client_env,timeout=90,check=False)
        return client.returncode
    finally:
        if server.poll() is None:
            try: server.stdin.write(b"stop\n");server.stdin.flush();server.wait(timeout=15)
            except Exception:
                server.terminate()
                try: server.wait(timeout=5)
                except subprocess.TimeoutExpired: server.kill();server.wait()
if __name__=="__main__": raise SystemExit(main())