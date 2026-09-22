"""Trusted fixed RCON fault proxy; only launched inside the private trial network."""
import select
import socket
import struct
import threading
import time

LISTEN = ("127.0.0.1", 25596)
UPSTREAM = ("127.0.0.1", 25595)
COMMANDS = (b"data get entity PilotProbe Pos", b"data get entity PilotProbe Dimension")


def read_frame(sock, stop, deadline):
    def receive(count):
        data = bytearray()
        while len(data) < count:
            remaining = deadline - time.monotonic()
            if stop.is_set() or remaining <= 0:
                raise TimeoutError("RCON fault deadline")
            if not select.select([sock], [], [], min(.05, remaining))[0]:
                continue
            chunk = sock.recv(count - len(data))
            if not chunk:
                raise ValueError("RCON fault EOF")
            data.extend(chunk)
        return bytes(data)
    header = receive(4)
    size = struct.unpack("<i", header)[0]
    if not 10 <= size <= 4096:
        raise ValueError("RCON fault frame size")
    body = receive(size)
    if body[-2:] != b"\0\0":
        raise ValueError("RCON fault terminator")
    return header + body


class RconStall:
    def __init__(self):
        self.stop = threading.Event()
        self.result = {"status": "waiting", "authenticated": False, "forwarded_queries": [],
                       "withheld_reply": False}
        self.listener = socket.socket()
        try:
            self.listener.bind(LISTEN)
            self.listener.listen(1)
            self.listener.settimeout(.1)
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
        except Exception:
            self.listener.close()
            raise

    def _run(self):
        deadline = time.monotonic() + 15
        try:
            while not self.stop.is_set() and time.monotonic() < deadline:
                try:
                    client, _ = self.listener.accept()
                    break
                except socket.timeout:
                    continue
            else:
                raise TimeoutError("no observer")
            self.listener.close()
            with client, socket.create_connection(UPSTREAM, timeout=2) as upstream:
                client.settimeout(2)
                auth = read_frame(client, self.stop, deadline)
                auth_id, kind = struct.unpack("<ii", auth[4:12])
                if kind != 3:
                    raise ValueError("expected authentication")
                upstream.sendall(auth)
                for _ in range(2):
                    response = read_frame(upstream, self.stop, deadline)
                    reply_id, reply_kind = struct.unpack("<ii", response[4:12])
                    client.sendall(response)
                    if reply_kind == 2:
                        if reply_id != auth_id:
                            raise ValueError("authentication rejected")
                        self.result["authenticated"] = True
                        break
                if not self.result["authenticated"]:
                    raise ValueError("missing auth response")
                for index, command in enumerate(COMMANDS):
                    request = read_frame(client, self.stop, deadline)
                    request_id, kind = struct.unpack("<ii", request[4:12])
                    if kind != 2 or request[12:-2] != command:
                        raise ValueError("unexpected query")
                    upstream.sendall(request)
                    response = read_frame(upstream, self.stop, deadline)
                    if struct.unpack("<ii", response[4:12]) != (request_id, 0):
                        raise ValueError("unexpected reply")
                    self.result["forwarded_queries"].append(command.decode())
                    if index == 0:
                        client.sendall(response)
                    else:
                        self.result.update(status="reply_withheld", withheld_reply=True,
                                           withheld_response_bytes=len(response), withheld_monotonic=time.monotonic())
                        while not self.stop.is_set() and time.monotonic() < deadline:
                            if select.select([client], [], [], .05)[0]:
                                if client.recv(1):
                                    raise ValueError("unexpected later query")
                                self.result["observer_closed"] = True
                                return
                        if not self.stop.is_set():
                            raise TimeoutError("fault proxy deadline")
        except Exception:
            self.result["status"] = "failed"
        finally:
            self.listener.close()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=3)
        self.result["cleanup_confirmed"] = not self.thread.is_alive()
        return dict(self.result)
