import io, tempfile, unittest, zipfile
from pathlib import Path
from tools.pilot.bootstrap import BootstrapError, MAX_CENTRAL_DIRECTORY_BYTES, _BoundedReader, inspect_bootstrap

class Tests(unittest.TestCase):
 def setUp(self): self.t=tempfile.TemporaryDirectory(); self.r=Path(self.t.name)
 def tearDown(self): self.t.cleanup()
 def jar(self, es):
  p=self.r/'x.jar'
  with zipfile.ZipFile(p,'w') as z:
   for n,d in es: z.writestr(n,d)
  return p
 def line(self): return 'a'*64+'\thttps://piston-data.mojang.com/v1/objects/abc/server.jar\tmojang_1.21.4.jar'
 def test_valid(self): self.assertEqual(inspect_bootstrap(self.jar([('META-INF/download-context',self.line())])),{'path':'cache/mojang_1.21.4.jar','sha256':'a'*64})
 def test_absent(self): self.assertIsNone(inspect_bootstrap(self.jar([('x','')])))
 def test_invalid_archive_and_symlink(self):
  p=self.r/'bad';p.write_bytes(b'x')
  with self.assertRaises(BootstrapError):inspect_bootstrap(p)
  q=self.r/'link';q.symlink_to(p)
  with self.assertRaises(BootstrapError):inspect_bootstrap(q)
 def test_duplicate_and_oversize(self):
  with self.assertWarns(UserWarning): p=self.jar([('META-INF/download-context',self.line())]*2)
  with self.assertRaises(BootstrapError):inspect_bootstrap(p)
  with self.assertRaises(BootstrapError):inspect_bootstrap(self.jar([('META-INF/download-context',b'x'*4097)]))
 def test_bad_fields(self):
  bad=[self.line()+'\tx',self.line().replace('a'*64,'A'*64),self.line().replace('https://','http://'),self.line().replace('piston-data.mojang.com','example.com'),self.line().replace('/server.jar','/server.jar?q=1'),self.line().replace('mojang_1.21.4.jar','../x.jar'),self.line().replace('mojang_1.21.4.jar','mojang_1.jar')]
  for x in bad:
   with self.assertRaises(BootstrapError):inspect_bootstrap(self.jar([('META-INF/download-context',x)]))
 def test_entry_limit(self):
  p=self.jar([(str(i),'') for i in range(10001)])
  with self.assertRaises(BootstrapError):inspect_bootstrap(p)
 def test_bounded_reader_caps_reads_and_snapshot_seek(self):
  reader = _BoundedReader(io.BytesIO(b'x' * (MAX_CENTRAL_DIRECTORY_BYTES + 1)), MAX_CENTRAL_DIRECTORY_BYTES + 1)
  with self.assertRaises(BootstrapError): reader.read()
  with self.assertRaises(BootstrapError): reader.seek(MAX_CENTRAL_DIRECTORY_BYTES + 2)
 def test_malformed_port_is_normalized(self):
  line = self.line().replace('piston-data.mojang.com', 'piston-data.mojang.com:bad')
  with self.assertRaises(BootstrapError): inspect_bootstrap(self.jar([('META-INF/download-context', line)]))
if __name__=='__main__':unittest.main()