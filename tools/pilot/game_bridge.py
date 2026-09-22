"""Bounded byte relay with one fixed game endpoint; no forwarding protocol."""
import os
import select
import socket
import threading
import time

GAME_ENDPOINT = ("127.0.0.1", 25585)
BUFFER_LIMIT = 65536


def pump(left, right, stop, *, timeout=180):
    peers = {left: right, right: left}
    buffers = {left: bytearray(), right: bytearray()}
    eof = {left: False, right: False}
    shut = {left: False, right: False}
    counts = {"left_to_right": 0, "right_to_left": 0}
    deadline = time.monotonic() + timeout
    operation="setup";side=None
    try:
        for stream in peers:
            stream.setblocking(False)
        while True:
            if stop.is_set():
                return {"status": "stopped", **counts}
            if time.monotonic() >= deadline:
                operation="deadline";side=None
                raise TimeoutError("bridge deadline")
            for stream in peers:
                if eof[peers[stream]] and not buffers[stream] and not shut[stream]:
                    operation="half_close";side="left" if stream is left else "right"
                    stream.shutdown(socket.SHUT_WR)
                    shut[stream] = True
            if all(eof.values()) and not any(buffers.values()):
                return {"status": "completed", **counts}
            readable = [s for s in peers if not eof[s] and len(buffers[peers[s]]) < BUFFER_LIMIT]
            writable = [s for s in peers if buffers[s]]
            operation="select";side=None
            ready_read, ready_write, _ = select.select(readable, writable, [], min(0.1, max(0, deadline-time.monotonic())))
            for stream in ready_read:
                try:
                    operation="read";side="left" if stream is left else "right"
                    data = stream.recv(min(16384, BUFFER_LIMIT-len(buffers[peers[stream]])))
                except BlockingIOError:
                    continue
                if data:
                    buffers[peers[stream]].extend(data)
                else:
                    eof[stream] = True
            for stream in ready_write:
                try:
                    operation="write";side="left" if stream is left else "right"
                    sent = stream.send(buffers[stream])
                except BlockingIOError:
                    continue
                if sent <= 0:
                    raise OSError("bridge write failed")
                del buffers[stream][:sent]
                counts["left_to_right" if stream is right else "right_to_left"] += sent
    except Exception as error:
        error.bridge_diagnostics={"operation":operation,"side":side,
            "error_type":type(error).__name__[:64],"errno":getattr(error,"errno",None),
            "pending_left":len(buffers[left]),"pending_right":len(buffers[right]),
            "eof_left":eof[left],"eof_right":eof[right],**counts}
        raise


class GameBridge:
    """Outer-side single-use Unix listener. Only GAME_ENDPOINT is reachable."""
    def __init__(self, directory):
        directory.mkdir(mode=0o700)  # no reuse, unlink or overwrite
        self.path = directory / "game.sock"
        self.stop = threading.Event()
        self.result = {"status": "waiting", "connections": 0}
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        # Linux sockaddr_un paths are short; resolve the new private directory
        # through its owned descriptor without changing process-wide cwd.
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self.listener.bind(f"/proc/self/fd/{directory_fd}/game.sock")
        except Exception:
            self.listener.close()
            raise
        finally:
            os.close(directory_fd)
        self.path.chmod(0o600)
        self.listener.listen(1)
        self.listener.settimeout(0.1)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        stage="accept"
        try:
            deadline = time.monotonic()+180
            while not self.stop.is_set():
                if time.monotonic() >= deadline:
                    raise TimeoutError("bridge accept deadline")
                try:
                    client, _ = self.listener.accept()
                    break
                except socket.timeout:
                    continue
            else:
                self.result["status"] = "stopped"
                return
            self.listener.close()  # no second connection or reconnect
            self.result["connections"] = 1
            from tools.pilot.login_identity import admit_login
            with client:
                stage="login"
                prefix, identity = admit_login(client, self.stop)
                self.result["identity"] = identity
                stage="connect"
                with socket.create_connection(GAME_ENDPOINT, timeout=2) as game:
                    stage="login_forward"
                    game.sendall(prefix)
                    stage="relay"
                    self.result.update(pump(client, game, self.stop))
                    self.result["left_to_right"] += len(prefix)
        except Exception as error:
            self.result.update(status="failed", failure_stage=stage,
                error_type=type(error).__name__[:64],errno=getattr(error,"errno",None),
                relay_diagnostics=getattr(error,"bridge_diagnostics",None))
        finally:
            self.listener.close()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            self.result["status"] = "cleanup_uncertain"
        return dict(self.result)
