import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from tools.pilot import protected_qualification as host


class ProtectedStorageTests(unittest.TestCase):
    def test_storage_tools_required_before_mutation(self):
        with self.assertRaisesRegex(ValueError, "storage tool root"):
            host.run_protected_qualification(launch=True, workspace=Path("/not-created"),
                restore_kwargs={}, tool_snapshot=Path("/none"), tool_manifest_sha256="a"*64)

    def test_restore_failure_still_closes_storage_and_preserves_summary(self):
        for cleanup_fails in (False, True):
            with self.subTest(cleanup_fails=cleanup_fails), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                with patch.object(host, "_validate_executable"), patch.object(host, "verify_tools"), \
                     patch.object(host, "capture_sources", return_value="a"*64), \
                     patch.object(host, "BoundedStorage") as storage_class, \
                     patch.object(host.restore, "restore", side_effect=OSError("disk full")) as restore:
                    storage = storage_class.return_value
                    storage.start.return_value = root / "mount"
                    if cleanup_fails:
                        storage.close.side_effect = OSError("busy mount")
                    else:
                        storage.close.return_value = {"valid": True, "cleanup_uncertain": False}
                    result = host.run_protected_qualification(launch=True, workspace=root / "attempt",
                        restore_kwargs={}, tool_snapshot=root, tool_manifest_sha256="a"*64,
                        storage_tool_root=root)
                    self.assertEqual(result["status"], "failed")
                    self.assertEqual(result["stage"], "restore")
                    self.assertEqual(restore.call_args.kwargs["reserve_bytes"], 64*1024**2)
                    storage.close.assert_called_once_with()
                    self.assertEqual(result["storage"]["cleanup_uncertain"], cleanup_fails)
                    self.assertTrue((root / "attempt" / "protected-summary.json").is_file())


if __name__ == "__main__": unittest.main()
