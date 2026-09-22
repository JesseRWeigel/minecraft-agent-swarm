import copy
from pathlib import Path
import unittest
from tools.pilot.scoped_trial import limits_match,no_violations,validate_evidence,run_scoped

def effective():
    return {"memory":str(4*1024**3),"swap":"0","tasks":"256","cpu":"200000 100000",
            "memory.events":{"max":0,"oom":0,"oom_kill":0,"oom_group_kill":0},"pids.events":{"max":0}}

def records():
    start={"schema_version":1,"unit":"test.scope","profile":"game","source_sha256":"a"*64,"config_sha256":"c"*64,
           "limits_verified":True,"effective":effective()}
    end={**copy.deepcopy(start),"child_returncode":0,"no_limit_violations":True}
    return start,end

class ScopedTrialTests(unittest.TestCase):
    def test_exact_limits_required(self):
        self.assertTrue(limits_match(effective(),"game"))
        for key,value in [("memory","max"),("swap","max"),("tasks","max"),("cpu","max 100000"),("cpu",None)]:
            self.assertFalse(limits_match({**effective(),key:value},"game"))
        self.assertFalse(limits_match(effective(),"unknown"))

    def test_limit_counters_are_recomputed_not_trusted(self):
        start,end=records()
        self.assertTrue(validate_evidence(start,end,"game","test.scope","a"*64,"c"*64))
        for group,key in [('memory.events','max'),('memory.events','oom_kill'),('pids.events','max')]:
            changed=copy.deepcopy(end);changed['effective'][group][key]=1
            self.assertFalse(validate_evidence(start,changed,"game","test.scope","a"*64,"c"*64))
        self.assertFalse(no_violations({},{}))

    def test_missing_changed_or_failed_evidence_fails_closed(self):
        start,end=records()
        for candidate in [None,{}, {**end,'child_returncode':True},{**end,'child_returncode':1},
                          {**end,'profile':'memory_failure'},{**end,'unit':'other.scope'}, {**end,'limits_verified':False}]:
            self.assertFalse(validate_evidence(start,candidate,"game","test.scope","a"*64,"c"*64))
        self.assertFalse(validate_evidence(start,end,"game","test.scope","b"*64,"c"*64))
        self.assertFalse(validate_evidence(start,end,"game","test.scope","a"*64,"d"*64))

    def test_invalid_profile_rejected_before_mutation(self):
        with self.assertRaises(ValueError):
            run_scoped([],workspace=Path('/not-created'),cwd=Path('/'),env={},profile='unlimited')

if __name__=='__main__':unittest.main()
