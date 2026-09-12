import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import run_export
from manifest import ManifestReader, verify_manifest


RUN_ID = "trial/a"


class RunExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.source = self.base / "source"
        self.payload_root = self.source / "payloads"
        self.event_file = self.source / "events" / "trial_a.jsonl"
        self.payload_root.mkdir(parents=True)
        self.event_file.parent.mkdir()
        self.events = []

    def tearDown(self):
        self.temporary.cleanup()

    def payload(self, value):
        data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        digest = hashlib.sha256(data).hexdigest()
        target = self.payload_root / digest[:2] / f"{digest}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return f"sha256:{digest}", target

    def add_event(self, kind, *, event_id, action_id=None, request_id=None, payload=None, run_id=RUN_ID):
        payload_ref, _ = self.payload(payload if payload is not None else {"kind": kind})
        self.events.append({
            "schemaVersion": 1,
            "eventId": event_id,
            "runId": run_id,
            "episodeId": f"{run_id}:Atlas",
            "botId": "Atlas",
            "sequence": len(self.events) + 1,
            "actionId": action_id,
            "requestId": request_id,
            "occurredAt": "2026-09-12T00:00:00.000Z",
            "monotonicMs": len(self.events) + 0.5,
            "kind": kind,
            "payloadRef": payload_ref,
        })
        return payload_ref

    def write_events(self, *, terminate=True):
        data = b"".join(json.dumps(event, separators=(",", ":")).encode() + b"\n" for event in self.events)
        if not terminate and data:
            data = data[:-1]
        self.event_file.write_bytes(data)
        return data

    def export(self, output=None, **overrides):
        options = {
            "event_file": self.event_file,
            "payload_root": self.payload_root,
            "output_root": output or self.base / "export",
            "run_id": RUN_ID,
            "scope": "closed_run",
            "closure_kind": "operator_assertion",
            "closure_reference": "ops/interventions.jsonl:1",
            "asserted_by": "test-operator",
            "max_shard_bytes": 900,
        }
        options.update(overrides)
        return run_export.export_run(**options)

    def test_exports_one_run_and_referenced_payloads_with_separate_completeness(self):
        start = self.add_event("action_started", event_id="event-start", action_id="action-a")
        self.add_event(
            "action_finished",
            event_id="event-finish",
            action_id="action-a",
            payload={"outcome": {"evidenceRefs": [start]}},
        )
        self.write_events()

        result = self.export()

        self.assertTrue(result["copy_complete"])
        self.assertFalse(result["episode_complete"])
        self.assertEqual(result["episode_completion_basis"], "not_independently_verified")
        self.assertEqual(result["audit"]["findings"], 0)
        summary = verify_manifest(self.base / "export" / "manifest.json")
        self.assertEqual(summary["files"], 4)  # event stream, two payloads, audit JSONL
        self.assertEqual(len(list(ManifestReader(self.base / "export" / "manifest.json").iter_files())), 4)

    def test_audits_missing_corrupt_unavailable_and_outside_run_references(self):
        missing = "sha256:" + "a" * 64
        outside, _ = self.payload({"outside": True})
        start = self.add_event("action_started", event_id="one", action_id="action-a")
        self.add_event(
            "action_finished",
            event_id="two",
            action_id="action-a",
            payload={"outcome": {"evidenceRefs": [start, outside, "unavailable:telemetry_incomplete"]}},
        )
        self.events.append({**self.events[-1], "eventId": "three", "sequence": 3, "payloadRef": missing})
        corrupt_ref, corrupt_path = self.payload({"corrupt": False})
        corrupt_path.write_bytes(b'{"corrupt":true}\n')
        self.events.append({**self.events[-1], "eventId": "four", "sequence": 4, "payloadRef": corrupt_ref})
        self.events.append({**self.events[-1], "eventId": "five", "sequence": 5,
                            "payloadRef": "unavailable:telemetry_incomplete"})
        self.write_events()

        result = self.export()

        counts = result["audit"]["by_kind"]
        self.assertEqual(counts["missing_payload"], 1)
        self.assertEqual(counts["corrupt_payload"], 1)
        self.assertEqual(counts["unavailable_payload_reference"], 1)
        self.assertEqual(counts["evidence_reference_outside_run"], 1)
        self.assertEqual(counts["unavailable_evidence_reference"], 1)
        corrupt_entries = [entry for entry in ManifestReader(self.base / "export" / "manifest.json").iter_files()
                           if entry.get("expected_sha256") and entry["expected_sha256"] != entry["sha256"]]
        self.assertEqual(len(corrupt_entries), 1)
        self.assertNotEqual(corrupt_entries[0]["sha256"], corrupt_entries[0]["expected_sha256"])

    def test_audits_incomplete_tail_duplicate_ids_and_unmatched_action_and_request(self):
        self.add_event("action_started", event_id="duplicate", action_id="action-a")
        self.add_event("action_started", event_id="duplicate", action_id="action-a")
        self.add_event("action_finished", event_id="finish-1", action_id="action-a")
        self.add_event("action_finished", event_id="finish-2", action_id="action-a")
        self.add_event("model_request", event_id="request-1", request_id="request-a")
        self.add_event("model_request", event_id="request-2", request_id="request-a")
        self.add_event("observation", event_id="incomplete-tail")
        self.write_events(terminate=False)

        result = self.export(scope="observed_prefix", closure_kind="offline_snapshot",
                             closure_reference="capture-provenance.json:sha256:test", asserted_by="snapshot-tool")

        counts = result["audit"]["by_kind"]
        self.assertEqual(counts["incomplete_event_tail"], 1)
        self.assertEqual(counts["duplicate_event_id"], 1)
        self.assertEqual(counts["duplicate_action_start"], 1)
        self.assertEqual(counts["duplicate_action_terminal"], 1)
        self.assertEqual(counts["duplicate_model_request"], 1)
        self.assertEqual(counts["unmatched_model_request"], 1)
        self.assertFalse(result["run_closed"])
        self.assertTrue(result["censored"])

    def test_unused_blobs_are_audited_but_not_copied(self):
        self.add_event("observation", event_id="event-one")
        _, unused_path = self.payload({"unused": True})
        self.write_events()
        result = self.export()
        self.assertEqual(result["audit"]["by_kind"]["unused_payload"], 1)
        entries = list(ManifestReader(self.base / "export" / "manifest.json").iter_files())
        self.assertFalse(any(entry["source_relpath"].endswith(unused_path.name) for entry in entries))

    def test_mismatched_event_run_id_is_audited_and_never_silently_reassigned(self):
        self.add_event("observation", event_id="event-one", run_id="other-run")
        self.write_events()
        result = self.export()
        self.assertEqual(result["audit"]["by_kind"]["event_outside_run"], 1)
        self.assertEqual(result["totals"]["events"], 0)

    def test_invalid_typed_event_fields_are_audited_instead_of_treated_as_clean(self):
        self.add_event("observation", event_id="base")
        base = self.events.pop()
        variants = [
            {**base, "eventId": "bad-version", "schemaVersion": 2},
            {**base, "eventId": "bad-kind", "kind": "invented"},
            {**base, "eventId": "bad-sequence", "sequence": True},
            {**base, "eventId": "bad-bot", "botId": ""},
            {**base, "eventId": "bad-time", "occurredAt": "yesterday"},
            {**base, "eventId": "bad-action", "kind": "action_started", "actionId": None},
            {**base, "eventId": "bad-request", "kind": "model_request", "requestId": None},
        ]
        self.events.extend(variants)
        self.write_events()

        result = self.export()

        self.assertEqual(result["totals"]["events"], 0)
        self.assertEqual(result["audit"]["by_kind"]["invalid_event_schema"], len(variants))

    def test_deep_payload_json_is_audited_without_aborting_raw_capture(self):
        deep = b"[" * 10000 + b"0" + b"]" * 10000 + b"\n"
        digest = hashlib.sha256(deep).hexdigest()
        target = self.payload_root / digest[:2] / f"{digest}.json"
        target.parent.mkdir(parents=True)
        target.write_bytes(deep)
        self.add_event("observation", event_id="deep-payload")
        self.events[-1]["payloadRef"] = f"sha256:{digest}"
        self.write_events()

        result = self.export()

        self.assertEqual(result["audit"]["by_kind"]["payload_json_unreadable"], 1)
        self.assertTrue((self.base / "export" / "files" / "payloads" / digest[:2] / f"{digest}.json").is_file())

    def test_deep_event_json_is_audited_without_aborting_raw_capture(self):
        deep = b"[" * 10000 + b"0" + b"]" * 10000 + b"\n"
        self.event_file.write_bytes(deep)

        result = self.export()

        self.assertEqual(result["totals"]["events"], 0)
        self.assertEqual(result["audit"]["by_kind"]["malformed_event"], 1)
        self.assertEqual((self.base / "export" / "files" / "events" / self.event_file.name).read_bytes(), deep)

    def test_capacity_preflight_happens_before_output_creation(self):
        self.add_event("observation", event_id="event-one")
        self.write_events()
        output = self.base / "no-capacity"
        with mock.patch.object(run_export, "storage_capacity", return_value={
            "free_bytes": 1, "free_inodes": 1, "total_bytes": 1, "total_inodes": 1
        }):
            with self.assertRaisesRegex(run_export.ExportError, "capacity"):
                self.export(output=output)
        self.assertFalse(output.exists())

    def test_manifest_root_budget_is_enforced_before_output_creation(self):
        for number in range(30):
            self.add_event("observation", event_id=f"event-{number}", payload={"number": number})
        self.write_events()
        output = self.base / "too-many-shards"

        with mock.patch.object(run_export, "MAX_V2_ROOT_BYTES", 2048):
            with self.assertRaisesRegex(run_export.ExportError, "root budget"):
                self.export(output=output, max_shard_bytes=512)

        self.assertFalse(output.exists())

    def test_existing_output_and_source_overlap_are_rejected_without_changes(self):
        self.add_event("observation", event_id="event-one")
        source_bytes = self.write_events()
        output = self.base / "existing"
        output.mkdir()
        (output / "keep").write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            self.export(output=output)
        with self.assertRaisesRegex(run_export.ExportError, "overlap"):
            self.export(output=self.source / "nested-output")
        self.assertEqual(self.event_file.read_bytes(), source_bytes)
        self.assertEqual((output / "keep").read_text(), "keep")

    def test_source_mutation_aborts_without_a_final_manifest(self):
        self.add_event("observation", event_id="event-one")
        self.write_events()
        output = self.base / "mutated"
        original = run_export.copy_regular

        def mutate(*args, **kwargs):
            result = original(*args, **kwargs)
            self.event_file.write_bytes(self.event_file.read_bytes() + b"{}\n")
            return result

        with mock.patch.object(run_export, "copy_regular", side_effect=mutate):
            with self.assertRaisesRegex(run_export.ExportError, "changed"):
                self.export(output=output)
        self.assertFalse((output / "manifest.json").exists())

    def test_closure_provenance_is_required_and_age_is_not_an_option(self):
        self.add_event("observation", event_id="event-one")
        self.write_events()
        with self.assertRaisesRegex(run_export.ExportError, "closure"):
            self.export(closure_reference="")
        with self.assertRaisesRegex(run_export.ExportError, "scope"):
            self.export(scope="old_enough")

    def test_read_only_report_exposes_growth_capacity_and_explicit_warnings(self):
        self.add_event("observation", event_id="event-one")
        self.write_events()
        first = self.export(output=self.base / "first")
        self.add_event("observation", event_id="event-two")
        self.write_events()
        second = self.export(output=self.base / "second")

        report = run_export.storage_report(
            self.base / "second" / "manifest.json",
            previous_manifest=self.base / "first" / "manifest.json",
            warn_free_bytes=10**30,
            warn_free_inodes=10**30,
        )
        self.assertEqual(report["growth"]["events"], second["totals"]["events"] - first["totals"]["events"])
        self.assertGreater(report["growth"]["captured_bytes"], 0)
        self.assertEqual(set(report["warnings"]), {"free_bytes_below_threshold", "free_inodes_below_threshold"})

    def test_growth_report_rejects_a_different_run(self):
        self.add_event("observation", event_id="event-one")
        self.write_events()
        self.export(output=self.base / "first")
        for event in self.events:
            event["runId"] = "another-run"
            event["episodeId"] = "another-run:Atlas"
        self.write_events()
        self.export(output=self.base / "second", run_id="another-run")

        with self.assertRaisesRegex(run_export.ExportError, "same run ID"):
            run_export.storage_report(
                self.base / "second" / "manifest.json",
                previous_manifest=self.base / "first" / "manifest.json",
            )


class RunExportCliTests(unittest.TestCase):
    def test_stress_preflight_happens_before_synthetic_source_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stress"
            with mock.patch.object(run_export, "storage_capacity", return_value={
                "free_bytes": 1,
                "free_inodes": 1,
                "total_bytes": 1,
                "total_inodes": 1,
                "fragment_bytes": 4096,
            }):
                with self.assertRaisesRegex(run_export.ExportError, "synthetic stress"):
                    run_export._stress(output, 30, 900, 0, 0)
            self.assertFalse(output.exists())

    def test_stress_command_builds_and_verifies_a_small_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "stress"
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                status = run_export.main(["stress", "--output-root", str(output), "--payload-count", "30",
                                          "--max-shard-bytes", "900"])
            self.assertEqual(status, 0)
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["payloads"], 30)
            self.assertGreater(result["shards"], 1)
            self.assertEqual(verify_manifest(output / "manifest.json")["schema_version"], 2)


if __name__ == "__main__":
    unittest.main()
