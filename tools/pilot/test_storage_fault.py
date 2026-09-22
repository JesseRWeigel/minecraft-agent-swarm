import errno
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools.pilot.storage_fault import inject_disk_full, read_receipt


class StorageFaultTests(unittest.TestCase):
    def _receipt(self, root):
        receipt = root / "receipt.json"
        receipt.write_bytes(b" " * 4096)
        receipt.chmod(0o600)
        return receipt

    @patch("tools.pilot.storage_fault._bounded_fuse_mount", return_value=True)
    @patch("tools.pilot.storage_fault._runtime_capacity", return_value=2 * 1024 ** 3)
    def test_rejects_receipt_on_runtime_filesystem_before_writing(self, _, __):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runtime = root / "runtime"; runtime.mkdir()
            receipt = self._receipt(root)
            with self.assertRaisesRegex(ValueError, "different filesystem"):
                inject_disk_full(runtime, receipt)
            self.assertEqual(receipt.read_bytes(), b" " * 4096)

    @patch("tools.pilot.storage_fault._bounded_fuse_mount", return_value=True)
    @patch("tools.pilot.storage_fault._runtime_capacity", return_value=2 * 1024 ** 3)
    def test_rejects_symlink_and_wrong_sized_receipts(self, _, __):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runtime = root / "runtime"; runtime.mkdir()
            outside = Path("/dev/shm") / ("storage-fault-" + root.name)
            outside.write_bytes(b" " * 4096); outside.chmod(0o600)
            link = root / "link"; link.symlink_to(outside)
            with self.assertRaises(ValueError): inject_disk_full(runtime, link)
            outside.write_bytes(b"bad")
            with self.assertRaises(ValueError): inject_disk_full(runtime, outside)
            outside.unlink()

    @patch("tools.pilot.storage_fault._bounded_fuse_mount", return_value=True)
    @patch("tools.pilot.storage_fault._runtime_capacity", return_value=2 * 1024 ** 3)
    def test_enospc_is_the_only_injected_result_and_receipt_is_strict(self, _, __):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runtime = root / "runtime"; runtime.mkdir()
            receipt = Path("/dev/shm") / ("storage-fault-" + root.name)
            receipt.write_bytes(b" " * 4096); receipt.chmod(0o600)
            try:
                with patch("tools.pilot.storage_fault.os.write", side_effect=[1024, OSError(errno.ENOSPC, "large full"), 512, OSError(errno.ENOSPC, "page full"), 1, OSError(errno.ENOSPC, "byte full")]), \
                     patch("tools.pilot.storage_fault.time.monotonic", side_effect=list(range(1, 9))):
                    result = inject_disk_full(runtime, receipt)
                self.assertEqual(result["status"], "injected")
                self.assertEqual(result["errno"], errno.ENOSPC)
                self.assertEqual(read_receipt(receipt)["bytes_written"], 1537)
            finally:
                receipt.unlink(missing_ok=True)

    @patch("tools.pilot.storage_fault._bounded_fuse_mount", return_value=True)
    @patch("tools.pilot.storage_fault._runtime_capacity", return_value=2 * 1024 ** 3)
    def test_non_enospc_and_deadline_never_claim_injection(self, _, __):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runtime = root / "runtime"; runtime.mkdir()
            for label, writes, clock in (("eio", [OSError(errno.EIO, "io")], [1, 2, 3]), ("deadline", [1], [1, 32, 33])):
                scenario_runtime = root / ("runtime-" + label)
                scenario_runtime.mkdir()
                receipt = Path("/dev/shm") / ("storage-fault-" + root.name + label)
                receipt.write_bytes(b" " * 4096); receipt.chmod(0o600)
                try:
                    with patch("tools.pilot.storage_fault.os.write", side_effect=writes), \
                         patch("tools.pilot.storage_fault.time.monotonic", side_effect=clock):
                        result = inject_disk_full(scenario_runtime, receipt)
                    self.assertEqual(result["status"], "failed")
                finally:
                    receipt.unlink(missing_ok=True)

    def test_rejects_unbounded_or_nonfuse_runtime_before_touching_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runtime = root / "runtime"; runtime.mkdir()
            receipt = self._receipt(root)
            with patch("tools.pilot.storage_fault._runtime_capacity", return_value=4 * 1024 ** 3 + 1), \
                 patch("tools.pilot.storage_fault._bounded_fuse_mount", return_value=True):
                with self.assertRaises(ValueError): inject_disk_full(runtime, receipt)
            with patch("tools.pilot.storage_fault._runtime_capacity", return_value=2 * 1024 ** 3), \
                 patch("tools.pilot.storage_fault._bounded_fuse_mount", return_value=False):
                with self.assertRaises(ValueError): inject_disk_full(runtime, receipt)

    def test_strict_reader_rejects_duplicate_bool_float_and_out_of_range_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            receipt = self._receipt(Path(temporary))
            base = {"schema_version": 1, "case": "disk_full", "stage": "after_action_finished", "status": "injected", "errno": errno.ENOSPC, "bytes_written": 1, "started_monotonic": 1, "finished_monotonic": 2, "error": None}
            cases = [
                b'{"schema_version":1,"schema_version":1}',
                json.dumps({**base, "schema_version": True}).encode(),
                json.dumps({**base, "errno": 28.0}).encode(),
                json.dumps({**base, "bytes_written": 4 * 1024 ** 3 + 1}).encode(),
                json.dumps({**base, "started_monotonic": -1}).encode(),
                json.dumps({**base, "status": "requested", "errno": None, "bytes_written": 0, "error": "unexpected"}).encode(),
            ]
            for raw in cases:
                receipt.write_bytes(raw + b" " * (4096 - len(raw)))
                with self.subTest(raw=raw), self.assertRaises(ValueError):
                    read_receipt(receipt)

    def test_filler_open_failure_still_writes_a_failed_final_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runtime = root / "runtime"; runtime.mkdir()
            receipt = Path("/dev/shm") / ("storage-fault-" + root.name)
            receipt.write_bytes(b" " * 4096); receipt.chmod(0o600)
            real_open = os.open
            def fail_fill(path, *args):
                if str(path).endswith("storage-fault-fill.bin"):
                    raise OSError(errno.EIO, "open")
                return real_open(path, *args)
            try:
                with patch("tools.pilot.storage_fault._runtime_capacity", return_value=2 * 1024 ** 3), \
                     patch("tools.pilot.storage_fault._bounded_fuse_mount", return_value=True), \
                     patch("tools.pilot.storage_fault.os.open", side_effect=fail_fill):
                    result = inject_disk_full(runtime, receipt)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(read_receipt(receipt)["status"], "failed")
            finally:
                receipt.unlink(missing_ok=True)

    def test_fill_fsync_failure_closes_fd_and_writes_failed_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runtime = root / "runtime"; runtime.mkdir()
            receipt = Path("/dev/shm") / ("storage-fault-fsync-" + root.name)
            receipt.write_bytes(b" " * 4096); receipt.chmod(0o600)
            real_open, real_fsync = os.open, os.fsync
            fill_fds = []
            def capture_open(path, *args):
                fd = real_open(path, *args)
                if str(path).endswith("storage-fault-fill.bin"):
                    fill_fds.append(fd)
                return fd
            def fail_only_filler(fd):
                if os.readlink(f"/proc/self/fd/{fd}").endswith("storage-fault-fill.bin"):
                    raise OSError(errno.EIO, "fsync")
                return real_fsync(fd)
            try:
                with patch("tools.pilot.storage_fault._runtime_capacity", return_value=2 * 1024 ** 3), \
                     patch("tools.pilot.storage_fault._bounded_fuse_mount", return_value=True), \
                     patch("tools.pilot.storage_fault.os.open", side_effect=capture_open), \
                     patch("tools.pilot.storage_fault.os.write", side_effect=[4096, OSError(errno.ENOSPC, "full")]), \
                     patch("tools.pilot.storage_fault.os.fsync", side_effect=fail_only_filler):
                    result = inject_disk_full(runtime, receipt)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"], "fill_flush_failed")
                self.assertEqual(read_receipt(receipt)["status"], "failed")
                self.assertEqual(len(fill_fds), 1)
                with self.assertRaises(OSError) as closed:
                    os.fstat(fill_fds[0])
                self.assertEqual(closed.exception.errno, errno.EBADF)
            finally:
                receipt.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
