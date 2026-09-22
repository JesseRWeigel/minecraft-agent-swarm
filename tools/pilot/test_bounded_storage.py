import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tools.pilot.bounded_storage import (
    BoundedStorage,
    DEFAULT_CAPACITY_BYTES,
    _mount_matches,
)


class BoundedStorageTests(unittest.TestCase):
    def test_rejects_unpinned_tool_material_before_creating_storage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tool_root = root / "tool-root"
            fuse = tool_root / "usr/bin/fuse2fs"
            library = tool_root / "lib/x86_64-linux-gnu/libfuse.so.2.9.9"
            fuse.parent.mkdir(parents=True)
            library.parent.mkdir(parents=True)
            fuse.write_bytes(b"untrusted fuse")
            library.write_bytes(b"untrusted library")
            storage = BoundedStorage(root / "storage", tool_root)
            with self.assertRaisesRegex(ValueError, "pinned"):
                storage.start()
            self.assertFalse((root / "storage").exists())

    def test_default_capacity_is_two_gibibytes(self):
        self.assertEqual(DEFAULT_CAPACITY_BYTES, 2 * 1024 ** 3)

    def test_capacity_is_bounded_to_whole_mebibytes(self):
        with self.assertRaises(ValueError):
            BoundedStorage("/storage", "/tools", capacity_bytes=63 * 1024 ** 2)
        with self.assertRaises(ValueError):
            BoundedStorage("/storage", "/tools", capacity_bytes=4 * 1024 ** 3 + 1024 ** 2)
        with self.assertRaises(ValueError):
            BoundedStorage("/storage", "/tools", capacity_bytes=64 * 1024 ** 2 + 1)

    def test_start_rejects_a_relative_or_nonprivate_storage_parent(self):
        with self.assertRaisesRegex(RuntimeError, "workspace"):
            BoundedStorage("relative/storage", "/tools").start()
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            parent.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, "private"):
                BoundedStorage(parent / "storage", "/tools").start()

    def test_mount_identity_requires_fuse_ext4_and_the_image_source(self):
        line = "42 1 0:99 / /private/mount rw - fuse.ext4 /private/storage.ext4 rw\n"
        with patch("tools.pilot.bounded_storage.Path.read_text", return_value=line):
            self.assertTrue(_mount_matches("/private/mount", "/private/storage.ext4"))
            self.assertFalse(_mount_matches("/private/mount", "/other/image.ext4"))

    def test_close_preserves_image_and_reports_unclean_helper_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "storage.ext4"
            image.write_bytes(b"image")
            storage = BoundedStorage(root / "storage", root / "tool-root")
            storage.image = image
            storage.mountpoint = root / "mount"
            storage.mountpoint.mkdir()

            class Helper:
                returncode = None
                def poll(self): return None
                def wait(self, timeout): raise subprocess.TimeoutExpired("fuse2fs", timeout)
                def terminate(self): self.returncode = -15
                def kill(self): self.returncode = -9

            storage._helper = Helper()
            with patch("tools.pilot.bounded_storage._is_mounted", return_value=False):
                result = storage.close()
            self.assertTrue(image.exists())
            self.assertIsNone(result["image_sha256"])
            self.assertFalse(result["verified_clean"])
            self.assertTrue(result["helper_forced_cleanup"])

    def test_close_rejects_a_nonzero_helper_exit_after_unmount(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            storage = BoundedStorage(root / "storage", root / "tool-root", capacity_bytes=64 * 1024 ** 2)
            storage.image = root / "storage.ext4"
            with storage.image.open("wb") as image:
                image.truncate(storage.capacity_bytes)
            storage.mountpoint = root / "mount"
            storage.mountpoint.mkdir()
            storage._started = True
            storage._fusermount = Path("/trusted/fusermount3")

            class Helper:
                def poll(self): return 1
                def wait(self, timeout): return 1

            storage._helper = Helper()
            completed = subprocess.CompletedProcess([], 0)
            with patch("tools.pilot.bounded_storage._is_mounted", side_effect=[True, False]), \
                 patch.object(storage, "_quiet_run", return_value=completed):
                result = storage.close()
            self.assertFalse(result["verified_clean"])
            self.assertFalse(result["valid"])

    def test_dead_fuse_mount_remains_cleanup_uncertain_without_hashing_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            storage = BoundedStorage(root / "storage", root / "tool-root", capacity_bytes=64 * 1024 ** 2)
            storage.image = root / "storage.ext4"
            with storage.image.open("wb") as image:
                image.truncate(storage.capacity_bytes)
            storage.mountpoint = root / "mount"
            storage.mountpoint.mkdir()
            storage._started = True
            storage._fusermount = Path("/trusted/fusermount3")

            class Helper:
                def poll(self): return -9
                def wait(self, timeout): return -9

            storage._helper = Helper()
            mounted = ("fuse.ext4", str(storage.image))
            with patch("tools.pilot.bounded_storage._mount_entry", return_value=mounted), \
                 patch.object(storage, "_quiet_run", return_value=subprocess.CompletedProcess([], 1)):
                result = storage.close()
            self.assertTrue(result["unmount_attempted"])
            self.assertTrue(result["cleanup_uncertain"])
            self.assertIsNone(result["image_sha256"])
            self.assertFalse(result["valid"])

    def test_close_before_helper_launch_is_not_cleanup_uncertain(self):
        with tempfile.TemporaryDirectory() as temporary:
            storage = BoundedStorage(Path(temporary) / "storage", Path(temporary) / "tools")
            with patch("tools.pilot.bounded_storage._mount_entry", return_value=False):
                result = storage.close()
            self.assertFalse(result["cleanup_uncertain"])
            self.assertFalse(result["valid"])


if __name__ == "__main__":
    unittest.main()
