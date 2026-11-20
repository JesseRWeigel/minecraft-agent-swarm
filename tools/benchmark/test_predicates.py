import unittest

from tools.benchmark.predicates import PredicateError, evaluate_goal


def position(x, y, z, dimension="overworld"):
    return {
        "actors": {
            "atlas": {
                "dimension": dimension,
                "position": {"x": x, "y": y, "z": z},
            }
        }
    }


class PredicateTests(unittest.TestCase):
    @staticmethod
    def recovery_scenario():
        return {
            "id": "recover",
            "task": "recover_after_injected_failure",
            "goal": {
                "actor": "atlas",
                "injection_kind": "path_obstruction",
                "injection_step": 3,
                "injection_outcome": "interrupted",
                "max_recovery_latency_ms": 5000,
                "expected_final_state": "operational",
            },
        }

    def test_navigation_requires_crossing_into_the_region_and_dimension(self):
        scenario = {
            "id": "navigate",
            "task": "navigate_to_region",
            "goal": {
                "actor": "atlas",
                "dimension": "overworld",
                "min": [10, 60, 10],
                "max": [20, 80, 20],
            },
        }
        result = evaluate_goal(scenario, position(0, 64, 0), position(12, 64, 18))
        self.assertTrue(result.passed)
        self.assertEqual(result.reason, "observed_region_entry")

        wrong_dimension = evaluate_goal(
            scenario,
            position(0, 64, 0),
            position(12, 64, 18, dimension="the_nether"),
        )
        self.assertFalse(wrong_dimension.passed)
        self.assertEqual(wrong_dimension.reason, "predicate_not_met")

    def test_navigation_requires_observed_dimension(self):
        scenario = {
            "id": "navigate",
            "task": "navigate_to_region",
            "goal": {
                "actor": "atlas",
                "dimension": "overworld",
                "min": [10, 60, 10],
                "max": [20, 80, 20],
            },
        }
        missing = position(12, 64, 18)
        del missing["actors"]["atlas"]["dimension"]
        result = evaluate_goal(scenario, position(0, 64, 0), missing)
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "missing_observation")

    def test_goal_already_met_never_gets_credit(self):
        scenario = {
            "id": "acquire",
            "task": "acquire_item",
            "goal": {"actor": "atlas", "item": "oak_log", "count": 4},
        }
        state = {"actors": {"atlas": {"inventory": {"oak_log": 4}}}}
        result = evaluate_goal(scenario, state, state)
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "goal_already_met")

    def test_acquire_item_count_is_target_inventory_with_positive_gain(self):
        scenario = {
            "id": "acquire",
            "task": "acquire_item",
            "goal": {"actor": "atlas", "item": "oak_log", "count": 8},
        }
        result = evaluate_goal(
            scenario,
            {"actors": {"atlas": {"inventory": {"oak_log": 3}}}},
            {"actors": {"atlas": {"inventory": {"oak_log": 8}}}},
        )
        self.assertTrue(result.passed)
        self.assertEqual(result.evidence["delta"], 5)

    def test_crafting_rejects_wrong_recipe_wrong_actor_and_dropped_output(self):
        goal = {
            "actor": "atlas", "recipe": "minecraft:iron_pickaxe",
            "item": "iron_pickaxe", "observer_id": "judge", "count": 1,
        }
        scenario = {"id": "craft-iron", "task": "craft_item", "goal": goal}
        event = dict(goal, event_id="evt-1")
        initial = {"actors": {"atlas": {"inventory": {}}}}
        final = {"actors": {"atlas": {"inventory": {"iron_pickaxe": 1}}}}
        for field, value in (
            ("recipe", "minecraft:stone_pickaxe"),
            ("actor", "nova"),
            ("item", "stone_pickaxe"),
        ):
            with self.subTest(field=field):
                result = evaluate_goal(
                    scenario, initial, dict(final, observed_crafts=[dict(event, **{field: value})])
                )
                self.assertEqual((result.passed, result.reason), (False, "craft_evidence_missing"))
        dropped = {"actors": {"atlas": {"inventory": {}}}, "observed_crafts": [event]}
        result = evaluate_goal(scenario, initial, dropped)
        self.assertEqual((result.passed, result.reason), (False, "predicate_not_met"))
        with self.assertRaisesRegex(PredicateError, "duplicate observed craft event_id"):
            evaluate_goal(scenario, initial, dict(final, observed_crafts=[event, event]))
        with self.assertRaisesRegex(PredicateError, "count must be a positive integer"):
            evaluate_goal(
                scenario, initial, dict(final, observed_crafts=[dict(event, count=True)])
            )
        result = evaluate_goal(scenario, initial, dict(final, observed_crafts=[]))
        self.assertEqual((result.passed, result.reason), (False, "craft_evidence_missing"))

    def test_handoff_requires_observer_evidence_and_matching_inventory(self):
        scenario = {
            "id": "handoff",
            "task": "shared_resource_handoff",
            "goal": {
                "donor": "atlas",
                "recipient": "nova",
                "item": "iron_ingot",
                "count": 2,
                "observer_id": "synthetic-evaluator",
            },
        }
        initial = {
            "actors": {
                "atlas": {"inventory": {"iron_ingot": 3, "gold_ingot": 2}},
                "nova": {"inventory": {"iron_ingot": 0, "gold_ingot": 0}},
            }
        }
        matching_inventory_without_transfer = {
            "actors": {
                "atlas": {"inventory": {"iron_ingot": 1, "gold_ingot": 2}},
                "nova": {"inventory": {"iron_ingot": 2, "gold_ingot": 0}},
            },
            "observed_transfers": [],
        }
        result = evaluate_goal(scenario, initial, matching_inventory_without_transfer)
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "transfer_evidence_missing")

        transferred = {
            **matching_inventory_without_transfer,
            "observed_transfers": [
                {
                    "event_id": "transfer-1",
                    "observer_id": "synthetic-evaluator",
                    "donor": "atlas",
                    "recipient": "nova",
                    "item": "iron_ingot",
                    "count": 2,
                }
            ],
        }
        result = evaluate_goal(scenario, initial, transferred)
        self.assertTrue(result.passed)
        self.assertEqual(result.reason, "observed_item_handoff")
        self.assertEqual(result.evidence["observed_transfer_count"], 2)

        invalid = {**scenario, "goal": {**scenario["goal"], "recipient": "atlas"}}
        with self.assertRaisesRegex(PredicateError, "distinct"):
            evaluate_goal(invalid, initial, transferred)

    def test_foreign_item_transfer_cannot_satisfy_handoff(self):
        scenario = {
            "id": "handoff",
            "task": "shared_resource_handoff",
            "goal": {
                "donor": "atlas",
                "recipient": "nova",
                "item": "iron_ingot",
                "count": 2,
                "observer_id": "synthetic-evaluator",
            },
        }
        initial = {
            "actors": {
                "atlas": {"inventory": {"iron_ingot": 3, "gold_ingot": 2}},
                "nova": {"inventory": {"iron_ingot": 0, "gold_ingot": 0}},
            }
        }
        foreign_item = {
            "actors": {
                "atlas": {"inventory": {"iron_ingot": 3, "gold_ingot": 0}},
                "nova": {"inventory": {"iron_ingot": 0, "gold_ingot": 2}},
            },
            "observed_transfers": [
                {
                    "event_id": "transfer-gold",
                    "observer_id": "synthetic-evaluator",
                    "donor": "atlas",
                    "recipient": "nova",
                    "item": "gold_ingot",
                    "count": 2,
                }
            ],
        }
        self.assertFalse(evaluate_goal(scenario, initial, foreign_item).passed)

    def test_missing_observation_fails_closed(self):
        scenario = {
            "id": "navigate",
            "task": "navigate_to_region",
            "goal": {
                "actor": "atlas",
                "dimension": "overworld",
                "min": [10, 60, 10],
                "max": [20, 80, 20],
            },
        }
        result = evaluate_goal(scenario, {"actors": {}}, {"actors": {}})
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "missing_observation")

    def test_recovery_requires_linked_observed_injection_attempt_outcome_and_latency(self):
        initial = {"actors": {"atlas": {"recovery_state": "operational"}}}
        final = {
            "actors": {"atlas": {"recovery_state": "operational"}},
            "observed_injections": [
                {
                    "event_id": "inject-1",
                    "actor": "atlas",
                    "kind": "path_obstruction",
                    "at_step": 3,
                    "outcome": "interrupted",
                    "observed_at_ms": 1000,
                }
            ],
            "observed_recovery_attempts": [
                {
                    "event_id": "recovery-1",
                    "actor": "atlas",
                    "injection_event_id": "inject-1",
                    "outcome": "recovered",
                    "started_at_ms": 1200,
                    "finished_at_ms": 3200,
                }
            ],
        }

        result = evaluate_goal(self.recovery_scenario(), initial, final)

        self.assertTrue(result.passed)
        self.assertEqual(result.reason, "observed_recovery_after_injection")
        self.assertEqual(result.evidence["recovery_latency_ms"], 2200)
        self.assertEqual(result.evidence["attempt_duration_ms"], 2000)

    def test_recovery_rejects_unlinked_or_late_attempts(self):
        initial = {"actors": {"atlas": {"recovery_state": "operational"}}}
        final = {
            "actors": {"atlas": {"recovery_state": "operational"}},
            "observed_injections": [
                {
                    "event_id": "inject-1",
                    "actor": "atlas",
                    "kind": "path_obstruction",
                    "at_step": 3,
                    "outcome": "interrupted",
                    "observed_at_ms": 1000,
                }
            ],
            "observed_recovery_attempts": [
                {
                    "event_id": "recovery-1",
                    "actor": "atlas",
                    "injection_event_id": "other-injection",
                    "outcome": "recovered",
                    "started_at_ms": 1200,
                    "finished_at_ms": 3200,
                }
            ],
        }
        unlinked = evaluate_goal(self.recovery_scenario(), initial, final)
        self.assertFalse(unlinked.passed)
        self.assertEqual(unlinked.reason, "recovery_attempt_not_observed")

        final["observed_recovery_attempts"][0]["injection_event_id"] = "inject-1"
        final["observed_recovery_attempts"][0]["finished_at_ms"] = 7000
        late = evaluate_goal(self.recovery_scenario(), initial, final)
        self.assertFalse(late.passed)
        self.assertEqual(late.reason, "recovery_latency_exceeded")

    def test_recovery_missing_observer_stream_is_missing_observation(self):
        result = evaluate_goal(
            self.recovery_scenario(),
            {"actors": {"atlas": {"recovery_state": "operational"}}},
            {"actors": {"atlas": {"recovery_state": "operational"}}},
        )
        self.assertFalse(result.passed)
        self.assertEqual(result.reason, "missing_observation")


if __name__ == "__main__":
    unittest.main()
