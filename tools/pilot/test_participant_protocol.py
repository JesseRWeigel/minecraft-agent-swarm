import json
import math
import unittest

from tools.pilot.participant_protocol import (
    ACTION_TIMEOUT_SECONDS,
    MAX_LINE_BYTES,
    MAX_TOTAL_BYTES,
    READY_TIMEOUT_SECONDS,
    ParticipantProtocol,
    ParticipantProtocolError,
)


class Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


def line(message_type, **extra):
    value = {
        "schema_version": 1,
        "type": message_type,
        "trial_id": "trial-01",
        "action_id": "walk-01",
        **extra,
    }
    return (json.dumps(value, separators=(",", ":")) + "\n").encode()


class ParticipantProtocolTests(unittest.TestCase):
    def make(self):
        clock = Clock()
        return ParticipantProtocol(trial_id="trial-01", action_id="walk-01", now=clock), clock

    def test_incremental_happy_path_requires_supervisor_transitions(self):
        protocol, _ = self.make()
        ready = line("ready")
        self.assertEqual(protocol.feed(ready[:7]), ())
        self.assertEqual(protocol.feed(ready[7:]), ("ready",))
        self.assertEqual(protocol.state, "ready")
        protocol.begin()
        self.assertEqual(protocol.state, "action_active")
        self.assertEqual(protocol.feed(line("action_finished")), ("action_finished",))
        self.assertEqual(protocol.state, "awaiting_finalize")
        protocol.finalize()
        protocol.eof()
        self.assertEqual(protocol.state, "finalized")

    def test_forged_result_and_terminal_claims_cannot_advance(self):
        for forged in (
            line("success"),
            line("terminal"),
            line("ready", result="passed"),
            line("ready", success=True),
        ):
            protocol, _ = self.make()
            with self.assertRaises(ParticipantProtocolError):
                protocol.feed(forged)
            self.assertEqual(protocol.state, "failed")

    def test_duplicate_out_of_phase_and_batched_phase_skip_are_sticky(self):
        for payload in (
            line("action_finished"),
            line("ready") + line("ready"),
            line("ready") + line("action_finished"),
        ):
            protocol, _ = self.make()
            with self.assertRaises(ParticipantProtocolError) as first:
                protocol.feed(payload)
            with self.assertRaisesRegex(ParticipantProtocolError, str(first.exception)):
                protocol.begin()
            self.assertEqual(protocol.failure_reason, str(first.exception))

        protocol, _ = self.make()
        protocol.feed(line("ready"))
        protocol.begin()
        protocol.feed(line("action_finished"))
        with self.assertRaises(ParticipantProtocolError):
            protocol.feed(line("action_finished"))

    def test_rejects_invalid_encoding_duplicate_keys_constants_and_schema_types(self):
        invalid = [
            b"\xff\n",
            b'{"schema_version":1,"type":"ready","type":"ready","trial_id":"trial-01","action_id":"walk-01"}\n',
            b'{"schema_version":1,"type":"ready","trial_id":"trial-01","action_id":"walk-01","x":NaN}\n',
            b'{"schema_version":true,"type":"ready","trial_id":"trial-01","action_id":"walk-01"}\n',
        ]
        for payload in invalid:
            protocol, _ = self.make()
            with self.assertRaises(ParticipantProtocolError):
                protocol.feed(payload)

    def test_rejects_wrong_ids_and_unsafe_supervisor_ids(self):
        protocol, _ = self.make()
        with self.assertRaises(ParticipantProtocolError):
            protocol.feed(line("ready").replace(b"trial-01", b"trial-02"))
        for token in ("", "../trial", "trial space", "x" * 65, "é"):
            with self.assertRaises(ValueError):
                ParticipantProtocol(trial_id=token, action_id="walk-01")

    def test_enforces_line_total_and_newline_limits(self):
        protocol, _ = self.make()
        with self.assertRaisesRegex(ParticipantProtocolError, "line exceeds"):
            protocol.feed(b"x" * (MAX_LINE_BYTES + 1))

        protocol, _ = self.make()
        with self.assertRaisesRegex(ParticipantProtocolError, "stream exceeds"):
            protocol.feed(b"\n" * (MAX_TOTAL_BYTES + 1))

        protocol, _ = self.make()
        protocol.feed(line("ready")[:-1])
        with self.assertRaisesRegex(ParticipantProtocolError, "unterminated"):
            protocol.eof()

    def test_supervisor_transitions_and_eof_are_strict(self):
        protocol, _ = self.make()
        with self.assertRaisesRegex(ParticipantProtocolError, "begin out of phase"):
            protocol.begin()

        protocol, _ = self.make()
        protocol.feed(line("ready"))
        protocol.begin()
        with self.assertRaisesRegex(ParticipantProtocolError, "finalize out of phase"):
            protocol.finalize()

        protocol, _ = self.make()
        protocol.feed(line("ready"))
        with self.assertRaisesRegex(ParticipantProtocolError, "EOF before"):
            protocol.eof()

    def test_supervisor_monotonic_deadlines_are_sticky(self):
        protocol, clock = self.make()
        clock.value += READY_TIMEOUT_SECONDS
        with self.assertRaisesRegex(ParticipantProtocolError, "deadline"):
            protocol.check_deadline()
        with self.assertRaisesRegex(ParticipantProtocolError, "deadline"):
            protocol.feed(line("ready"))

        protocol, clock = self.make()
        protocol.feed(line("ready"))
        protocol.begin()
        clock.value += ACTION_TIMEOUT_SECONDS
        with self.assertRaisesRegex(ParticipantProtocolError, "deadline"):
            protocol.feed(line("action_finished"))

    def test_messages_cannot_supply_timestamps_or_deadlines(self):
        for field in ("timestamp", "deadline", "elapsed", "timeout"):
            protocol, _ = self.make()
            with self.assertRaises(ParticipantProtocolError):
                protocol.feed(line("ready", **{field: 0}))

    def test_cannot_buffer_future_phase_bytes_before_supervisor_transitions(self):
        protocol, _ = self.make()
        future = line("action_finished")
        self.assertEqual(protocol.feed(line("ready") + future[:10]), ("ready",))
        with self.assertRaisesRegex(ParticipantProtocolError, "buffered before supervisor begin"):
            protocol.begin()

        protocol, _ = self.make()
        protocol.feed(line("ready"))
        protocol.begin()
        self.assertEqual(protocol.feed(line("action_finished") + b"{"), ("action_finished",))
        with self.assertRaisesRegex(ParticipantProtocolError, "buffered before supervisor finalize"):
            protocol.finalize()

    def test_rejects_nonfinite_and_backwards_supervisor_clock_samples(self):
        for invalid in (math.nan, math.inf, -math.inf):
            with self.assertRaisesRegex(ParticipantProtocolError, "monotonic clock"):
                ParticipantProtocol(trial_id="trial-01", action_id="walk-01", now=lambda: invalid)

        protocol, clock = self.make()
        clock.value -= 1
        with self.assertRaisesRegex(ParticipantProtocolError, "monotonic clock"):
            protocol.check_deadline()

        protocol, clock = self.make()
        protocol.feed(line("ready"))
        clock.value = math.nan
        with self.assertRaisesRegex(ParticipantProtocolError, "monotonic clock"):
            protocol.begin()


if __name__ == "__main__":
    unittest.main()
