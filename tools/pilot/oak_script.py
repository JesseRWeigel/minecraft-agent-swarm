"""Fixed primitive replay plans; model observations never determine the score."""
import json
import math


def scripted_actions(mode):
    if mode == 'stationary':
        return [{'kind':'observe'}, {'kind':'finish'}]
    if mode != 'forward':
        raise ValueError('unsupported scripted control')
    return [{'kind':'observe'}, {'kind':'look','yaw':math.pi,'pitch':-math.atan2(1.12,3)},
            {'kind':'dig','x':0,'y':200,'z':3}, {'kind':'look','yaw':math.pi,'pitch':0},
            {'kind':'move','direction':'forward','ticks':20}, {'kind':'observe'}, {'kind':'finish'}]


def script_receipt_valid(value, mode):
    try:
        actions=scripted_actions(mode)
        if (not isinstance(value,dict) or type(value.get('schema_version')) is not int or value['schema_version'] != 1
                or value.get('status') != 'finished' or value.get('error') is not None):return False
        rows=value.get('records')
        if not isinstance(rows,list) or len(rows)!=len(actions):return False
        previous=None;first=None
        for sequence,(row,action) in enumerate(zip(rows,actions),1):
            if not isinstance(row,dict):return False
            request={'schema_version':1,'trial_id':'collect-oak-log-v1','action_id':'collect-01','sequence':sequence,'action':action}
            # Canonical JSON equality also distinguishes boolean values from integers.
            if json.dumps(row.get('request'),sort_keys=True,allow_nan=False)!=json.dumps(request,sort_keys=True,allow_nan=False):return False
            start,end=row.get('started_monotonic'),row.get('finished_monotonic')
            if any(type(x) not in (int,float) or not math.isfinite(x) for x in (start,end)):return False
            if not 0<=start<=end or (previous is not None and start<previous):return False
            if first is None:first=start
            if end-first>20:return False
            previous=end
            reply=row.get('reply')
            keys={'schema_version','sequence','status'}|({'observation'} if action['kind']=='observe' else set())
            if not isinstance(reply,dict) or set(reply)!=keys:return False
            if type(reply.get('schema_version')) is not int or reply['schema_version']!=1 or type(reply.get('sequence')) is not int or reply['sequence']!=sequence:return False
            if reply.get('status')!=('finished' if action['kind']=='finish' else 'completed'):return False
            if action['kind']=='observe' and (not isinstance(reply['observation'],dict) or reply['observation'].get('source')!='participant_bot'):return False
            if len(json.dumps(reply,allow_nan=False).encode())+1>20480:return False
        return True
    except (ValueError,TypeError,KeyError,OverflowError,RecursionError):
        return False
