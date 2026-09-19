import hashlib
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.pilot.client_tools import ClientToolsError, snapshot_tools, verify_tools


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ClientToolsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.node = self.root / "source-node"
        self.node.write_bytes(b"node-binary")
        self.modules = self.root / "source-modules"
        (self.modules / "pkg" / "lib").mkdir(parents=True)
        (self.modules / "pkg" / "index.js").write_bytes(b"export default 1\n")
        (self.modules / "pkg" / "lib" / "data.json").write_bytes(b'{"ok":true}\n')
        self.client = self.root / "source-client.mjs"
        self.client.write_bytes(b"console.log('qualification')\n")
        self.output = self.root / "snapshot"

    def tearDown(self):
        self.temporary.cleanup()

    def snapshot(self, **kwargs):
        kwargs.setdefault("reserve_bytes", 0)
        return snapshot_tools(self.node, self.modules, self.client, self.output, **kwargs)

    def rewrite_manifest(self, change):
        path = self.output / "manifest.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        change(document)
        raw = (json.dumps(document, indent=2, sort_keys=True) + "\n").encode("utf-8")
        path.write_bytes(raw)
        path.chmod(0o600)
        return hashlib.sha256(raw).hexdigest()

    def test_snapshots_private_bytes_and_verifies_by_manifest_pin(self):
        result = self.snapshot()
        manifest_path = self.output / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(result, {"manifest": manifest, "manifest_sha256": digest(manifest_path)})
        self.assertEqual(verify_tools(self.output, result["manifest_sha256"]), manifest)
        self.assertEqual((self.output / "bin" / "node").read_bytes(), b"node-binary")
        self.assertEqual((self.output / "qualification-client.mjs").read_bytes(), self.client.read_bytes())
        self.assertEqual([entry["path"] for entry in manifest["files"]], sorted(entry["path"] for entry in manifest["files"]))
        self.assertTrue(all(set(entry) == {"bytes", "path", "sha256"} for entry in manifest["files"]))
        self.assertEqual(stat.S_IMODE((self.output / "bin" / "node").stat().st_mode), 0o700)
        for path in [self.output, self.output / "bin", self.output / "node_modules", self.output / "node_modules/pkg/lib"]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        for path in [manifest_path, self.output / "qualification-client.mjs", self.output / "node_modules/pkg/index.js"]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_skips_and_records_bin_subtrees_at_any_node_modules_level(self):
        secret = self.root / "secret"
        secret.mkdir()
        (secret / "token").write_text("do not copy", encoding="utf-8")
        (self.modules / ".bin").symlink_to(secret, target_is_directory=True)
        nested = self.modules / "pkg" / "node_modules"
        nested.mkdir()
        (nested / ".bin").symlink_to(secret, target_is_directory=True)

        result = self.snapshot()

        self.assertEqual(
            result["manifest"]["excluded_paths"],
            ["node_modules/.bin", "node_modules/pkg/node_modules/.bin"],
        )
        self.assertFalse((self.output / "node_modules" / ".bin").exists())
        self.assertNotIn("token", json.dumps(result))

    def test_rejects_symlinks_special_files_and_unsafe_names(self):
        cases = []
        linked = self.modules / "pkg" / "linked.js"
        linked.symlink_to(self.client)
        cases.append(linked)
        fifo = self.modules / "pkg" / "pipe"
        os.mkfifo(fifo)
        cases.append(fifo)
        unsafe = self.modules / "pkg" / "bad\\name"
        unsafe.write_bytes(b"x")
        cases.append(unsafe)

        for index, bad_path in enumerate(cases):
            for other in cases:
                if other != bad_path and (other.exists() or other.is_symlink()):
                    other.unlink()
            destination = self.root / f"bad-output-{index}"
            with self.assertRaises(ClientToolsError):
                snapshot_tools(self.node, self.modules, self.client, destination, reserve_bytes=0)
            self.assertFalse(destination.exists())
            if index + 1 < len(cases):
                replacement = cases[index + 1]
                if replacement == fifo:
                    os.mkfifo(replacement)
                elif replacement == unsafe:
                    replacement.write_bytes(b"x")

    def test_rejects_non_package_bin_directories_instead_of_creating_unverifiable_snapshot(self):
        hidden = self.modules / "pkg" / "assets" / ".bin"
        hidden.mkdir(parents=True)
        (hidden / "data").write_bytes(b"unexpected")
        with self.assertRaisesRegex(ClientToolsError, r"\.bin"):
            self.snapshot()
        self.assertFalse(self.output.exists())

    def test_rejects_observed_source_mutation_and_removes_partial_output(self):
        payload = self.modules / "pkg" / "large.bin"
        payload.write_bytes(b"a" * 200_000)
        real_read = os.read
        mutated = False

        def mutate_after_read(fd, size):
            nonlocal mutated
            data = real_read(fd, size)
            if not mutated and data and os.fstat(fd).st_ino == payload.stat().st_ino:
                mutated = True
                with payload.open("ab") as target:
                    target.write(b"changed")
            return data

        with mock.patch("tools.pilot.client_tools.os.read", side_effect=mutate_after_read):
            with self.assertRaisesRegex(ClientToolsError, "changed during copy"):
                self.snapshot()
        self.assertTrue(mutated)
        self.assertFalse(self.output.exists())

    def test_rejects_existing_destination_without_changing_it(self):
        self.output.mkdir()
        sentinel = self.output / "keep"
        sentinel.write_text("unchanged", encoding="utf-8")
        with self.assertRaisesRegex(ClientToolsError, "already exists"):
            self.snapshot()
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "unchanged")

    def test_enforces_file_count_size_total_and_storage_reserve(self):
        import tools.pilot.client_tools as client_tools

        for patch_values, message in [
            ({"MAX_FILES": 2}, "file count"),
            ({"MAX_FILE_BYTES": 4}, "file size"),
            ({"MAX_TOTAL_BYTES": 10}, "total size"),
        ]:
            destination = self.root / f"limit-{message.replace(' ', '-')}"
            with mock.patch.multiple(client_tools, **patch_values):
                with self.assertRaisesRegex(ClientToolsError, message):
                    snapshot_tools(self.node, self.modules, self.client, destination, reserve_bytes=0)
            self.assertFalse(destination.exists())
        with self.assertRaisesRegex(ClientToolsError, "reserve"):
            self.snapshot(reserve_bytes=10**30)
        self.assertFalse(self.output.exists())

    def test_verification_rejects_tamper_extras_symlinks_and_permissions(self):
        result = self.snapshot()
        pin = result["manifest_sha256"]
        target = self.output / "node_modules" / "pkg" / "index.js"

        target.write_bytes(b"tampered")
        with self.assertRaises(ClientToolsError):
            verify_tools(self.output, pin)
        target.write_bytes(b"export default 1\n")

        extra = self.output / "extra"
        extra.write_bytes(b"extra")
        with self.assertRaisesRegex(ClientToolsError, "unlisted or missing"):
            verify_tools(self.output, pin)
        extra.unlink()

        target.chmod(0o644)
        with self.assertRaisesRegex(ClientToolsError, "permissions"):
            verify_tools(self.output, pin)
        target.chmod(0o600)

        target.unlink()
        target.symlink_to(self.client)
        with self.assertRaises(ClientToolsError):
            verify_tools(self.output, pin)

    def test_verification_rejects_manifest_tamper_wrong_pin_and_extra_directory(self):
        result = self.snapshot()
        pin = result["manifest_sha256"]
        with self.assertRaisesRegex(ClientToolsError, "manifest hash"):
            verify_tools(self.output, "0" * 64)
        manifest_path = self.output / "manifest.json"
        manifest_path.write_bytes(manifest_path.read_bytes() + b" ")
        with self.assertRaisesRegex(ClientToolsError, "manifest hash"):
            verify_tools(self.output, pin)

        # Restore the pinned snapshot and prove empty directory additions are detected too.
        self.output = self.root / "snapshot-two"
        result = self.snapshot()
        (self.output / "unlisted-empty").mkdir()
        with self.assertRaises(ClientToolsError):
            verify_tools(self.output, result["manifest_sha256"])

    def test_verification_normalizes_malformed_manifest_path_types(self):
        malformed = [
            lambda document: document.__setitem__("excluded_paths", [None]),
            lambda document: document.__setitem__("excluded_paths", ["node_modules/.bin", 7]),
            lambda document: document.__setitem__("excluded_paths", ["."]),
            lambda document: document["files"][0].__setitem__("path", None),
            lambda document: document["files"][0].__setitem__("path", "."),
            lambda document: document["files"][0].__setitem__("path", "node_modules"),
        ]
        for index, change in enumerate(malformed):
            self.output = self.root / f"malformed-{index}"
            self.snapshot()
            pin = self.rewrite_manifest(change)
            with self.assertRaises(ClientToolsError, msg=f"case {index}"):
                verify_tools(self.output, pin)


if __name__ == "__main__":
    unittest.main()
