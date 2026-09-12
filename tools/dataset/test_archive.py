import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("archive.py")
SPEC = importlib.util.spec_from_file_location("dataset_archive", MODULE_PATH)
archive = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = archive
SPEC.loader.exec_module(archive)


class CaptureJsonlPrefixTests(unittest.TestCase):
    def test_does_not_claim_partial_jsonl_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            destination = root / "copy.jsonl"
            source.write_bytes(b'{"n":1}\n{"n":')

            record = archive.capture_jsonl_prefix(source, destination)

            self.assertEqual(destination.read_bytes(), b'{"n":1}\n')
            self.assertEqual(record["source_size_at_open"], len(b'{"n":1}\n{"n":'))
            self.assertEqual(record["captured_bytes"], len(b'{"n":1}\n'))
            self.assertEqual(record["complete_line_cutoff"], len(b'{"n":1}\n'))
            self.assertEqual(record["status"], "complete_prefix")
            self.assertEqual(source.read_bytes(), b'{"n":1}\n{"n":')

    def test_complete_jsonl_is_streamed_and_hashed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            destination = root / "copy.jsonl"
            payload = (b'{"value":"' + b"x" * (1024 * 1024) + b'"}\n') * 64
            source.write_bytes(payload)

            record = archive.capture_jsonl_prefix(source, destination)

            self.assertEqual(destination.stat().st_size, len(payload))
            self.assertEqual(record["captured_bytes"], len(payload))
            self.assertEqual(record["complete_line_cutoff"], len(payload))
            self.assertEqual(record["status"], "complete")
            self.assertEqual(record["sha256"], archive.sha256_file(destination))

    def test_append_during_capture_produces_verified_initial_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            destination = root / "copy.jsonl"
            initial = b'{"n":1}\n'
            appended = b'{"n":2}\n'
            source.write_bytes(initial)
            original = archive._copy_exact

            def append_after_copy(*args, **kwargs):
                result = original(*args, **kwargs)
                with source.open("ab") as handle:
                    handle.write(appended)
                    handle.flush()
                    os.fsync(handle.fileno())
                return result

            with mock.patch.object(archive, "_copy_exact", side_effect=append_after_copy):
                record = archive.capture_jsonl_prefix(source, destination)

            self.assertEqual(destination.read_bytes(), initial)
            self.assertEqual(source.read_bytes(), initial + appended)
            self.assertEqual(record["source_size_at_open"], len(initial))
            self.assertEqual(record["status"], "complete_prefix")

    def test_truncation_during_capture_fails_without_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            destination = root / "copy.jsonl"
            source.write_bytes(b'{"n":1}\n{"n":2}\n')
            original = archive._copy_exact

            def truncate_after_copy(*args, **kwargs):
                result = original(*args, **kwargs)
                source.write_bytes(b'{"n":1}\n')
                return result

            with mock.patch.object(archive, "_copy_exact", side_effect=truncate_after_copy):
                with self.assertRaisesRegex(archive.ArchiveError, "truncated|changed"):
                    archive.capture_jsonl_prefix(source, destination)

            self.assertFalse(destination.exists())

    def test_replacement_during_capture_fails_without_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            replacement = root / "replacement.jsonl"
            destination = root / "copy.jsonl"
            source.write_bytes(b'{"n":1}\n')
            replacement.write_bytes(b'{"n":9}\n')
            original = archive._copy_exact

            def replace_after_copy(*args, **kwargs):
                result = original(*args, **kwargs)
                replacement.replace(source)
                return result

            with mock.patch.object(archive, "_copy_exact", side_effect=replace_after_copy):
                with self.assertRaisesRegex(archive.ArchiveError, "replaced"):
                    archive.capture_jsonl_prefix(source, destination)

            self.assertFalse(destination.exists())

    def test_existing_destination_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            destination = root / "copy.jsonl"
            source.write_bytes(b'{"n":1}\n')
            destination.write_bytes(b"keep me")

            with self.assertRaisesRegex(FileExistsError, "destination"):
                archive.capture_jsonl_prefix(source, destination)

            self.assertEqual(destination.read_bytes(), b"keep me")

    def test_copy_corruption_is_rejected_instead_of_blessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            destination = root / "copy.jsonl"
            source.write_bytes(b'{"n":1}\n')
            original = archive._copy_exact

            def corrupt_destination(*args, **kwargs):
                result = original(*args, **kwargs)
                destination_handle = args[1]
                destination_handle.seek(0)
                destination_handle.write(b"X")
                return result

            with mock.patch.object(archive, "_copy_exact", side_effect=corrupt_destination):
                with self.assertRaisesRegex(archive.ArchiveError, "copied|hash"):
                    archive.capture_jsonl_prefix(source, destination)

            self.assertFalse(destination.exists())

    def test_source_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real.jsonl"
            source = root / "source.jsonl"
            real.write_bytes(b'{"n":1}\n')
            source.symlink_to(real)

            with self.assertRaisesRegex(archive.ArchiveError, "symlink"):
                archive.capture_jsonl_prefix(source, root / "copy.jsonl")


class ArchiveSourcesTests(unittest.TestCase):
    def make_source(self, root: Path) -> None:
        (root / "logs" / "trajectories").mkdir(parents=True)
        (root / "logs" / "sessions").mkdir(parents=True)
        (root / "server" / "logs").mkdir(parents=True)
        (root / "skills" / "voyager").mkdir(parents=True)
        (root / "finetune").mkdir(parents=True)
        (root / "logs" / "trajectories" / "run.jsonl").write_bytes(b'{"success":true}\n{"tail":')
        (root / "logs" / "sessions" / "run.json").write_text('{"actions":2}', encoding="utf-8")
        (root / "logs" / "metrics.csv").write_text("name,value\nactions,2\n", encoding="utf-8")
        (root / "logs" / "swarm.log").write_text("started\n", encoding="utf-8")
        (root / "server" / "logs" / "latest.log").write_text("server started\n", encoding="utf-8")
        (root / "skills" / "voyager" / "mine.js").write_text("export default 1;\n", encoding="utf-8")
        (root / "memory-atlas.json").write_text('{"lessons":[]}', encoding="utf-8")
        (root / "finetune" / "train.log").write_text("loss=1.0\n", encoding="utf-8")
        (root / "finetune" / "model.gguf").write_bytes(b"excluded weight")
        (root / ".env").write_text("SECRET=do-not-copy\n", encoding="utf-8")

    def test_allowlisted_capture_excludes_secrets_and_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            source.mkdir()
            self.make_source(source)

            manifest = archive.archive_sources(source, output)

            self.assertTrue(manifest["complete"])
            self.assertEqual(manifest["schema_version"], 1)
            self.assertEqual(manifest, archive.verify_manifest(output / "manifest.json"))
            archived = {entry["source_relpath"] for entry in manifest["files"]}
            self.assertIn("logs/trajectories/run.jsonl", archived)
            self.assertIn("logs/sessions/run.json", archived)
            self.assertIn("skills/voyager/mine.js", archived)
            self.assertIn("memory-atlas.json", archived)
            self.assertNotIn(".env", archived)
            self.assertNotIn("finetune/model.gguf", archived)
            self.assertFalse(any(".env" in path for path in archived))
            self.assertFalse(any(path.endswith(".gguf") for path in archived))

    def test_explicit_extra_root_only_adds_bot_run_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            extra = base / "tmp"
            output = base / "archive"
            source.mkdir()
            extra.mkdir()
            self.make_source(source)
            (extra / "bot-run-123.log").write_text("bot log\n", encoding="utf-8")
            (extra / "other.log").write_text("must not copy\n", encoding="utf-8")
            (extra / "secret.txt").write_text("must not copy\n", encoding="utf-8")

            manifest = archive.archive_sources(source, output, extra_root=extra)

            archived = {entry["source_relpath"] for entry in manifest["files"]}
            self.assertIn("@extra/bot-run-123.log", archived)
            self.assertNotIn("@extra/other.log", archived)
            self.assertNotIn("@extra/secret.txt", archived)

    def test_supervisor_bot_runs_and_existing_world_backups_are_allowlisted(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            source.mkdir()
            self.make_source(source)
            (source / "ops").mkdir()
            (source / "ops" / "README.md").write_text("operator notes\n", encoding="utf-8")
            (source / "ops" / "state.json").write_text('{"status":"running"}', encoding="utf-8")
            (source / "ops" / "interventions.jsonl").write_text('{"kind":"restart"}\n{"partial":', encoding="utf-8")
            (source / "logs" / "bot-runs").mkdir()
            (source / "logs" / "bot-runs" / "bot-run-1.log").write_text("run complete\n", encoding="utf-8")
            (source / "logs" / "bot-runs" / "other.log").write_text("excluded\n", encoding="utf-8")
            (source / "backups").mkdir()
            (source / "backups" / "world-1.tar.zst").write_bytes(b"stable backup")
            (source / "backups" / "world-1.tar.zst.sha256").write_text("abc  world-1.tar.zst\n", encoding="utf-8")
            (source / "backups" / "MANIFEST.tsv").write_text("path\tsha256\n", encoding="utf-8")
            (source / "backups" / "temporary.part").write_bytes(b"excluded")

            manifest = archive.archive_sources(source, output)

            kinds = {entry["source_relpath"]: entry["source_kind"] for entry in manifest["files"]}
            self.assertEqual(kinds["ops/interventions.jsonl"], "supervisor_jsonl")
            self.assertEqual(kinds["ops/state.json"], "ops_metadata")
            self.assertEqual(kinds["ops/README.md"], "ops_metadata")
            self.assertEqual(kinds["logs/bot-runs/bot-run-1.log"], "runtime_log")
            self.assertEqual(kinds["backups/world-1.tar.zst"], "world_backup")
            self.assertEqual(kinds["backups/world-1.tar.zst.sha256"], "world_backup")
            self.assertEqual(kinds["backups/MANIFEST.tsv"], "world_backup")
            self.assertNotIn("logs/bot-runs/other.log", kinds)
            self.assertNotIn("backups/temporary.part", kinds)
            interventions = next(entry for entry in manifest["files"] if entry["source_relpath"] == "ops/interventions.jsonl")
            self.assertEqual(interventions["status"], "complete_prefix")

    def test_insufficient_capacity_fails_before_output_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            source.mkdir()
            self.make_source(source)

            with mock.patch.object(archive, "_capacity", return_value=(101, 100)):
                with self.assertRaisesRegex(archive.ArchiveError, "insufficient free space"):
                    archive.archive_sources(source, output)

            self.assertFalse(output.exists())

    def test_same_size_source_mutation_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            source.mkdir()
            (source / "logs" / "sessions").mkdir(parents=True)
            state = source / "logs" / "sessions" / "run.json"
            state.write_text('{"n":1}', encoding="utf-8")
            original = archive._copy_exact

            def mutate_after_copy(*args, **kwargs):
                result = original(*args, **kwargs)
                state.write_text('{"n":2}', encoding="utf-8")
                return result

            with mock.patch.object(archive, "_copy_exact", side_effect=mutate_after_copy):
                with self.assertRaisesRegex(archive.ArchiveError, "changed"):
                    archive.archive_sources(source, output)

            self.assertFalse(output.exists())

    def test_atomic_json_and_compressed_server_log_verify_with_null_cutoff(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            (source / "logs").mkdir(parents=True)
            (source / "server" / "logs").mkdir(parents=True)
            (source / "logs" / "state.json").write_text('{"ok":true}', encoding="utf-8")
            (source / "server" / "logs" / "old.log.gz").write_bytes(b"compressed bytes")

            manifest = archive.archive_sources(source, output)

            records = {entry["source_relpath"]: entry for entry in manifest["files"]}
            self.assertIsNone(records["logs/state.json"]["complete_line_cutoff"])
            self.assertIsNone(records["server/logs/old.log.gz"]["complete_line_cutoff"])
            self.assertEqual(manifest, archive.verify_manifest(output / "manifest.json"))

    def test_json_stream_parser_rejects_non_ascii_number_digits(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            (source / "logs" / "sessions").mkdir(parents=True)
            (source / "logs" / "sessions" / "bad.json").write_text(
                '{"n":1٢}', encoding="utf-8"
            )

            with self.assertRaisesRegex(archive.ArchiveError, "invalid JSON"):
                archive.archive_sources(source, output)

    def test_malformed_mutable_json_aborts_without_complete_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            source.mkdir()
            (source / "logs" / "sessions").mkdir(parents=True)
            (source / "logs" / "sessions" / "bad.json").write_text('{"unfinished":', encoding="utf-8")

            with self.assertRaisesRegex(archive.ArchiveError, "invalid JSON"):
                archive.archive_sources(source, output)

            self.assertFalse((output / "manifest.json").exists())

    def test_allowlisted_symlink_aborts_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            outside = base / "outside.jsonl"
            (source / "logs" / "trajectories").mkdir(parents=True)
            outside.write_text('{"secret":true}\n', encoding="utf-8")
            (source / "logs" / "trajectories" / "escape.jsonl").symlink_to(outside)

            with self.assertRaisesRegex(archive.ArchiveError, "symlink"):
                archive.archive_sources(source, output)

            self.assertFalse((output / "manifest.json").exists())

    def test_output_overlap_and_existing_root_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            self.make_source(source)

            with self.assertRaisesRegex(archive.ArchiveError, "overlap"):
                archive.archive_sources(source, source / "archive")

            output = Path(directory) / "existing"
            output.mkdir()
            marker = output / "marker"
            marker.write_text("keep", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                archive.archive_sources(source, output)
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_permission_denied_source_aborts_without_complete_manifest(self):
        if os.name != "posix" or os.geteuid() == 0:
            self.skipTest("POSIX non-root permission semantics required")
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            output = base / "archive"
            (source / "logs" / "trajectories").mkdir(parents=True)
            denied = source / "logs" / "trajectories" / "denied.jsonl"
            denied.write_text('{"n":1}\n', encoding="utf-8")
            denied.chmod(0)
            try:
                with self.assertRaises(PermissionError):
                    archive.archive_sources(source, output)
                self.assertFalse((output / "manifest.json").exists())
            finally:
                denied.chmod(0o600)


class CliTests(unittest.TestCase):
    def test_inventory_cli_rejects_output_inside_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            ArchiveSourcesTests().make_source(source)
            output = source / "inventory.json"

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                result = archive.main(
                    ["inventory", "--source-root", str(source), "--output", str(output)]
                )

            self.assertEqual(result, 2)
            self.assertFalse(output.exists())
            self.assertIn("overlap", stderr.getvalue())

    def test_inventory_capture_and_verify_cli_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            source.mkdir()
            ArchiveSourcesTests().make_source(source)
            inventory = base / "inventory.json"
            output = base / "archive"

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertEqual(
                    archive.main(
                        ["inventory", "--source-root", str(source), "--output", str(inventory)]
                    ),
                    0,
                )
                self.assertEqual(
                    archive.main(
                        ["capture", "--source-root", str(source), "--output-root", str(output)]
                    ),
                    0,
                )
                self.assertEqual(
                    archive.main(["verify", "--manifest", str(output / "manifest.json")]),
                    0,
                )

            inventory_data = json.loads(inventory.read_text(encoding="utf-8"))
            self.assertGreater(inventory_data["required_bytes"], 0)
            self.assertGreaterEqual(
                inventory_data["available_bytes"], inventory_data["required_bytes"]
            )
            cli_output = stdout.getvalue()
            self.assertIn("required_bytes=", cli_output)
            self.assertIn("verified=", cli_output)


class VerifyManifestTests(unittest.TestCase):
    def make_archive(self, base: Path):
        source = base / "source"
        output = base / "archive"
        source.mkdir()
        (source / "logs" / "trajectories").mkdir(parents=True)
        (source / "logs" / "trajectories" / "run.jsonl").write_bytes(b'{"n":1}\n')
        return output, archive.archive_sources(source, output)

    def test_corrupt_archived_file_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            output, manifest = self.make_archive(Path(directory))
            archived = output / manifest["files"][0]["archive_relpath"]
            archived.write_bytes(b"corrupt\n")

            with self.assertRaisesRegex(archive.ArchiveError, "hash|size"):
                archive.verify_manifest(output / "manifest.json")

    def test_traversal_in_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output, manifest = self.make_archive(Path(directory))
            manifest["files"][0]["archive_relpath"] = "../outside"
            (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(archive.ArchiveError, "relative|traversal"):
                archive.verify_manifest(output / "manifest.json")

    def test_boolean_schema_version_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output, manifest = self.make_archive(Path(directory))
            manifest["schema_version"] = True
            (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(archive.ArchiveError, "schema"):
                archive.verify_manifest(output / "manifest.json")

    def test_duplicate_json_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output, _ = self.make_archive(Path(directory))
            path = output / "manifest.json"
            raw = path.read_text(encoding="utf-8")
            raw = raw.replace(
                '"schema_version": 1',
                '"schema_version": 1, "schema_version": 1',
                1,
            )
            path.write_text(raw, encoding="utf-8")

            with self.assertRaisesRegex(archive.ArchiveError, "duplicate JSON key"):
                archive.verify_manifest(path)

    def test_nonportable_or_normalized_paths_are_rejected(self):
        bad_paths = ("files//source/run.jsonl", "files/./source/run.jsonl", "C:escape")
        for bad_path in bad_paths:
            with self.subTest(path=bad_path), tempfile.TemporaryDirectory() as directory:
                output, manifest = self.make_archive(Path(directory))
                manifest["files"][0]["archive_relpath"] = bad_path
                (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

                with self.assertRaisesRegex(archive.ArchiveError, "relative|traversal|portable"):
                    archive.verify_manifest(output / "manifest.json")

    def test_archive_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            output, manifest = self.make_archive(base)
            archived = output / manifest["files"][0]["archive_relpath"]
            outside = base / "outside"
            outside.write_bytes(archived.read_bytes())
            archived.unlink()
            archived.symlink_to(outside)

            with self.assertRaisesRegex(archive.ArchiveError, "symlink"):
                archive.verify_manifest(output / "manifest.json")

    def test_manifest_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output, _ = self.make_archive(Path(directory))
            manifest = output / "manifest.json"
            real = output / "real-manifest.json"
            manifest.replace(real)
            manifest.symlink_to(real)

            with self.assertRaisesRegex(archive.ArchiveError, "symlink"):
                archive.verify_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
