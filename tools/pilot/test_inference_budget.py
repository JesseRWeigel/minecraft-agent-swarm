import unittest
from tools.pilot.inference_budget import InferenceBudget, BudgetExceeded

class Clock:
 def __init__(self):self.value=0.
 def __call__(self):return self.value
 def advance(self,n):self.value+=n

class BudgetTests(unittest.TestCase):
 def setUp(self):self.clock=Clock();self.b=InferenceBudget(clock=self.clock)
 def test_reserves_before_dispatch_and_releases_only_known_completed_usage(self):
  self.assertEqual(self.b.begin(100),20)
  self.assertEqual((self.b.calls_used,self.b.output_tokens_used),(1,256))
  self.clock.advance(2);r=self.b.finish(12)
  self.assertEqual((r.charged_output_tokens,r.actual_output_tokens,r.elapsed_seconds),(12,12,2))
  self.assertTrue(r.usage_known);self.assertEqual(self.b.output_tokens_used,12)
 def test_unknown_failed_and_cancelled_calls_keep_reservations(self):
  for usage,outcome in [(None,'completed'),(5,'failed'),(None,'cancelled')]:
   self.b.begin(10);r=self.b.finish(usage,outcome=outcome)
   self.assertEqual(r.charged_output_tokens,256)
   self.assertEqual(r.usage_known,usage is not None)
  self.assertEqual((self.b.calls_used,self.b.output_tokens_used),(3,768))
 def test_call_and_output_caps_include_all_eight_attempts(self):
  for _ in range(8):self.b.begin(8192);self.b.finish(None,outcome='failed')
  self.assertEqual(self.b.output_tokens_used,2048)
  with self.assertRaises(BudgetExceeded):self.b.begin(1)
  self.assertTrue(self.b.failed)
 def test_no_overlap_and_failure_is_sticky(self):
  self.b.begin(1)
  with self.assertRaises(BudgetExceeded):self.b.begin(1)
  with self.assertRaises(BudgetExceeded):self.b.finish(0)
 def test_finish_without_dispatch_rejected(self):
  with self.assertRaises(BudgetExceeded):self.b.finish(0)
 def test_input_and_output_requests_are_strict(self):
  for bad in [True,False,1.,-1,8193,float('nan'),'1',None]:
   with self.subTest(bad=bad),self.assertRaises(BudgetExceeded):InferenceBudget(clock=self.clock).begin(bad)
  for bad in [True,0,-1,257,1.,float('inf')]:
   with self.subTest(bad=bad),self.assertRaises(BudgetExceeded):InferenceBudget(clock=self.clock).begin(1,output_limit=bad)
 def test_invalid_reported_usage_poisoned_without_refund(self):
  for bad in [True,-1,257,1.,float('nan'),'3']:
   b=InferenceBudget(clock=self.clock);b.begin(1)
   with self.assertRaises(BudgetExceeded):b.finish(bad)
   self.assertEqual(b.output_tokens_used,256);self.assertTrue(b.failed)
 def test_late_call_cannot_refund_or_start_again(self):
  self.b.begin(1);self.clock.advance(20.01)
  with self.assertRaises(BudgetExceeded):self.b.finish(0)
  self.assertEqual(self.b.output_tokens_used,256)
  self.assertEqual(self.b.records[-1].outcome,'budget_exceeded')
  with self.assertRaises(BudgetExceeded):self.b.begin(1)
 def test_cumulative_and_episode_time_limit_dispatch_timeout(self):
  for _ in range(4):self.b.begin(1);self.clock.advance(20);self.b.finish(0)
  self.assertEqual(self.b.begin(1),10);self.clock.advance(10);self.b.finish(0)
  with self.assertRaises(BudgetExceeded):self.b.begin(1)
  clock=Clock();b=InferenceBudget(clock=clock);clock.advance(119)
  self.assertEqual(b.begin(1),1);clock.advance(1.01)
  with self.assertRaises(BudgetExceeded):b.finish(0)
 def test_invalid_or_backwards_clock_is_sticky(self):
  for invalid in [True,float('nan'),float('inf'),-1,'time']:
   clock=Clock();b=InferenceBudget(clock=clock);clock.value=invalid
   with self.assertRaises(BudgetExceeded):b.begin(1)
   self.assertTrue(b.failed)
  self.clock.advance(10);self.b.begin(1);self.clock.value=9
  with self.assertRaises(BudgetExceeded):self.b.finish(0)
 def test_records_are_immutable_and_returned_as_tuple(self):
  self.b.begin(1,output_limit=32);r=self.b.finish(10)
  self.assertIsInstance(self.b.records,tuple)
  with self.assertRaises(AttributeError):r.charged_output_tokens=0
 def test_malformed_finish_preserves_elapsed_and_reservation(self):
  for usage,outcome in [('bad','completed'),(3,'invented'),(3,True)]:
   clock=Clock();b=InferenceBudget(clock=clock);b.begin(1);clock.advance(2)
   with self.assertRaises(BudgetExceeded):b.finish(usage,outcome=outcome)
   self.assertEqual(b.inference_seconds_used,2)
   self.assertEqual(b.records[-1].outcome,'invalid_accounting')
   self.assertEqual(b.records[-1].charged_output_tokens,256)
 def test_exact_episode_boundary_completes_but_cannot_dispatch_again(self):
  self.clock.advance(100);self.b.begin(1);self.clock.advance(20)
  self.assertEqual(self.b.finish(1).outcome,'completed')
  with self.assertRaises(BudgetExceeded):self.b.begin(1)
