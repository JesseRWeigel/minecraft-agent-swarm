import socket
import struct
import threading
import time
import unittest
from unittest.mock import patch
from tools.pilot.rcon_stall import RconStall, read_frame, COMMANDS


def packet(i, kind, body=b""):
    return struct.pack("<iii", len(body)+10, i, kind)+body+b"\0\0"


class RconStallTests(unittest.TestCase):
    def test_auth_and_position_forwarded_dimension_reply_withheld(self):
        server = socket.socket(); server.bind(("127.0.0.1",0)); server.listen(1)
        errors=[]
        def respond():
            try:
                with server.accept()[0] as s:
                    stop=threading.Event(); deadline=time.monotonic()+3
                    self.assertEqual(read_frame(s,stop,deadline),packet(0,3,b"private"))
                    s.sendall(packet(0,2))
                    for i,command in enumerate(COMMANDS,1):
                        self.assertEqual(read_frame(s,stop,deadline),packet(i,2,command))
                        s.sendall(packet(i,0,b"server reply"))
            except Exception as e: errors.append(e)
        thread=threading.Thread(target=respond);thread.start()
        proxy=None
        try:
            with patch("tools.pilot.rcon_stall.LISTEN",("127.0.0.1",0)), patch("tools.pilot.rcon_stall.UPSTREAM",server.getsockname()):
                proxy=RconStall()
                with socket.create_connection(proxy.listener.getsockname(),timeout=1) as client:
                    deadline=time.monotonic()+3;stop=threading.Event()
                    client.sendall(packet(0,3,b"private"));self.assertEqual(read_frame(client,stop,deadline),packet(0,2))
                    client.sendall(packet(1,2,COMMANDS[0]));self.assertEqual(read_frame(client,stop,deadline),packet(1,0,b"server reply"))
                    client.sendall(packet(2,2,COMMANDS[1]));client.settimeout(.2)
                    with self.assertRaises(socket.timeout):client.recv(1)
                proxy.thread.join(timeout=1)
                result=proxy.close()
                self.assertEqual(result["status"],"reply_withheld")
                self.assertTrue(result["observer_closed"])
                self.assertTrue(result["cleanup_confirmed"])
                self.assertNotIn("private",str(result))
                self.assertEqual(result["forwarded_queries"],[x.decode() for x in COMMANDS])
        finally:
            if proxy:proxy.close()
            server.close();thread.join(timeout=3)
        self.assertFalse(errors,errors)
        self.assertFalse(thread.is_alive())

    def test_bad_frame_size_and_cancel_are_bounded(self):
        for size in (-1,9,4097):
            a,b=socket.socketpair()
            try:
                a.sendall(struct.pack("<i",size))
                with self.assertRaises(ValueError):read_frame(b,threading.Event(),time.monotonic()+1)
            finally:a.close();b.close()
        a,b=socket.socketpair()
        try:
            stop=threading.Event();stop.set()
            with self.assertRaises(TimeoutError):read_frame(b,stop,time.monotonic()+1)
        finally:a.close();b.close()
