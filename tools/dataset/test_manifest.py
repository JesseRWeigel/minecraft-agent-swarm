import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from manifest import ManifestError, ManifestReader, verify_manifest


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ManifestTests(unittest.TestCase):
    def file_entry(self, relpath: str, data: bytes, kind: str = "event_payload"):
        return {
            "source_relpath": relpath,
            "archive_relpath": relpath,
            "sha256": digest(data),
            "source_size_at_open": len(data),
            "captured_bytes": len(data),
            "complete_line_cutoff": None,
            "status": "complete",
            "source_kind": kind,
        }

    def write_v2(self, root: Path, entries, *, copy_complete=True):
        shard_dir = root / "manifests"
        shard_dir.mkdir(parents=True)
        shard_path = shard_dir / "manifest-000001.jsonl"
        shard_bytes = b"".join(
            json.dumps(entry, sort_keys=True, separators=(",", ":")).encode() + b"\n" for entry in entries
        )
        shard_path.write_bytes(shard_bytes)
        doc = {
            "schema_version": 2,
            "manifest_kind": "run_export",
            "created_at_utc": "2026-09-12T00:00:00Z",
            "run_id": "run-a",
            "scope": "closed_run",
            "run_closed": True,
            "censored": False,
            "closure": {
                "kind": "operator_assertion",
                "reference": "ops/interventions.jsonl:1",
                "asserted_by": "test-operator",
            },
            "copy_complete": copy_complete,
            "episode_complete": False,
            "episode_completion_basis": "not_independently_verified",
            "audit": {"findings": 0},
            "storage": {},
            "totals": {
                "files": len(entries),
                "captured_bytes": sum(item["captured_bytes"] for item in entries),
                "shards": 1,
            },
            "shards": [
                {
                    "archive_relpath": "manifests/manifest-000001.jsonl",
                    "sha256": digest(shard_bytes),
                    "bytes": len(shard_bytes),
                    "file_count": len(entries),
                    "captured_bytes": sum(item["captured_bytes"] for item in entries),
                }
            ],
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(doc), encoding="utf-8")
        return manifest_path

    def test_version_one_manifest_remains_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b'{"legacy":true}\n'
            target = root / "files" / "legacy.jsonl"
            target.parent.mkdir()
            target.write_bytes(data)
            entry = self.file_entry("files/legacy.jsonl", data, "trajectory_jsonl")
            entry["complete_line_cutoff"] = len(data)
            manifest = {
                "schema_version": 1,
                "captured_at_utc": "2026-09-12T00:00:00Z",
                "source_root": "/private/source",
                "complete": True,
                "files": [entry],
            }
            path = root / "manifest.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")

            reader = ManifestReader(path)
            self.assertEqual(reader.schema_version, 1)
            self.assertEqual(list(reader.iter_files()), [entry])
            self.assertEqual(verify_manifest(path)["files"], 1)

    def test_version_two_shards_stream_and_reconcile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entries = []
            for number in range(3):
                data = json.dumps({"n": number}).encode() + b"\n"
                relpath = f"files/payloads/{number}.json"
                target = root / relpath
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                entries.append(self.file_entry(relpath, data))
            path = self.write_v2(root, entries)

            reader = ManifestReader(path)
            self.assertEqual(reader.schema_version, 2)
            self.assertEqual([entry["archive_relpath"] for entry in reader.iter_files()], [
                "files/payloads/0.json",
                "files/payloads/1.json",
                "files/payloads/2.json",
            ])
            self.assertEqual(verify_manifest(path), {
                "schema_version": 2,
                "files": 3,
                "captured_bytes": sum(entry["captured_bytes"] for entry in entries),
                "shards": 1,
                "manifest_sha256": digest(path.read_bytes()),
            })

    def test_corrupt_shard_is_rejected_before_entries_are_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.write_v2(root, [])
            (root / "manifests" / "manifest-000001.jsonl").write_text("corrupt\n", encoding="utf-8")
            with self.assertRaisesRegex(ManifestError, "shard.*(hash|size)"):
                list(ManifestReader(path).iter_files())

    def test_corrupt_archived_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b"good\n"
            target = root / "files" / "payload.json"
            target.parent.mkdir()
            target.write_bytes(data)
            path = self.write_v2(root, [self.file_entry("files/payload.json", data)])
            target.write_bytes(b"evil\n")
            with self.assertRaisesRegex(ManifestError, "hash|size"):
                verify_manifest(path)

    def test_duplicate_paths_across_shards_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b"same\n"
            target = root / "files" / "same.json"
            target.parent.mkdir()
            target.write_bytes(data)
            entry = self.file_entry("files/same.json", data)
            path = self.write_v2(root, [entry, entry])
            with self.assertRaisesRegex(ManifestError, "duplicate archive path"):
                list(ManifestReader(path).iter_files())

    def test_traversal_and_symlink_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for mode in ("traversal", "symlink"):
                with self.subTest(mode=mode):
                    root = base / mode
                    root.mkdir()
                    outside = base / f"{mode}-outside"
                    outside.write_bytes(b"outside")
                    if mode == "traversal":
                        entry = self.file_entry("../traversal-outside", b"outside")
                    else:
                        link = root / "files" / "link"
                        link.parent.mkdir()
                        link.symlink_to(outside)
                        entry = self.file_entry("files/link", b"outside")
                    path = self.write_v2(root, [entry])
                    with self.assertRaisesRegex(ManifestError, "path|symlink"):
                        verify_manifest(path)

    def test_incomplete_root_is_not_a_finalized_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.write_v2(root, [], copy_complete=False)
            with self.assertRaisesRegex(ManifestError, "complete"):
                ManifestReader(path)

    def test_scope_cannot_conflict_with_closure_or_censoring_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.write_v2(root, [])
            doc = json.loads(path.read_text())
            doc["censored"] = True
            path.write_text(json.dumps(doc), encoding="utf-8")

            with self.assertRaisesRegex(ManifestError, "censoring.*scope"):
                ManifestReader(path)

    def test_claimed_complete_line_requires_a_final_newline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b'{"unterminated":true}'
            target = root / "files" / "events.jsonl"
            target.parent.mkdir()
            target.write_bytes(data)
            entry = self.file_entry("files/events.jsonl", data, "event_jsonl")
            entry["complete_line_cutoff"] = len(data)
            path = self.write_v2(root, [entry])

            with self.assertRaisesRegex(ManifestError, "newline terminated"):
                verify_manifest(path)

    def test_partial_complete_line_cutoff_must_point_to_a_newline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b'{"first":true}\n{"tail":'
            target = root / "files" / "events.jsonl"
            target.parent.mkdir()
            target.write_bytes(data)
            entry = self.file_entry("files/events.jsonl", data, "event_jsonl")
            entry["complete_line_cutoff"] = 5
            path = self.write_v2(root, [entry])

            with self.assertRaisesRegex(ManifestError, "newline terminated"):
                verify_manifest(path)

    def test_duplicate_json_keys_in_a_shard_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.write_v2(root, [])
            shard = root / "manifests" / "manifest-000001.jsonl"
            raw = b'{"archive_relpath":"files/a","archive_relpath":"files/b"}\n'
            shard.write_bytes(raw)
            doc = json.loads(path.read_text())
            doc["shards"][0].update({"sha256": digest(raw), "bytes": len(raw), "file_count": 1})
            doc["totals"].update({"files": 1})
            path.write_text(json.dumps(doc), encoding="utf-8")
            with self.assertRaisesRegex(ManifestError, "duplicate JSON key"):
                list(ManifestReader(path).iter_files())


if __name__ == "__main__":
    unittest.main()
