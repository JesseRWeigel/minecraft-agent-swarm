import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from tools.pilot.resource_probe import limits_match, read_limits, MEMORY_BYTES, run_probe, worker, scope_empty

class ResourceProbeTests(unittest.TestCase):
    def test_effective_limits_must_match_all_four_constraints(self):
        good={"memory":str(MEMORY_BYTES),"swap":"0","pids":"16","cpu":"25000 100000"}
        self.assertTrue(limits_match(good))
        for field,value in [("memory","max"),("swap","max"),("pids","max"),("cpu","max 100000"),
                            ("cpu","100000 100000"),("cpu","0 0"),("cpu",None)]:
            self.assertFalse(limits_match({**good,field:value}))
        self.assertFalse(limits_match({}))
        self.assertFalse(limits_match(None))

    def test_reads_effective_controller_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name,value in {"memory.max":str(MEMORY_BYTES),"memory.swap.max":"0", "pids.max":"16","cpu.max":"25000 100000"}.items():
                (root/name).write_text(value+"\n")
            self.assertTrue(limits_match(read_limits(root)))

    def test_worker_refuses_workload_without_matching_limits(self):
        with patch("tools.pilot.resource_probe.cgroup_directory", return_value=Path('/fake')), \
             patch("tools.pilot.resource_probe.read_limits", return_value={"memory":"max"}), \
             patch("tools.pilot.resource_probe.os.fork") as fork:
            result=worker("memory","synthetic.scope")
            self.assertFalse(result["enforcement_observed"])
            self.assertEqual(result["error"],"limits_not_applied")
            fork.assert_not_called()

    def test_cleanup_requires_inactive_scope_and_no_populated_cgroup(self):
        self.assertFalse(scope_empty({"ActiveState":"active","ControlGroup":""}))
        self.assertFalse(scope_empty({}))
        self.assertTrue(scope_empty({"ActiveState":"inactive","ControlGroup":""}))
        with patch("tools.pilot.resource_probe.counters",return_value={"populated":1}):
            self.assertFalse(scope_empty({"ActiveState":"failed","ControlGroup":"/synthetic.scope"}))
        with patch("tools.pilot.resource_probe.counters",return_value={"populated":0}):
            self.assertTrue(scope_empty({"ActiveState":"failed","ControlGroup":"/synthetic.scope"}))

    def test_invalid_scenario_rejected_before_launch(self):
        with self.assertRaises(ValueError): run_probe("arbitrary",Path('/not-created'))

if __name__ == "__main__": unittest.main()
