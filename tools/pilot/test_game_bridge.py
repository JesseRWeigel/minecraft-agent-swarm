from pathlib import Path
import tempfile
import socket
import threading
import time
import unittest
from tools.pilot.game_bridge import pump, GameBridge


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

    def test_idle_deadline(self):
        a, b = socket.socketpair(); c, d = socket.socketpair()
        try:
            start = time.monotonic()
            with self.assertRaises(TimeoutError): pump(b, c, threading.Event(), timeout=0.1)
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


if __name__ == "__main__": unittest.main()
