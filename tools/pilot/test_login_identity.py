import socket, threading, time, unittest, uuid
from tools.pilot.login_identity import admit_login, OFFLINE_UUID

def v(n):
    out=b''
    while True:
        b=n&127; n>>=7; out+=bytes([b|(128 if n else 0)])
        if not n:return out
def s(x):
    b=x.encode(); return v(len(b))+b
def frame(body): return v(len(body))+body
def packets(name="PilotProbe", player=OFFLINE_UUID, protocol=769):
    h=frame(v(0)+v(protocol)+s("127.0.0.1")+(25585).to_bytes(2,"big")+v(2))
    l=frame(v(0)+s(name)+uuid.UUID(player).bytes)
    return h,l

class LoginIdentityTests(unittest.TestCase):
 def test_fragmented_admission_and_coalesced_leftover(self):
  a,b=socket.socketpair(); h,l=packets(); extra=b'next'
  try:
   def send():
    for x in (h[:2],h[2:],l+extra): b.sendall(x)
   threading.Thread(target=send).start(); raw,identity=admit_login(a,threading.Event())
   self.assertEqual(raw,h+l); self.assertEqual(identity['uuid'],OFFLINE_UUID); self.assertEqual(a.recv(4),extra)
  finally:a.close();b.close()
 def test_rejects_wrong_identity_and_eof(self):
  for h,l in [packets(name='Other'), (b'\x02\x00',b'')]:
   a,b=socket.socketpair()
   try:
    b.sendall(h+l); b.close()
    with self.assertRaises(ValueError):admit_login(a,threading.Event())
   finally:a.close()
 def test_idle_deadline_and_cancel(self):
  a,b=socket.socketpair()
  try:
   with self.assertRaises(TimeoutError):admit_login(a,threading.Event(),.02)
   stop=threading.Event();stop.set()
   with self.assertRaises(TimeoutError):admit_login(a,stop,1)
  finally:a.close();b.close()

class MalformedLoginTests(unittest.TestCase):
 def test_rejects_wrong_uuid_protocol_and_malformed_frames(self):
  h,l=packets()
  cases=[b"".join(packets(player="00000000-0000-0000-0000-000000000000")),
         b"".join(packets(protocol=768)), h[:-1]+b"\x01"+l,
         h.replace(b"127.0.0.1",b"127.0.0.2")+l,
         b"\x80\x00", b"\x81\x08", b"\x80"*5,
         h+frame(b"\x00\x01\xff"+uuid.UUID(OFFLINE_UUID).bytes),
         h+frame(b"\x00"+s("PilotProbe")+uuid.UUID(OFFLINE_UUID).bytes+b"x")]
  for raw in cases:
   with self.subTest(raw=raw):
    a,b=socket.socketpair()
    try:
     b.sendall(raw)
     with self.assertRaises(ValueError):admit_login(a,threading.Event(),.1)
    finally:a.close();b.close()
 def test_invalid_timeout_rejected_without_reading(self):
  a,b=socket.socketpair()
  try:
   for timeout in (True,0,-1,6,float("inf"),float("nan")):
    with self.assertRaises(ValueError):admit_login(a,threading.Event(),timeout)
  finally:a.close();b.close()
