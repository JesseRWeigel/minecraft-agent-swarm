"""Offline audit of a deadline-limited partial dig, never a gameplay score.

A configured deadline alone is not evidence of interruption. Callers must also
verify persisted file hashes, independent baseline, failed lifecycle and cleanup.
The coordinator records a generic failure, so this predicate does not identify
the precise low-level transport exception or prove graceful dig cancellation.
"""
import json
import math
from tools.pilot.action_coordinator import _decode_reply
from tools.pilot.oak_script import scripted_actions


def deadline_interruption_valid(script, recorded_injection, worker_injection):
    try:
        fault=recorded_injection
        if not isinstance(fault,dict) or json.dumps(fault,sort_keys=True,allow_nan=False)!=json.dumps(worker_injection,sort_keys=True,allow_nan=False):return False
        if set(fault)!={'schema_version','kind','timeout_seconds','started_monotonic','finished_monotonic'}:return False
        if type(fault['schema_version']) is not int or fault['schema_version']!=1 or fault['kind']!='scripted_deadline' or fault['timeout_seconds']!=.5:return False
        start,end=fault['started_monotonic'],fault['finished_monotonic']
        if any(type(x) not in (float,int) or not math.isfinite(x) for x in (start,end)):return False
        if start<0 or not .5<=end-start<=2:return False
        if not isinstance(script,dict) or type(script.get('schema_version')) is not int or script['schema_version']!=1 or script.get('status')!='failed' or script.get('error')!='action coordinator failed':return False
        rows=script.get('records')
        if not isinstance(rows,list) or len(rows)!=3:return False
        previous=start
        for sequence,(row,action) in enumerate(zip(rows,scripted_actions('forward')),1):
            request={'schema_version':1,'trial_id':'collect-oak-log-v1','action_id':'collect-01','sequence':sequence,'action':action}
            if json.dumps(row.get('request'),sort_keys=True,allow_nan=False)!=json.dumps(request,sort_keys=True,allow_nan=False):return False
            began=row.get('started_monotonic')
            if type(began) not in (float,int) or not math.isfinite(began) or not previous<=began<start+.5:return False
            if sequence==3:
                if row.get('reply') is not None or row.get('finished_monotonic') is not None:return False
            else:
                ended=row.get('finished_monotonic')
                if type(ended) not in (float,int) or not math.isfinite(ended) or not began<=ended<start+.5:return False
                _decode_reply(json.dumps(row.get('reply'),allow_nan=False).encode(),sequence,False,sequence==1)
                previous=ended
        return True
    except (KeyError,ValueError,TypeError,AttributeError,OverflowError,RecursionError):
        return False
