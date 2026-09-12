import unittest
from label_rules import classify_legacy


class LabelTests(unittest.TestCase):
    def test_stale_success_preserved(self):
        value = classify_legacy({'success': True, 'result': 'Blocked: "eat" recently failed. Try something else.'})
        self.assertIs(value['original_success'], True)
        self.assertEqual(value['revised_status'], 'blocked')
        self.assertEqual(value['reason_code'], 'recent_failure_gate')

    def test_disallowed(self):
        value = classify_legacy({'success': True, 'result': 'Action "mine_block" not allowed for Mason. Use: eat'})
        self.assertEqual(value['revised_status'], 'blocked')

    def test_positive_prose_not_ground_truth(self):
        value = classify_legacy({'success': True, 'result': 'Arrived.'})
        self.assertEqual(value['revised_status'], 'unknown')
        self.assertTrue(value['review_required'])

    def test_chat_containing_failure_word_not_gate(self):
        value = classify_legacy({'success': True, 'result': 'Said: Blocked: "eat" recently failed.'})
        self.assertEqual(value['revised_status'], 'unknown')

    def test_explicit_failure_and_timeout(self):
        for text, status in [('Action failed: No path to the goal!', 'failed'), ('Action "attack" timed out after 150s — aborted to free the brain.', 'timed_out')]:
            self.assertEqual(classify_legacy({'success': True, 'result': text})['revised_status'], status)

    def test_missing_or_nonboolean_is_unknown(self):
        for v in [None, 1, 'true']:
            self.assertIsNone(classify_legacy({'success': v, 'result': 'okay'})['original_success'])

    def test_timeout_needs_a_boundary_after_seconds(self):
        text = 'Action "attack" timed out after 5successful actions followed.'
        self.assertEqual(classify_legacy({'success': True, 'result': text})['revised_status'], 'unknown')

if __name__ == '__main__': unittest.main()
