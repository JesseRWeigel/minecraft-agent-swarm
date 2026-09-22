"""Fixed oak-log supervisor, only launched inside the protected outer namespace."""
import json, math, os, subprocess, sys, time
from pathlib import Path
from tools.pilot.protected_worker import capture_process, participant_argv, write_result, wait_port, stop_server
from tools.pilot.participant_transport import ParticipantTransport
from tools.pilot.game_bridge import GameBridge

TRIAL="collect-oak-log-v1"
ACTION="collect-01"
FIXTURE_SHA256="b8d4a036e735f449674c207c94af99be2dc40680245ceb56c4f7c2a76e91a942"
BLOCKED_FIXTURE_SHA256="5dd6ea35b37631087390babda3044ce60fd9800b75bb150a5ec68d50a3100a39"
FAILURE_CASES=("none", "item_only", "item_and_block", "observer_timeout", "mid_action_disconnect")

def fault_mode_valid(fault, mode):
    if mode not in ('forward','stationary','mine_only','blocked'):return False
    if fault=='none':return True
    if fault in ('item_only','item_and_block'):return mode=='stationary'
    return fault in ('observer_timeout','mid_action_disconnect') and mode=='forward'


def fixture_valid(value,mode="forward"):
    if mode=="blocked":
        if not isinstance(value,dict):return False
        setup=value.get('setup');check=value.get('baselineVerification')
        if not isinstance(setup,dict) or not isinstance(check,dict) or not isinstance(setup.get('fixture'),dict):return False
        receipts=setup.get('commandReceipts');checks=setup.get('blockChecks')
        parent={**value,'setup':setup.get('parentSetup')}
        return (setup.get('status')=='configured' and setup['fixture'].get('sha256')==BLOCKED_FIXTURE_SHA256
            and isinstance(receipts,list) and len(receipts)==5 and all(isinstance(x,dict) and x.get('outcome')=='issued' for x in receipts)
            and isinstance(checks,list) and len(checks)==6 and all(isinstance(x,dict) and x.get('status')=='verified' for x in checks)
            and fixture_valid(parent,'forward'))
    if not isinstance(value,dict):return False
    setup=value.get('setup');verification=value.get('baselineVerification')
    if not isinstance(setup,dict) or not isinstance(verification,dict) or not isinstance(setup.get('fixture'),dict):return False
    receipts=setup.get('commandReceipts');checks=setup.get('blockChecks');parent=setup.get('parentSetup')
    return (value.get('schema_version')==1 and value.get('phase')=='fixture' and setup.get('status')=='configured'
        and setup['fixture'].get('sha256')==FIXTURE_SHA256 and verification.get('status')=='verified'
        and isinstance(parent,dict) and parent.get('status')=='configured'
        and isinstance(receipts,list) and len(receipts)==7 and all(isinstance(x,dict) and x.get('outcome')=='issued' for x in receipts)
        and isinstance(checks,list) and len(checks)==7 and all(isinstance(x,dict) and x.get('status')=='verified' for x in checks)
        and baseline_valid(value.get('baseline')))

def baseline_valid(s):
    if not isinstance(s,dict) or s.get('status')!='sampled' or s.get('taskId')!=TRIAL or s.get('trialId')!=TRIAL or s.get('actionId')!=ACTION or s.get('phase')!='before':return False
    a=s.get('actorSample');o=a.get('observations') if isinstance(a,dict) else None
    if not isinstance(o,dict):return False
    return (s.get('inventory')==[] and s.get('targetBlock')=='minecraft:oak_log' and a.get('status')=='sampled'
        and o.get('uuid')=='f14b12b9-4db5-3b00-ab8c-cdacc19f233d' and o.get('roster')==['PilotProbe']
        and o.get('gameMode')==0 and o.get('health')==20 and o.get('dimension')=='minecraft:overworld'
        and o.get('position')=={'x':0.5,'y':200,'z':0.5})

def observe(phase,password,blocked=False,suspend_for_test=False):
    if suspend_for_test and phase!="terminal":raise ValueError("only terminal observer may be suspended")
    cli="oak-blocked-observer-cli.mjs" if blocked and phase=="fixture" else "oak-observer-cli.mjs"
    c=capture_process(['/pilot-tools/bin/node','--max-old-space-size=256','/observer-code/'+cli],
        {'schema_version':1,'phase':phase,'trial_id':TRIAL,'action_id':ACTION,'password':password},
        timeout=2 if suspend_for_test else 30,suspend_for_test=suspend_for_test)
    for channel in ('stdout','stderr'):
        p=Path('observer-'+phase+'.'+channel)
        fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'wb') as f:f.write(c[channel])
    try:v=json.loads(c['stdout'])
    except (ValueError,UnicodeError):v=None
    record={k:v for k,v in c.items() if k not in ('stdout','stderr')};record['result']=v
    write_result('observer-'+phase+'.json',record)
    if c['error'] or c['returncode']!=0 or not isinstance(v,dict):raise RuntimeError('observer failed')
    return v

def inject_fault(mode,password):
    captured=capture_process(['/pilot-tools/bin/node','--max-old-space-size=256','/observer-code/oak-fault-cli.mjs'],
        {'schema_version':1,'mode':mode,'trial_id':TRIAL,'action_id':ACTION,'password':password,'operation_timeout_ms':5000})
    try:value=json.loads(captured['stdout'])
    except (ValueError,UnicodeError):value=None
    receipt={k:v for k,v in captured.items() if k not in ('stdout','stderr')}
    receipt['result']=value
    write_result('fault-injection.json',receipt)
    if captured['error'] or captured['returncode']!=0 or not isinstance(value,dict) or value.get('status')!='completed' or value.get('mode')!=mode:
        raise RuntimeError('fault injection failed')
    return value


def score_files(node,code,runtime):
    c=capture_process([str(node),'--max-old-space-size=256',str(code/'oak-score-cli.mjs'),str(runtime)],{},timeout=5)
    if c['error'] or c['returncode']!=0:return None
    try:return json.loads(c['stdout'])
    except (ValueError,UnicodeError):return None

def endpoint_valid(value,mode,before,terminal):
    if not all(isinstance(x,dict) for x in (value,before,terminal)):return False
    verification=value.get('baselineVerification');e=value.get('endpoint')
    if not isinstance(verification,dict) or verification.get('status')!='verified' or not isinstance(e,dict):return False
    if e.get('status')!='observed' or e.get('gameplayQualified') is not False:return False
    if mode=='forward':return e.get('acquired') is True
    if mode in ('mine_only','blocked'):
        if e.get('acquired') is not False or terminal.get('inventory')!=[]:return False
        try:
            start=before['actorSample']['observations']['position'];end=terminal['actorSample']['observations']['position']
            if mode=='mine_only':return terminal.get('targetBlock')=='minecraft:air' and start==end
            return (terminal.get('targetBlock')=='minecraft:oak_log' and abs(end['x']-start['x'])<0.1
                and abs(end['y']-start['y'])<0.1 and 0.1<end['z']-start['z']<2)
        except (KeyError,TypeError):return False
    if mode!='stationary':return False
    return (e.get('acquired') is False and terminal.get('inventory')==[] and terminal.get('targetBlock')=='minecraft:oak_log'
        and isinstance(terminal.get('actorSample'),dict) and isinstance(before.get('actorSample'),dict)
        and terminal['actorSample'].get('observations',{}).get('position')==before['actorSample'].get('observations',{}).get('position'))

def main():
    if len(sys.argv) not in (2,3) or sys.argv[1] not in ('forward','stationary','mine_only','blocked') or not fault_mode_valid(sys.argv[2] if len(sys.argv)==3 else 'none',sys.argv[1]):return 2
    if os.readlink('/proc/self/ns/net')==Path('/observer-code/host-network-namespace').read_text().strip():raise RuntimeError('private namespace required')
    mode=sys.argv[1];fault=sys.argv[2] if len(sys.argv)==3 else 'none';password=Path('.qualification-rcon-password').read_text().strip()
    result={'schema_version':1,'status':'failed','control_mode':mode,'trial_id':TRIAL,'action_id':ACTION,'failure_case':fault,'injection':None,
        'independent_observer_process':False,'network_policy':'game_only_unix_v1','game_bridge':None,'participant_returncode':None,'java_returncode':None,
        'stop_sent':False,'term_sent':False,'kill_sent':False,'participant_forced_cleanup':False,'before':None,'during':None,'terminal':None,'fixture':None,'score':None,'error':None,'stage':'server_start','action_finished_received':False}
    server=participant=transport=bridge=None
    try:
        server=subprocess.Popen(['/usr/bin/java','-Xms512M','-Xmx2G','-Djava.awt.headless=true','-jar','server.jar','--nogui'],stdin=subprocess.PIPE,close_fds=True,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(Path.cwd())})
        deadline=time.monotonic()+60
        if not (wait_port(25585,deadline,server) and wait_port(25595,deadline,server)):raise RuntimeError('server readiness')
        bridge=GameBridge(Path.cwd()/'game-bridge')
        args=participant_argv('forward' if mode in ('mine_only','blocked') else mode);args[-1]=mode;args[args.index('/participant-code/game_bridge_client.py')]='/participant-code/oak_bridge_client.py'
        participant=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True,bufsize=0,env={'PATH':'/usr/bin:/bin'})
        transport=ParticipantTransport(participant,trial_id=TRIAL,action_id=ACTION);transport.wait_ready()
        result['stage']='fixture';result['fixture']=observe('fixture',password,blocked=mode=='blocked')
        if not fixture_valid(result['fixture'],mode):raise RuntimeError('fixture invalid')
        result['before']=observe('before',password);result['independent_observer_process']=True
        if not baseline_valid(result['before']):raise RuntimeError('baseline invalid')
        result['stage']='action';result['action_started_monotonic']=time.monotonic();transport.send_begin()
        result['action_begin_sent_monotonic']=time.monotonic()
        if fault=='mid_action_disconnect':
            time.sleep(.2)
            result['during']=observe('during',password)
            result['injection_requested_monotonic']=time.monotonic()
            result['injection']=inject_fault(fault,password)
            try:
                transport.wait_action_finished()
                result['action_finished_received']=True
                result['action_finished_monotonic']=time.monotonic()
            except Exception:
                result['action_finished_received']=False
            result['stage']='interrupted_action'
            try:result['terminal']=observe('terminal',password)
            except Exception:pass
            # Preserve a raced completion; it must never be called an interruption.
            raise RuntimeError('deliberate action interruption')
        transport.wait_action_finished()
        result['action_finished_monotonic']=time.monotonic();result['action_finished_received']=True
        if result['action_finished_monotonic']-result['action_started_monotonic']>20:raise RuntimeError('action budget exceeded')
        time.sleep(.3)
        if fault in ('item_only','item_and_block'):
            result['stage']='fault_injection';result['injection']=inject_fault(fault,password)
            time.sleep(.3)
        result['stage']='terminal';result['terminal']=observe('terminal',password,suspend_for_test=fault=='observer_timeout')
        result['score']=score_files(Path('/pilot-tools/bin/node'),Path('/observer-code'),Path.cwd())
        result['stage']='finalize';transport.send_finalize();transport.wait_exit()
    except Exception:result['error']='oak_qualification_failed'
    finally:
        if participant is not None:
            try:
                if participant.poll() is None:result['participant_forced_cleanup']=True;participant.kill();participant.wait(timeout=5)
                result['participant_returncode']=participant.returncode
            except Exception:result['error']='participant_cleanup_uncertain'
        if transport is not None:
            try:write_result('participant-diagnostics.json',{'stderr':transport.stderr.decode(errors='replace'),'stdout_bytes':transport.stdout_bytes});transport.close()
            except Exception:result['error']='participant_pipe_cleanup_failed'
        if bridge is not None:
            result['game_bridge']=bridge.close()
            if result['game_bridge']['status']!='completed':result['error']=result['error'] or 'game_bridge_failed'
        try:stop_server(server,result)
        except Exception:result['error']='server_cleanup_uncertain'
        clean=result['error'] is None and result['participant_returncode']==0 and result['java_returncode']==0 and result['stop_sent'] and not any(result[k] for k in ('term_sent','kill_sent','participant_forced_cleanup'))
        accepted=endpoint_valid(result['score'],mode,result['before'],result['terminal'])
        result['status']='qualified' if fault=='none' and clean and accepted else 'failed'
        write_result('protected-result.json',result)
    return 0 if result['status']=='qualified' else 1

if __name__=='__main__':raise SystemExit(main())
