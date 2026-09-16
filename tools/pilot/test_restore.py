import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import subprocess
import shutil
from unittest.mock import patch
import unittest

from tools.pilot.restore import RestoreError, restore, verify_runtime, _decompress


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / "world.tar"
        self.jar = self.root / "server.jar"; self.jar.write_bytes(b"synthetic-jar-never-executed")
        self.eula = self.root / "eula.txt"; self.eula.write_text("# existing operator acceptance\neula=true\n")
        self.output = self.root / "restored"
        self.write_archive()

    def write_archive(self, extra=None):
        entries = [("ai-world/level.dat", b"world"), ("ai-world_nether/DIM-1/region/r.0.0.mca", b"nether"), ("ai-world_the_end/DIM1/region/r.0.0.mca", b"end"), ("server.properties", b"rcon.password=private"), ("ops.json", b"[private]")]
        with tarfile.open(self.archive, "w", format=tarfile.USTAR_FORMAT) as tar:
            for name, raw in entries:
                entry = tarfile.TarInfo(name); entry.size = len(raw); tar.addfile(entry, io.BytesIO(raw))
            if extra is not None:
                entry, raw = extra; tar.addfile(entry, io.BytesIO(raw))

    def restore(self, **kwargs):
        return restore(self.archive, sha(self.archive), self.jar, sha(self.jar), self.eula, self.output, reserve_bytes=0, **kwargs)

    def test_restores_fresh_private_worlds_and_never_copies_live_configuration(self):
        manifest = self.restore()
        self.assertEqual(manifest["status"], "restored_not_started")
        self.assertTrue(manifest["isolated_network_required"])
        self.assertEqual((self.output / "ai-world/level.dat").read_bytes(), b"world")
        self.assertFalse((self.output / "ops.json").exists())
        properties = (self.output / "server.properties").read_text()
        self.assertNotIn("private", properties)
        self.assertIn("enable-rcon=false", properties)
        self.assertIn("server-ip=127.0.0.1", properties)
        pin = sha(self.output / "runtime-manifest.json")
        self.assertEqual(verify_runtime(self.output, pin), manifest)
        for p in self.output.rglob("*"):
            self.assertEqual(p.stat().st_mode & 0o777, 0o700 if p.is_dir() else 0o600)

    def test_rejects_wrong_pin_or_unaccepted_eula_before_output(self):
        with self.assertRaises(RestoreError):
            restore(self.archive, "0" * 64, self.jar, sha(self.jar), self.eula, self.output, reserve_bytes=0)
        self.assertFalse((self.output / "runtime-manifest.json").exists())
        other = self.root / "other"; self.eula.write_text("eula=false\n")
        with self.assertRaises(RestoreError):
            restore(self.archive, sha(self.archive), self.jar, sha(self.jar), self.eula, other, reserve_bytes=0)
        self.assertFalse(other.exists())

    def test_rejects_unsafe_members_and_expansion(self):
        for index, name in enumerate(["../outside", "ai-world/../../outside", "/absolute", "plugins/evil.jar"]):
            entry = tarfile.TarInfo(name); entry.size = 1
            self.write_archive((entry, b"x")); self.output = self.root / str(index)
            with self.assertRaises(RestoreError): self.restore()
            self.assertFalse((self.output / "runtime-manifest.json").exists())
        self.write_archive(); self.output = self.root / "bounded"
        with self.assertRaises(RestoreError): self.restore(max_expanded_bytes=1)

    def test_rejects_links_and_duplicate_members(self):
        for index, kind in enumerate([tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.GNUTYPE_SPARSE]):
            entry = tarfile.TarInfo("ai-world/linked"); entry.type = kind; entry.linkname = "../../elsewhere"
            self.write_archive((entry, b"")); self.output = self.root / str(index)
            with self.assertRaises(RestoreError): self.restore()
        entry = tarfile.TarInfo("ai-world/level.dat"); entry.size = 1
        self.write_archive((entry, b"x")); self.output = self.root / "duplicate"
        with self.assertRaises(RestoreError): self.restore()

    def test_verify_rejects_tampering_symlinks_and_unlisted_files(self):
        self.restore(); pin = sha(self.output / "runtime-manifest.json")
        extra = self.output / "extra"; extra.write_text("x")
        with self.assertRaises(RestoreError): verify_runtime(self.output, pin)
        extra.unlink()
        jar = self.output / "server.jar"; jar.unlink(); jar.symlink_to(self.jar)
        with self.assertRaises(RestoreError): verify_runtime(self.output, pin)
        jar.unlink(); jar.write_bytes(b"modified")
        with self.assertRaises(RestoreError): verify_runtime(self.output, pin)

    @unittest.skipUnless(shutil.which("zstd"), "zstd not installed")
    def test_compressed_backup_and_corrupt_compressed_stream(self):
        compressed = self.root / "world.tar.zst"
        with compressed.open("wb") as out:
            subprocess.run(["zstd", "-q", "-c", str(self.archive)], stdout=out, check=True)
        self.archive = compressed
        self.restore()
        self.assertEqual((self.output / "ai-world/level.dat").read_bytes(), b"world")
        self.output = self.root / "corrupt"
        self.archive.write_bytes(b"not zstd")
        with self.assertRaises(RestoreError): self.restore()
        self.assertFalse(self.output.exists())

    def test_path_prefix_conflict_missing_world_and_symlink_parent(self):
        entry = tarfile.TarInfo("ai-world/level.dat/child"); entry.size = 1
        self.write_archive((entry, b"x"))
        with self.assertRaises(RestoreError): self.restore()
        with tarfile.open(self.archive, "w") as tar:
            member = tarfile.TarInfo("ai-world/level.dat"); member.size = 1
            tar.addfile(member, io.BytesIO(b"x"))
        with self.assertRaises(RestoreError): self.restore()
        self.write_archive()
        link = self.root / "linked"; link.symlink_to(self.root, target_is_directory=True)
        self.output = link / "new"
        with self.assertRaises(RestoreError): self.restore()
        self.assertFalse((self.root / "new").exists())

    def test_rejects_re_pinned_false_claims_and_malformed_metadata(self):
        self.restore(); path = self.output / "runtime-manifest.json"
        original = json.loads(path.read_text())
        for change in [{"server_started": True}, {"claim_limit": "ready for evaluation"}, {"eula_source": "automatically_accepted"}, {"archive_scan": {"member_count": True}}, {"discarded_archive_entries": ["plugins/evil.jar"]}]:
            modified = dict(original); modified.update(change)
            path.write_text(json.dumps(modified))
            with self.assertRaises(RestoreError): verify_runtime(self.output, sha(path))

    def test_decompression_deadline_and_output_bound(self):
        helper = self.root / "fake-zstd"
        for index, body in enumerate(["import time; time.sleep(10)", "import os; os.write(1, b'x' * 1000)"]):
            helper.write_text("#!/usr/bin/python3\n" + body + "\n"); helper.chmod(0o700)
            with patch("tools.pilot.restore.shutil.which", return_value=str(helper)):
                with self.assertRaises(RestoreError):
                    _decompress(self.archive, self.root / f"decoded-{index}", 20, 0.1, 0)

    def test_existing_destination_preserved(self):
        self.output.mkdir(); keep = self.output / "keep"; keep.write_text("preserve")
        with self.assertRaises(RestoreError): self.restore()
        self.assertEqual(keep.read_text(), "preserve")


if __name__ == "__main__": unittest.main()
