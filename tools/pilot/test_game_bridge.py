from pathlib import Path
import tempfile
import socket
import threading
import time
import unittest
from unittest.mock import patch
from tools.pilot.game_bridge import pump, GameBridge
from tools.pilot.login_identity import OFFLINE_UUID

def _varint(n):
    out=b""
    while True:
        b=n&127; n>>=7; out+=bytes([b|(128 if n else 0)])
        if not n:return out
def _login(name="PilotProbe", player=OFFLINE_UUID):
    import uuid
    host=b"127.0.0.1"; h=_varint(0)+_varint(769)+_varint(len(host))+host+(25585).to_bytes(2,"big")+_varint(2)
    l=_varint(0)+_varint(len(name))+name.encode()+uuid.UUID(player).bytes
    return _varint(len(h))+h+_varint(len(l))+l


class GameBridgeTests(unittest.TestCase):
    def test_large_bidirectional_transfer_and_half_close(self):
        client, left = socket.socketpair()
        right, server = socket.socketpair()
        payload = bytes(range(256))*2048
        reply = b"response"*100000
        outcome = {}
        failures = []
        def relay():
            try: outcome.update(pump(left, right, threading.Event(), timeout=5))
            except Exception as error: failures.append(error)
        def remote():
            try:
                received = bytearray()
                while data := server.recv(8192): received.extend(data)
                self.assertEqual(received, payload)
                server.sendall(reply)
                server.shutdown(socket.SHUT_WR)
            except Exception as error: failures.append(error)
        for s in (client, server): s.settimeout(6)
        threads = [threading.Thread(target=relay), threading.Thread(target=remote)]
        try:
            for t in threads: t.start()
            client.sendall(payload); client.shutdown(socket.SHUT_WR)
            received = bytearray()
            while data := client.recv(8192): received.extend(data)
            self.assertEqual(received, reply)
            for t in threads: t.join(timeout=7)
            self.assertFalse(any(t.is_alive() for t in threads))
            self.assertEqual(failures, [])
            self.assertEqual(outcome, {"status":"completed", "left_to_right":len(payload), "right_to_left":len(reply)})
        finally:
            for s in (client, left, right, server): s.close()

    def test_long_workspace_path_can_bind_and_stop_without_a_connection(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp)/("long-workspace-"*10)
            parent.mkdir()
            bridge = GameBridge(parent/"game-bridge")
            self.assertTrue(bridge.path.is_socket())
            self.assertEqual(bridge.close(), {"status":"stopped", "connections":0})
            self.assertFalse(bridge.thread.is_alive())

    def test_valid_login_forwarded_once_with_payload_and_no_reconnect(self):
        from unittest.mock import patch
        from tools.pilot.test_login_identity import packets
        h, login = packets()
        prefix = h + login
        upstream, server = socket.socketpair()
        received = bytearray()
        failures = []
        def remote():
            try:
                with server:
                    server.settimeout(2)
                    while data := server.recv(4096): received.extend(data)
                    server.sendall(b"server-response")
            except Exception as error: failures.append(error)
        with tempfile.TemporaryDirectory() as tmp:
            with patch("tools.pilot.game_bridge.socket.create_connection", return_value=upstream) as connect:
                bridge = GameBridge(Path(tmp)/"bridge")
                thread = threading.Thread(target=remote); thread.start()
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                        client.settimeout(2); client.connect(str(bridge.path))
                        client.sendall(prefix + b"play-payload"); client.shutdown(socket.SHUT_WR)
                        response = bytearray()
                        while data := client.recv(4096): response.extend(data)
                    thread.join(3); bridge.thread.join(3)
                    result = bridge.close()
                    self.assertEqual(failures, [])
                    self.assertEqual(received, prefix+b"play-payload")
                    self.assertEqual(response, b"server-response")
                    self.assertEqual(result["status"], "completed")
                    self.assertEqual(result["identity"]["username"], "PilotProbe")
                    connect.assert_called_once_with(("127.0.0.1", 25585), timeout=2)
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as retry:
                        with self.assertRaises(OSError): retry.connect(str(bridge.path))
                finally:
                    bridge.close(); upstream.close(); server.close(); thread.join(3)

    def test_write_failure_retains_bounded_metadata_without_payload(self):
        a,b=socket.socketpair();c,d=socket.socketpair()
        try:
            c.shutdown(socket.SHUT_WR)
            a.sendall(b"private-packet-content")
            with self.assertRaises(BrokenPipeError) as caught:
                pump(b,c,threading.Event(),timeout=1)
            diagnostic=getattr(caught.exception,"bridge_diagnostics",{})
            self.assertEqual(diagnostic.get("operation"),"write")
            self.assertEqual(diagnostic.get("side"),"right")
            self.assertEqual(diagnostic.get("pending_right"),22)
            self.assertEqual(diagnostic.get("left_to_right"),0)
            self.assertNotIn("private-packet-content",str(diagnostic))
        finally:
            for stream in (a,b,c,d):stream.close()

    def test_real_tcp_reset_is_rejected_with_read_direction(self):
        import struct,errno
        listener=socket.socket();listener.bind(("127.0.0.1",0));listener.listen(1)
        client=socket.create_connection(listener.getsockname());left,_=listener.accept()
        right,remote=socket.socketpair()
        try:
            client.setsockopt(socket.SOL_SOCKET,socket.SO_LINGER,struct.pack("ii",1,0))
            client.close()
            with self.assertRaises(ConnectionResetError) as caught:
                pump(left,right,threading.Event(),timeout=1)
            diagnostic=caught.exception.bridge_diagnostics
            self.assertEqual(diagnostic["operation"],"read")
            self.assertEqual(diagnostic["side"],"left")
            self.assertEqual(diagnostic["errno"],errno.ECONNRESET)
            self.assertEqual(diagnostic["error_type"],"ConnectionResetError")
        finally:
            for stream in (listener,client,left,right,remote):stream.close()

    def test_idle_deadline(self):
        a, b = socket.socketpair(); c, d = socket.socketpair()
        try:
            start = time.monotonic()
            with self.assertRaises(TimeoutError) as caught: pump(b, c, threading.Event(), timeout=0.1)
            self.assertEqual(getattr(caught.exception,"bridge_diagnostics",{}).get("operation"),"deadline")
            self.assertLess(time.monotonic()-start, 1)
        finally:
            for s in (a,b,c,d): s.close()

    def test_stop_interrupts_backpressure(self):
        a, b = socket.socketpair(); c, d = socket.socketpair()
        stop = threading.Event(); result = {}
        thread = threading.Thread(target=lambda: result.update(pump(b,c,stop,timeout=3)))
        try:
            a.setblocking(False)
            thread.start()
            try:
                for _ in range(100): a.send(b"x"*16384)
            except BlockingIOError: pass
            stop.set(); thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result["status"], "stopped")
        finally:
            stop.set(); thread.join(timeout=1)
            for s in (a,b,c,d): s.close()

    def test_invalid_login_never_connects_upstream(self):
        for name, player in [("Other", OFFLINE_UUID),
                             ("PilotProbe", "00000000-0000-0000-0000-000000000000")]:
            with self.subTest(name=name, player=player), tempfile.TemporaryDirectory() as temp:
                with patch("tools.pilot.game_bridge.socket.create_connection") as upstream:
                    bridge = GameBridge(Path(temp)/"bridge")
                    try:
                        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                            client.connect(str(bridge.path))
                            client.sendall(_login(name=name, player=player))
                        bridge.thread.join(1)
                        self.assertFalse(bridge.thread.is_alive())
                        result = bridge.close()
                        self.assertEqual(result["status"], "failed")
                        self.assertEqual(result["connections"], 1)
                        self.assertNotIn("identity", result)
                        upstream.assert_not_called()
                    finally:
                        bridge.close()


if __name__ == "__main__": unittest.main()
