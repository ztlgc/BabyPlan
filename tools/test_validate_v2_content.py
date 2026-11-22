"""v2 内容校验器的语义、发布门禁与 CLI 回归测试；所有审核记录均为测试夹具。"""

from __future__ import annotations

import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_v2_content import (  # noqa: E402
    ROOT, SCHEMA_PATH, ValidatorConfigurationError, canonical_card_hash, load_json,
    validate_content, validate_evidence_registry, validate_publication_evidence,
)


PACKAGE_PATH = ROOT / "content/candidate/babyplan-18-23-v2.json"
SCRIPT_PATH = ROOT / "tools/validate_v2_content.py"


def candidate():
    return load_json(PACKAGE_PATH)


def evidence(card, kind="editorial_review", *, independent=False, environment="private_trial"):
    """合成测试记录；不写入生产台账，也不表示真实审读或试玩。"""
    record = {
        "id": f"TEST-ONLY-{kind}-{card['id']}", "kind": kind, "cardId": card["id"],
        "revision": card["revision"], "contentHash": canonical_card_hash(card),
        "actorId": "TEST-ONLY-reviewer" if independent else "TEST-ONLY-author",
        "actorKind": "human", "createdAt": "2026-11-13T10:00:00+08:00",
        "decision": "approved", "evidenceRef": "test-fixture:NOT-A-REAL-REVIEW",
    }
    if kind == "editorial_review":
        record.update(authorId="TEST-ONLY-author", selfReviewed=not independent,
                      checks=["sources", "age_safety", "language", "rights"])
    elif kind == "expert_review":
        record.update(authorId="TEST-ONLY-author", selfReviewed=not independent,
                      qualificationRef="test-fixture:NOT-A-REAL-QUALIFICATION")
    elif kind == "family_trial":
        record["completedAt"] = "2026-11-12T18:00:00+08:00"
    elif kind == "rights_license":
        record.update(authorizationRef="test-fixture:NOT-A-REAL-LICENSE", scope="仅测试夹具",
                      allowedEnvironments=[environment])
    return record


def release_fixture(environment="private_trial", *, expert=False, licensed=False):
    package = candidate()
    package.update(channel="release", publicationEnvironment=environment, evidenceRefs=[])
    package["review"] = {"editorial": "approved", "expert": "reviewed" if expert else "not_reviewed",
                         "familyTrial": "completed" if environment == "public" else "not_started"}
    if licensed:
        package["cards"][0]["rights"] = "licensed"
    records = []
    for card in package["cards"]:
        card["reviewState"] = "reviewed"
        records.append(evidence(card, independent=environment == "public"))
        if environment == "public":
            records.append(evidence(card, "family_trial"))
        if expert:
            records.append(evidence(card, "expert_review", independent=True))
        if card["rights"] == "licensed":
            records.append(evidence(card, "rights_license", environment=environment))
    package["evidenceRefs"] = [record["id"] for record in records]
    return package, {"schemaVersion": 1, "records": records}


class ContentSemanticsTests(unittest.TestCase):
    def assert_code(self, package, code, **kwargs):
        issues = validate_content(package, **kwargs)
        self.assertIn(code, {issue.code for issue in issues}, issues)
        return issues

    def test_current_candidate_passes_without_mutating_input(self):
        package = candidate()
        original = copy.deepcopy(package)
        self.assertEqual([], validate_content(package))
        self.assertEqual(original, package)

    def test_malformed_structures_return_paths_instead_of_crashing(self):
        cases = [None, [], {}, {**candidate(), "cards": None}, {**candidate(), "cards": [{}]}]
        for package in cases:
            with self.subTest(value=type(package).__name__):
                issues = validate_content(package)
                self.assertTrue(issues)
                self.assertTrue(all(issue.path.startswith("/") for issue in issues))
        package = candidate()
        del package["cards"]
        self.assertIn("/cards", {issue.path for issue in validate_content(package)})

    def test_duplicate_collection_identifiers(self):
        for collection in ("ageBands", "sources", "cards", "books"):
            package = candidate()
            package[collection][-1] = copy.deepcopy(package[collection][0])
            with self.subTest(collection=collection):
                self.assert_code(package, "DUPLICATE_ID")

    def test_age_range_must_match_stable_band_id(self):
        package = candidate()
        package["ageBands"][0]["minMonths"] = 17
        self.assert_code(package, "AGE_RANGE_MISMATCH")

    def test_missing_source_and_band_definitions(self):
        package = candidate()
        package["sources"] = package["sources"][1:]
        self.assert_code(package, "UNKNOWN_SOURCE")
        package = candidate()
        package["ageBands"] = package["ageBands"][1:]
        self.assert_code(package, "UNKNOWN_AGE_BAND")

    def test_repeated_source_reference(self):
        package = candidate()
        package["cards"][0]["sourceIds"].append("CDC18")
        self.assert_code(package, "DUPLICATE_REFERENCE")

    def test_blank_safety_is_not_a_valid_instruction(self):
        package = candidate()
        package["cards"][0]["safety"] = " \n\t "
        self.assert_code(package, "EMPTY_TEXT")

    def test_missing_plan_card(self):
        package = candidate()
        package["week"]["days"][0]["items"][0]["cardId"] = "absent"
        self.assert_code(package, "UNKNOWN_CARD")

    def test_mismatched_card_kind_and_age(self):
        package = candidate()
        package["cards"][0]["kind"] = "english"
        self.assert_code(package, "CARD_KIND_MISMATCH")
        package = candidate()
        package["cards"][0]["ageBands"] = ["m24_29"]
        self.assert_code(package, "CARD_AGE_MISMATCH")

    def test_withdrawal_blocks_week_and_stage_recommendations(self):
        package = candidate()
        package["cards"][0]["withdrawn"] = True
        issues = self.assert_code(package, "WITHDRAWN_CARD_SELECTED")
        self.assertTrue(any(issue.path.startswith("/stageGuides") for issue in issues))

    def test_duplicate_day_or_item_is_rejected(self):
        package = candidate()
        package["week"]["days"][1]["day"] = 1
        self.assert_code(package, "WEEK_DAY_SEQUENCE")
        package = candidate()
        package["week"]["days"][1]["items"][0]["id"] = package["week"]["days"][0]["items"][0]["id"]
        self.assert_code(package, "DUPLICATE_ID")

    def test_budget_and_slot_allocation(self):
        package = candidate()
        package["week"]["days"][0]["items"][0]["minutes"] = 14
        self.assert_code(package, "DAILY_BUDGET_MISMATCH")
        package = candidate()
        # 总预算和分段仍然正确，但运动与探索的槽位预算被交换。
        package["week"]["days"][0]["items"][0]["minutes"] = 10
        package["week"]["days"][0]["items"][1]["minutes"] = 15
        self.assert_code(package, "SLOT_ALLOCATION_MISMATCH")

    def test_stage_month_and_source_id_must_match(self):
        package = candidate()
        package["stageGuides"][0]["sourceAgeMonths"] = 36
        self.assert_code(package, "SOURCE_NODE_MISMATCH")
        package = candidate()
        package["stageGuides"][0]["sourceId"] = "CDC36"
        self.assert_code(package, "SOURCE_NODE_MISMATCH")

    def test_stage_duplicate_and_cross_age_reference(self):
        package = candidate()
        package["stageGuides"].append(copy.deepcopy(package["stageGuides"][0]))
        self.assert_code(package, "DUPLICATE_STAGE_GUIDE")
        package = candidate()
        package["stageGuides"][1]["focuses"][0]["cardIds"] = ["roll"]
        self.assert_code(package, "GUIDE_CARD_AGE_MISMATCH")

    def test_later_stages_can_have_no_cards(self):
        self.assertTrue(all(not focus["cardIds"] for guide in candidate()["stageGuides"][1:] for focus in guide["focuses"]))
        self.assertEqual([], validate_content(candidate()))

    def test_licensed_candidate_needs_bound_authorization(self):
        package = candidate()
        package["cards"][0]["rights"] = "licensed"
        self.assert_code(package, "LICENSE_EVIDENCE_REQUIRED")
        registry = {"schemaVersion": 1, "records": [evidence(package["cards"][0], "rights_license")]}
        self.assertEqual([], validate_content(package, evidence_registry=registry))
        registry["records"][0]["contentHash"] = "0" * 64
        self.assert_code(package, "LICENSE_EVIDENCE_REQUIRED", evidence_registry=registry)

    def test_candidate_cannot_pass_release_mode(self):
        self.assert_code(candidate(), "RELEASE_REQUIRED", require_release=True)

    def test_remote_schema_reference_is_refused_without_fetching(self):
        with self.assertRaises(ValidatorConfigurationError):
            validate_content(candidate(), schema={"$ref": "https://example.invalid/schema.json"})


class PublicationEvidenceTests(unittest.TestCase):
    def assert_code(self, package, registry, code):
        issues = validate_publication_evidence(package, registry)
        self.assertIn(code, {issue.code for issue in issues}, issues)

    def test_private_self_review_does_not_require_expert_or_completed_trial(self):
        package, registry = release_fixture()
        original = copy.deepcopy((package, registry))
        self.assertEqual([], validate_publication_evidence(package, registry))
        self.assertEqual(original, (package, registry))

    def test_public_independent_review_and_completed_trial_without_expert_claim(self):
        package, registry = release_fixture("public")
        self.assertEqual([], validate_publication_evidence(package, registry))
        self.assertEqual("not_reviewed", package["review"]["expert"])

    def test_public_self_review_is_rejected(self):
        package, registry = release_fixture("public")
        record = registry["records"][0]
        record.update(actorId=record["authorId"], selfReviewed=True)
        self.assert_code(package, registry, "INDEPENDENT_REVIEW_REQUIRED")

    def test_declared_completed_trial_needs_per_card_evidence(self):
        package, registry = release_fixture()
        package["review"]["familyTrial"] = "completed"
        self.assert_code(package, registry, "FAMILY_TRIAL_EVIDENCE_REQUIRED")

    def test_public_requires_completed_trial_status(self):
        package, registry = release_fixture("public")
        package["review"]["familyTrial"] = "not_started"
        self.assert_code(package, registry, "FAMILY_TRIAL_REQUIRED")

    def test_expert_claim_needs_evidence_but_valid_fixture_passes(self):
        package, registry = release_fixture()
        package["review"]["expert"] = "reviewed"
        self.assert_code(package, registry, "EXPERT_EVIDENCE_REQUIRED")
        package, registry = release_fixture(expert=True)
        self.assertEqual([], validate_publication_evidence(package, registry))

    def test_status_only_release_without_registry_fails(self):
        package, _ = release_fixture()
        self.assert_code(package, None, "EVIDENCE_REGISTRY_REQUIRED")

    def test_unknown_missing_and_duplicate_evidence_references(self):
        package, registry = release_fixture()
        package["evidenceRefs"][0] = "absent"
        self.assert_code(package, registry, "EVIDENCE_REFERENCE_UNKNOWN")
        package, registry = release_fixture()
        package["evidenceRefs"].append(package["evidenceRefs"][0])
        self.assert_code(package, registry, "DUPLICATE_REFERENCE")
        package["evidenceRefs"] = []
        self.assert_code(package, registry, "EVIDENCE_REFERENCES_REQUIRED")

    def test_modified_content_or_revision_invalidates_evidence(self):
        for field, value in (("title", "修改后的标题"), ("revision", 2)):
            package, registry = release_fixture()
            package["cards"][0][field] = value
            with self.subTest(field=field):
                self.assert_code(package, registry, "EVIDENCE_CONTENT_MISMATCH")

    def test_rejected_review_cannot_publish(self):
        package, registry = release_fixture()
        registry["records"][0]["decision"] = "rejected"
        self.assert_code(package, registry, "EVIDENCE_NOT_APPROVED")

    def test_release_withdrawn_card_is_rejected_even_with_prior_review(self):
        package, registry = release_fixture()
        package["cards"][0]["withdrawn"] = True
        self.assert_code(package, registry, "WITHDRAWN_RELEASE_CARD")

    def test_license_must_cover_target_environment(self):
        package, registry = release_fixture("public", licensed=True)
        self.assertEqual([], validate_publication_evidence(package, registry))
        license_record = next(record for record in registry["records"] if record["kind"] == "rights_license")
        license_record["allowedEnvironments"] = ["private_trial"]
        self.assert_code(package, registry, "LICENSE_ENVIRONMENT_DENIED")

    def test_license_must_be_explicitly_referenced_for_release(self):
        package, registry = release_fixture(licensed=True)
        package["evidenceRefs"] = [ref for ref in package["evidenceRefs"] if "rights_license" not in ref]
        self.assert_code(package, registry, "LICENSE_EVIDENCE_REQUIRED")

    def test_hash_is_order_independent_but_binds_content(self):
        card = candidate()["cards"][0]
        original = canonical_card_hash(card)
        self.assertEqual(original, canonical_card_hash(dict(reversed(list(card.items())))))
        card.update(reviewState="reviewed", withdrawn=True, evidenceRefs=["future-evidence"])
        self.assertEqual(original, canonical_card_hash(card))
        card["steps"][0] += "变更"
        self.assertNotEqual(original, canonical_card_hash(card))

    def test_registry_rejects_unsafe_and_malformed_evidence(self):
        mutations = [
            ("HUMAN_EVIDENCE_REQUIRED", lambda record: record.update(actorKind="ai")),
            ("SELF_REVIEW_MISMATCH", lambda record: record.update(selfReviewed=False)),
            ("REVIEW_CHECKS_INCOMPLETE", lambda record: record.update(checks=["sources"] * 4)),
            ("EVIDENCE_DATE_INVALID", lambda record: record.update(createdAt="2026-11-13T10:00:00")),
            ("EVIDENCE_HASH_INVALID", lambda record: record.update(contentHash="not-a-hash")),
            ("EVIDENCE_FIELD_REQUIRED", lambda record: record.pop("evidenceRef")),
            ("EVIDENCE_UNKNOWN_FIELD", lambda record: record.update(unknown="unexpected")),
        ]
        for code, mutate in mutations:
            _, registry = release_fixture()
            mutate(registry["records"][0])
            with self.subTest(code=code):
                self.assertIn(code, {issue.code for issue in validate_evidence_registry(registry)})

    def test_registry_duplicate_id_and_invalid_record_return_errors(self):
        _, registry = release_fixture()
        registry["records"].append(copy.deepcopy(registry["records"][0]))
        self.assertIn("DUPLICATE_EVIDENCE_ID", {issue.code for issue in validate_evidence_registry(registry)})
        for value in (None, [], {}, {"schemaVersion": 1, "records": [None]}, {"schemaVersion": 1, "records": [{"kind": []}]}):
            with self.subTest(value=repr(value)):
                self.assertTrue(validate_evidence_registry(value))


class CommandLineTests(unittest.TestCase):
    def run_cli(self, *args, cwd=None):
        return subprocess.run([sys.executable, "-B", "-I", str(SCRIPT_PATH), *map(str, args)],
                              cwd=cwd, capture_output=True, encoding="utf-8", timeout=30)

    def test_json_success_from_another_directory_has_no_file_writes(self):
        before = hashlib.sha256(PACKAGE_PATH.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_cli(PACKAGE_PATH, "--format", "json", cwd=directory)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertTrue(json.loads(result.stdout)["valid"])
            self.assertEqual([], list(Path(directory).iterdir()))
        self.assertEqual(before, hashlib.sha256(PACKAGE_PATH.read_bytes()).hexdigest())

    def test_missing_cards_returns_exit_one_and_field_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            package = candidate()
            del package["cards"]
            path.write_text(json.dumps(package), encoding="utf-8")
            result = self.run_cli(path, "--format", "json")
            self.assertEqual(1, result.returncode)
            errors = json.loads(result.stdout)["errors"]
            self.assertIn("/cards", {error["path"] for error in errors})
            self.assertNotIn("Traceback", result.stderr)

    def test_duplicate_json_keys_and_nonfinite_numbers_are_rejected(self):
        for text in ('{"cards":[],"cards":[]}', '{"bad":NaN}', '{"bad":Infinity}'):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "bad.json"
                path.write_text(text, encoding="utf-8")
                result = self.run_cli(path, "--format", "json")
                self.assertEqual(1, result.returncode)
                self.assertEqual("JSON_INVALID", json.loads(result.stdout)["errors"][0]["code"])

    def test_missing_file_returns_exit_two(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_cli(Path(directory) / "absent.json", "--format", "json")
            self.assertEqual(2, result.returncode)
            self.assertEqual("VALIDATOR_SETUP_ERROR", json.loads(result.stdout)["errors"][0]["code"])

    def test_invalid_schema_returns_exit_two(self):
        with tempfile.TemporaryDirectory() as directory:
            schema = Path(directory) / "schema.json"
            schema.write_text('{"type":"not-a-type"}', encoding="utf-8")
            result = self.run_cli(PACKAGE_PATH, "--schema", schema, "--format", "json")
            self.assertEqual(2, result.returncode)
            self.assertNotIn("Traceback", result.stderr)

    def test_release_flag_rejects_candidate(self):
        result = self.run_cli(PACKAGE_PATH, "--release", "--format", "json")
        self.assertEqual(1, result.returncode)
        self.assertIn("RELEASE_REQUIRED", {error["code"] for error in json.loads(result.stdout)["errors"]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
