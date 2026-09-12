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


if __name__ == "__main__":
    unittest.main()
