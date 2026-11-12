import copy
import json
import unittest
from tools.pilot.fake_model_driver import MODEL, fake_model_receipt_valid
from tools.pilot.oak_script import scripted_actions
from tools.pilot.oak_worker import action_driver_valid


def receipt(mode='stationary'):
    actions = scripted_actions(mode)
    records, calls, budget = [], [], []
    for i, action in enumerate(actions, 1):
        reply = dict(schema_version=1, sequence=i, status='finished' if action['kind']=='finish' else 'completed')
        if action['kind']=='observe':
            reply['observation'] = {'source':'participant_bot'}
        records.append(dict(request=dict(schema_version=1, trial_id='collect-oak-log-v1',
            action_id='collect-01', sequence=i, action=action), reply=reply,
            started_monotonic=float(i), finished_monotonic=i+.5))
        if i > 1:
            calls.append(dict(messages=[{'role':'user','content':'next synthetic fixture action'}],
                input_tokens=10, response=dict(schema_version=1,status='completed',worker_reaped=True,
                worker_returncode=0,content=json.dumps(action),provider_input_tokens=10,
                provider_output_tokens=7,effective_timeout_seconds=20.0)))
            budget.append(dict(sequence=i-1,input_tokens=10,reserved_output_tokens=256,
                actual_output_tokens=7,charged_output_tokens=7,usage_known=True,
                elapsed_seconds=.1,outcome='completed'))
    run = dict(schema_version=1,status='finished',actions=copy.deepcopy(records),calls=calls,budget=budget)
    return dict(schema_version=1,status='finished',error=None,records=records,provider=MODEL,
                provider_stopped=True,synthetic_model=run)


class FakeModelReceiptTests(unittest.TestCase):
    def test_valid_both_controls(self):
        for mode in ('forward','stationary'):
            self.assertTrue(fake_model_receipt_valid(receipt(mode),mode))

    def test_mode_gate(self):
        for mode in ('forward','stationary','mine_only','blocked','unknown'):
            for fault in ('none','item_only','scripted_deadline','observer_timeout'):
                self.assertEqual(action_driver_valid('fake_model',mode,fault),
                                 mode in ('forward','stationary') and fault=='none')

    def test_budget_tampering(self):
        changes = {'sequence':True,'input_tokens':11,'reserved_output_tokens':255,
            'actual_output_tokens':None,'charged_output_tokens':256,'usage_known':1,
            'elapsed_seconds':float('nan'),'outcome':'failed'}
        for key,value in changes.items():
            with self.subTest(key=key):
                obj=receipt();obj['synthetic_model']['budget'][0][key]=value
                self.assertFalse(fake_model_receipt_valid(obj,'stationary'))

    def test_budget_time_bound(self):
        for elapsed in (-1,21,float('inf'),True,3):
            obj=receipt();obj['synthetic_model']['budget'][0]['elapsed_seconds']=elapsed
            self.assertFalse(fake_model_receipt_valid(obj,'stationary'))

    def test_malformed_nested_schema(self):
        for key, value in [('schema_version',True),('budget',[None]),('calls',[None]),
                           ('calls',{}),('budget',{})]:
            obj=receipt();obj['synthetic_model'][key]=value
            self.assertFalse(fake_model_receipt_valid(obj,'stationary'))
        obj=receipt();obj['synthetic_model']=None
        self.assertFalse(fake_model_receipt_valid(obj,'stationary'))

    def test_failed_or_mismatched_response(self):
        for key,value in [('worker_reaped',False),('worker_returncode',False),('schema_version',True),
                          ('status','cancelled'),('provider_output_tokens',8),
                          ('content','{"kind":"observe"}'),('effective_timeout_seconds',0)]:
            obj=receipt();obj['synthetic_model']['calls'][0]['response'][key]=value
            self.assertFalse(fake_model_receipt_valid(obj,'stationary'))

    def test_provider_and_action_binding(self):
        for key,value in [('provider','real-model'),('provider_stopped',False)]:
            obj=receipt();obj[key]=value
            self.assertFalse(fake_model_receipt_valid(obj,'stationary'))
        obj=receipt();obj['synthetic_model']['actions']=[]
        self.assertFalse(fake_model_receipt_valid(obj,'stationary'))

    def test_action_boolean_not_integer(self):
        obj=receipt('forward')
        obj['synthetic_model']['calls'][3]['response']['content']=json.dumps(
            {'kind':'move','direction':'forward','ticks':True})
        self.assertFalse(fake_model_receipt_valid(obj,'forward'))


if __name__ == '__main__':
    unittest.main()
