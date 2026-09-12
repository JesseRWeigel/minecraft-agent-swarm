import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from index import build_index, sample_candidates
import review
from review import compare_reviews, create_scaffold, extract_packet, validate_reviews


def trajectory_row(i, bot="Atlas"):
    return {
        "bot": bot,
        "timestamp": f"2026-08-{(i % 28) + 1:02d}T01:02:03Z",
        "system": "system prompt",
        "context": (
            f"Position: {i}, 64, {i + 1}\n"
            "Health: 20, Hunger: 18\n"
            f"Inventory: oak_log x{i}\n"
            "CURRENT GOAL: collect food\n"
            "LAST 5 ACTIONS: ✓ mine succeeded, ✗ move failed\n"
            "Recent result: success=true"
        ),
        "decision": {
            "thought": f"thought {i}",
            "action": "eat" if i % 2 else "explore",
            "params": {"slot": i},
            "goal": "collect food",
        },
        "result": f"executor report {i}",
        "success": bool(i % 2),
    }


class ReviewToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.archive = self.root / "archive"
        self.archive.mkdir()
        self.source = self.archive / "trajectory.jsonl"
        self.manifest = self.archive / "manifest.json"
        self.index = self.root / "index.sqlite"
        self.queue = self.root / "candidates.json"
        self.rubric = self.root / "rubric.md"
        self.rubric.write_text("# Frozen review rubric\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def build_fixture(self, count=24):
        data = b"".join(
            json.dumps(trajectory_row(i), sort_keys=True).encode("utf-8") + b"\n"
            for i in range(1, count + 1)
        )
        self.source.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        item = {
            "source_relpath": "logs/trajectories/session.jsonl",
            "archive_relpath": "trajectory.jsonl",
            "source_kind": "trajectory_jsonl",
            "sha256": digest,
            "captured_bytes": len(data),
            "source_size_at_open": len(data),
            "complete_line_cutoff": len(data),
            "status": "complete",
        }
        self.manifest.write_text(json.dumps({
            "schema_version": 1,
            "complete": True,
            "captured_at_utc": "2026-09-12T00:00:00Z",
            "source_root": "/private/source",
            "files": [item],
        }, sort_keys=True), encoding="utf-8")
        build_index(self.manifest, self.index)
        candidates = sample_candidates(self.index, count, "review-test")
        self.queue.write_text(json.dumps({
            "schema_version": 1,
            "seed": "review-test",
            "candidates": candidates,
        }, sort_keys=True), encoding="utf-8")
        return candidates

    def extract(self, start_rank=1, limit=3, output=None):
        return extract_packet(
            manifest_path=self.manifest,
            index_path=self.index,
            candidate_path=self.queue,
            rubric_path=self.rubric,
            output_path=output or self.root / "packet.json",
            start_rank=start_rank,
            limit=limit,
        )

    def test_extract_is_deterministic_blinded_and_provenance_bound(self):
        candidates = self.build_fixture()
        packet_a = self.extract(output=self.root / "packet-a.json")
        packet_b = self.extract(output=self.root / "packet-b.json")
        self.assertEqual(packet_a, packet_b)
        self.assertEqual(packet_a["schema_version"], 2)
        self.assertEqual(len(packet_a["candidates"]), 3)
        for name in ("rubric_sha256", "instructions_sha256", "review_schema_sha256", "continuation_protocol_sha256", "tool_source_sha256"):
            self.assertRegex(packet_a["protocol"][name], r"^[a-f0-9]{64}$")
        self.assertEqual(
            packet_a["protocol"]["tool_source_sha256"],
            hashlib.sha256(Path(review.__file__).read_bytes()).hexdigest(),
        )
        for name in ("manifest_sha256", "index_sha256", "candidate_queue_sha256"):
            self.assertRegex(packet_a["provenance"][name], r"^[a-f0-9]{64}$")
        self.assertEqual(packet_a["candidates"][0]["record_id"], candidates[0]["record_id"])
        serialized = json.dumps(packet_a)
        self.assertNotIn('"revised_status"', serialized)
        self.assertNotIn('"original_success"', serialized)
        for candidate in packet_a["candidates"]:
            for line in candidate["evidence_lines"]:
                record = line.get("record")
                if record is not None:
                    self.assertNotIn("success", record)
                    self.assertEqual(set(record), {
                        "bot", "timestamp", "context_projection", "context_projection_truncated", "context_sha256", "decision", "result", "result_sha256", "result_truncated", "system_prompt_sha256"
                    })
                    projection = "\n".join(item["text"] for item in record["context_projection"])
                    self.assertIn("Position:", projection)
                    self.assertNotIn("LAST 5 ACTIONS", projection)
                    self.assertNotIn("✓", projection)
                    self.assertNotIn("✗", projection)
                    self.assertNotIn("success=true", projection)

    def test_schema_identity_covers_required_fields_and_tool_source(self):
        self.build_fixture()
        packet = self.extract(limit=1)
        changed = copy.deepcopy(packet["review_schema"])
        changed["item_fields"].append("new_required_field")
        self.assertNotEqual(
            review._hash_value(packet["review_schema"]), review._hash_value(changed)
        )

        tampered = copy.deepcopy(packet)
        tampered["protocol"]["tool_source_sha256"] = "0" * 64
        tampered["packet_sha256"] = review._hash_value({**tampered, "packet_sha256": ""})
        tampered_path = self.root / "tampered-packet.json"
        tampered_path.write_text(json.dumps(tampered), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "tool source"):
            create_scaffold(tampered_path, "reviewer-a", "model-a", self.root / "bad.json")

    def test_extract_skips_windows_overlapping_earlier_candidates(self):
        candidates = self.build_fixture(18)
        by_line = {item["line_no"]: item for item in candidates}
        ordered = [by_line[5], by_line[6], by_line[15]]
        self.queue.write_text(json.dumps({
            "schema_version": 1, "seed": "review-test", "candidates": ordered,
        }, sort_keys=True), encoding="utf-8")
        packet = self.extract(start_rank=2, limit=1)
        self.assertEqual(packet["candidates"][0]["candidate_rank"], 3)
        self.assertEqual(packet["candidates"][0]["line_no"], 15)

    def test_extract_rejects_candidate_tampering_and_existing_output(self):
        self.build_fixture()
        doc = json.loads(self.queue.read_text(encoding="utf-8"))
        doc["candidates"][0]["bot"] = "Forged"
        self.queue.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "candidate.*index|index.*candidate"):
            self.extract()
        existing = self.root / "existing.json"
        existing.write_text("preserve", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            self.extract(output=existing)
        self.assertEqual(existing.read_text(encoding="utf-8"), "preserve")

    def valid_review_document(self, packet):
        reviews = []
        for candidate in packet["candidates"]:
            citation = {
                "id": "c1",
                "source_relpath": candidate["source_relpath"],
                "start_line": candidate["line_no"],
                "end_line": candidate["line_no"],
            }
            reviews.append({
                "record_id": candidate["record_id"],
                "review_number": candidate["review_number"],
                "reviewer": "reviewer-a",
                "model": "local-review-model",
                "reviewed_at_utc": "2026-09-12T18:00:00Z",
                "label_version": "historical-review-v2",
                "evidence_quality": "reviewed",
                "disposition": "development_only",
                "provenance": {
                    "packet_sha256": packet["packet_sha256"],
                    "manifest_sha256": packet["provenance"]["manifest_sha256"],
                    "index_sha256": packet["provenance"]["index_sha256"],
                    "candidate_queue_sha256": packet["provenance"]["candidate_queue_sha256"],
                    "source_relpath": candidate["source_relpath"],
                    "source_sha256": candidate["source_sha256"],
                    "line_no": candidate["line_no"],
                },
                "extension_reads": [],
                "citations": [citation],
                "executor_reported": {
                    "status": "unknown",
                    "summary": "The result is a report without independent verification.",
                    "citation_ids": ["c1"],
                },
                "precondition": {
                    "observation": "ambiguous",
                    "summary": "The prior state is incomplete.",
                    "citation_ids": ["c1"],
                },
                "postcondition": {
                    "observation": "not_observed",
                    "summary": "No independent postcondition is present.",
                    "citation_ids": [],
                },
                "attribution": {
                    "confidence": "unknown",
                    "attributable_outcome": "unknown",
                    "rationale": "The executor report alone cannot establish causation.",
                    "citation_ids": ["c1"],
                },
                "mission": {
                    "predicate": "collect food",
                    "progress": "unknown",
                    "already_satisfied_before_action": None,
                    "rationale": "The mission postcondition is not independently observed.",
                    "citation_ids": ["c1"],
                },
                "insufficient_evidence_reasons": ["missing_postcondition"],
                "terminal_or_censoring_note": "Continuation does not establish a terminal postcondition.",
                "privacy_flags": [],
                "shared_world_group": None,
            })
        return {
            "schema_version": 2,
            "packet_sha256": packet["packet_sha256"],
            "protocol": copy.deepcopy(packet["protocol"]),
            "reviews": reviews,
        }

    def write_review(self, packet, name="review.json"):
        path = self.root / name
        path.write_text(json.dumps(self.valid_review_document(packet)), encoding="utf-8")
        return path

    def test_validate_accepts_strict_complete_review(self):
        self.build_fixture()
        packet = self.extract()
        summary = validate_reviews(self.root / "packet.json", self.write_review(packet))
        self.assertEqual(summary, {"records": 3, "schema_version": 2, "status": "valid"})

    def test_validate_rejects_missing_provenance_promotions_and_preexisting_credit(self):
        self.build_fixture()
        packet = self.extract()
        cases = []
        review = self.valid_review_document(packet)
        del review["reviews"][0]["provenance"]["source_sha256"]
        cases.append((review, "provenance"))
        review = self.valid_review_document(packet)
        review["reviews"][0]["evidence_quality"] = "verified"
        cases.append((review, "evidence_quality|verified"))
        review = self.valid_review_document(packet)
        review["reviews"][0]["gold"] = True
        cases.append((review, "unexpected|gold"))
        review = self.valid_review_document(packet)
        review["reviews"][0]["mission"].update({
            "progress": "achieved", "already_satisfied_before_action": True
        })
        cases.append((review, "already satisfied|pre-existing"))
        for number, (document, pattern) in enumerate(cases):
            path = self.root / f"invalid-{number}.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, pattern):
                validate_reviews(self.root / "packet.json", path)

    def test_validate_rejects_forced_known_outcome_without_postcondition(self):
        self.build_fixture()
        packet = self.extract()
        review = self.valid_review_document(packet)
        review["reviews"][0]["attribution"].update({
            "confidence": "high", "attributable_outcome": "succeeded"
        })
        review["reviews"][0]["insufficient_evidence_reasons"] = []
        path = self.root / "forced.json"
        path.write_text(json.dumps(review), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "postcondition"):
            validate_reviews(self.root / "packet.json", path)

    def test_validate_enforces_coverage_citations_and_extension_reads(self):
        self.build_fixture()
        packet = self.extract()
        review = self.valid_review_document(packet)
        review["reviews"].pop()
        missing = self.root / "missing-coverage.json"
        missing.write_text(json.dumps(review), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "coverage"):
            validate_reviews(self.root / "packet.json", missing)
        review = self.valid_review_document(packet)
        candidate = packet["candidates"][0]
        segment = candidate["extension_segments"][0]
        review["reviews"][0]["citations"][0].update({
            "start_line": segment["start_line"], "end_line": segment["start_line"]
        })
        unread = self.root / "unread-extension.json"
        unread.write_text(json.dumps(review), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "extension"):
            validate_reviews(self.root / "packet.json", unread)
        review["reviews"][0]["extension_reads"] = [segment["segment_id"]]
        unread.write_text(json.dumps(review), encoding="utf-8")
        self.assertEqual(validate_reviews(self.root / "packet.json", unread)["status"], "valid")

    def test_compare_reports_raw_per_status_and_abstention_without_adjudication(self):
        self.build_fixture()
        packet = self.extract(limit=2)
        review_a = self.valid_review_document(packet)
        review_b = self.valid_review_document(packet)
        for item in review_b["reviews"]:
            item["reviewer"] = "reviewer-b"
            item["model"] = "other-local-model"
        review_b["reviews"][0]["executor_reported"]["status"] = "failed"
        path_a, path_b = self.root / "a.json", self.root / "b.json"
        path_a.write_text(json.dumps(review_a), encoding="utf-8")
        path_b.write_text(json.dumps(review_b), encoding="utf-8")
        output = self.root / "comparison.json"
        comparison = compare_reviews(self.root / "packet.json", path_a, path_b, output)
        self.assertEqual(comparison["candidate_count"], 2)
        metric = comparison["agreement"]["executor_reported"]
        self.assertEqual(metric["raw_agreement_count"], 1)
        self.assertEqual(metric["either_abstained_count"], 2)
        self.assertEqual(metric["reviewer_a_abstention_rate"], 1.0)
        self.assertEqual(metric["reviewer_b_abstention_rate"], 0.5)
        self.assertEqual(metric["either_abstained_rate"], 1.0)
        self.assertEqual(metric["both_abstained_rate"], 0.5)
        self.assertIn("unknown", metric["per_status"])
        self.assertEqual(comparison["adjudication"], {
            "included": False, "status": "separate_required"
        })
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), comparison)
        with self.assertRaises(FileExistsError):
            compare_reviews(self.root / "packet.json", path_a, path_b, output)


    def test_scaffold_prefills_identity_and_provenance_but_not_judgments(self):
        self.build_fixture()
        packet = self.extract(limit=1)
        scaffold_path = self.root / "scaffold.json"
        scaffold = create_scaffold(
            self.root / "packet.json", "reviewer-a", "local-model", scaffold_path
        )
        item = scaffold["reviews"][0]
        self.assertEqual(item["reviewer"], "reviewer-a")
        self.assertEqual(item["provenance"]["packet_sha256"], packet["packet_sha256"])
        self.assertIsNone(item["reviewed_at_utc"])
        self.assertIsNone(item["executor_reported"]["status"])
        self.assertIsNone(item["attribution"]["attributable_outcome"])
        with self.assertRaisesRegex(ValueError, "reviewed_at_utc|invalid value"):
            validate_reviews(self.root / "packet.json", scaffold_path)

    def test_validate_rejects_boolean_identity_and_uncited_known_claim(self):
        self.build_fixture()
        packet = self.extract(limit=1)
        review = self.valid_review_document(packet)
        review["reviews"][0]["review_number"] = True
        bool_path = self.root / "bool.json"
        bool_path.write_text(json.dumps(review), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "review_number"):
            validate_reviews(self.root / "packet.json", bool_path)

        review = self.valid_review_document(packet)
        review["reviews"][0]["executor_reported"] = {
            "status": "failed",
            "summary": "The executor explicitly reported failure.",
            "citation_ids": [],
        }
        uncited_path = self.root / "uncited.json"
        uncited_path.write_text(json.dumps(review), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "citation"):
            validate_reviews(self.root / "packet.json", uncited_path)

    def test_validate_requires_citation_for_stated_mission_predicate(self):
        self.build_fixture()
        packet = self.extract(limit=1)
        document = self.valid_review_document(packet)
        document["reviews"][0]["mission"]["citation_ids"] = []
        path = self.root / "uncited-mission.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "mission.*citation"):
            validate_reviews(self.root / "packet.json", path)

    def test_validate_rejects_unbounded_citation_and_unqualified_world_group(self):
        self.build_fixture()
        packet = self.extract(limit=1)
        document = self.valid_review_document(packet)
        document["reviews"][0]["citations"][0]["end_line"] = 1_000_000_000
        path = self.root / "huge-citation.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "citation span"):
            validate_reviews(self.root / "packet.json", path)

        document = self.valid_review_document(packet)
        document["reviews"][0]["shared_world_group"] = "campaign-one"
        path = self.root / "unqualified-group.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "derived:"):
            validate_reviews(self.root / "packet.json", path)

    def test_vacuous_unknown_agreement_never_marks_bulk_ready(self):
        self.build_fixture()
        packet = self.extract(limit=1)
        review_a = self.valid_review_document(packet)
        review_b = self.valid_review_document(packet)
        review_b["reviews"][0]["reviewer"] = "reviewer-b"
        left = self.root / "unknown-a.json"
        right = self.root / "unknown-b.json"
        left.write_text(json.dumps(review_a), encoding="utf-8")
        right.write_text(json.dumps(review_b), encoding="utf-8")
        result = compare_reviews(
            self.root / "packet.json", left, right, self.root / "unknown-comparison.json"
        )
        self.assertTrue(result["primary_gate"]["calibration_agreement_pass"])
        self.assertTrue(result["primary_gate"]["vacuous_all_abstained"])
        self.assertEqual(result["primary_gate"]["informative_coverage_rate"], 0)
        self.assertFalse(result["primary_gate"]["bulk_labeling_ready"])


if __name__ == "__main__":
    unittest.main()
