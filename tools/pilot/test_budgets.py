import math
import unittest

from tools.pilot.budgets import BudgetError, BudgetExceeded, BudgetLimits, BudgetTracker


VALID = {
    "max_steps": 2,
    "timeout_seconds": 10,
    "max_provider_requests": 2,
    "max_input_tokens": 8,
    "max_output_tokens": 6,
}


class FakeClock:
    def __init__(self, value=100.0):
        self.value = value

    def __call__(self):
        return self.value


class BudgetTests(unittest.TestCase):
    def test_limits_require_exact_positive_finite_fields(self):
        limits = BudgetLimits.from_dict(VALID)
        self.assertEqual(limits.max_steps, 2)
        for field in VALID:
            with self.subTest(field=field, case="boolean"):
                invalid = dict(VALID); invalid[field] = True
                with self.assertRaisesRegex(BudgetError, field):
                    BudgetLimits.from_dict(invalid)
            with self.subTest(field=field, case="zero"):
                invalid = dict(VALID); invalid[field] = 0
                with self.assertRaisesRegex(BudgetError, field):
                    BudgetLimits.from_dict(invalid)
        with self.assertRaisesRegex(BudgetError, "exactly"):
            BudgetLimits.from_dict({**VALID, "extra": 1})
        with self.assertRaisesRegex(BudgetError, "timeout_seconds"):
            BudgetLimits.from_dict({**VALID, "timeout_seconds": math.inf})
        with self.assertRaisesRegex(BudgetError, "max_steps"):
            BudgetLimits.from_dict({**VALID, "max_steps": 1.5})

    def test_exact_request_and_step_boundaries_are_allowed_then_exhausted(self):
        clock = FakeClock()
        tracker = BudgetTracker(BudgetLimits.from_dict(VALID), clock=clock)
        tracker.reserve_request(input_tokens=3, max_output_tokens=4)
        tracker.finish_request(actual_output_tokens=4)
        tracker.reserve_request(input_tokens=5, max_output_tokens=2)
        tracker.finish_request(actual_output_tokens=2)
        tracker.consume_step(); tracker.consume_step()

        snapshot = tracker.snapshot()
        self.assertEqual(snapshot["provider_requests"], 2)
        self.assertEqual(snapshot["input_tokens"], 8)
        self.assertEqual(snapshot["output_tokens"], 6)
        self.assertEqual(snapshot["steps"], 2)
        self.assertEqual(
            snapshot["exhausted"],
            {"requests": True, "input_tokens": True, "output_tokens": True, "steps": True, "deadline": False},
        )
        for operation in (
            lambda: tracker.reserve_request(input_tokens=0, max_output_tokens=1),
            tracker.consume_step,
        ):
            with self.assertRaises(BudgetExceeded):
                operation()

    def test_reservation_prevents_provider_call_when_any_budget_is_insufficient(self):
        for overrides, request, message in (
            ({"max_provider_requests": 1}, (0, 1), "requests"),
            ({"max_input_tokens": 2}, (2, 1), "input"),
            ({"max_output_tokens": 2}, (0, 2), "output"),
        ):
            with self.subTest(message=message):
                tracker = BudgetTracker(BudgetLimits.from_dict({**VALID, **overrides}))
                tracker.reserve_request(input_tokens=request[0], max_output_tokens=request[1])
                tracker.finish_request(actual_output_tokens=request[1])
                calls = 0
                with self.assertRaisesRegex(BudgetExceeded, message):
                    tracker.reserve_request(input_tokens=request[0], max_output_tokens=request[1])
                    calls += 1
                self.assertEqual(calls, 0)

    def test_request_arguments_and_lifecycle_are_strict(self):
        tracker = BudgetTracker(BudgetLimits.from_dict(VALID))
        for value in (-1, True, 1.5):
            with self.subTest(input_tokens=value):
                with self.assertRaises(BudgetError):
                    tracker.reserve_request(input_tokens=value, max_output_tokens=1)
        for value in (0, -1, True, 1.5):
            with self.subTest(max_output_tokens=value):
                with self.assertRaises(BudgetError):
                    tracker.reserve_request(input_tokens=0, max_output_tokens=value)
        tracker.reserve_request(input_tokens=1, max_output_tokens=3)
        with self.assertRaisesRegex(BudgetError, "unfinished"):
            tracker.reserve_request(input_tokens=1, max_output_tokens=1)
        with self.assertRaisesRegex(BudgetError, "reservation"):
            tracker.finish_request(actual_output_tokens=4)
        pending = tracker.snapshot()
        self.assertTrue(pending["request_pending"])
        self.assertEqual(pending["reserved_output_tokens"], 3)
        tracker.finish_request(actual_output_tokens=2)
        self.assertFalse(tracker.snapshot()["request_pending"])
        with self.assertRaisesRegex(BudgetError, "no request"):
            tracker.finish_request(actual_output_tokens=0)

    def test_deadline_is_checked_before_mutation_and_is_not_hard_preemption(self):
        clock = FakeClock()
        tracker = BudgetTracker(BudgetLimits.from_dict(VALID), clock=clock)
        clock.value = 110.0
        with self.assertRaisesRegex(BudgetExceeded, "deadline"):
            tracker.reserve_request(input_tokens=1, max_output_tokens=1)
        with self.assertRaisesRegex(BudgetExceeded, "deadline"):
            tracker.consume_step()
        snapshot = tracker.snapshot()
        self.assertEqual(snapshot["provider_requests"], 0)
        self.assertEqual(snapshot["steps"], 0)
        self.assertTrue(snapshot["exhausted"]["deadline"])
        self.assertFalse(snapshot["hard_preemption"])
        self.assertEqual(snapshot["deadline_enforcement"], "checked_at_budget_boundaries")

    def test_clock_must_remain_finite_and_monotonic(self):
        clock = FakeClock()
        tracker = BudgetTracker(BudgetLimits.from_dict(VALID), clock=clock)
        clock.value = 99.0
        with self.assertRaisesRegex(BudgetError, "monotonic"):
            tracker.snapshot()
        clock.value = math.nan
        with self.assertRaisesRegex(BudgetError, "finite"):
            tracker.snapshot()
        overflow_clock = FakeClock(-1e308)
        overflow_tracker = BudgetTracker(BudgetLimits.from_dict(VALID), clock=overflow_clock)
        overflow_clock.value = 1e308
        with self.assertRaisesRegex(BudgetError, "elapsed.*finite"):
            overflow_tracker.snapshot()


if __name__ == "__main__":
    unittest.main()
