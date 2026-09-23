"""Loopback-only Ollama transport with owned-worker deadlines; no game actions.

All tests use ephemeral fake servers. A client disconnect does not establish that
an actual inference backend stopped computing. Model/runtime identity attestation,
trusted tokenization and integration with game deadlines remain caller work.
"""
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

MAX_WIRE=65536
MAX_CONTENT=4096

def _pairs(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError()
        result[key]=value
    return result

def _constant(value):raise ValueError()
def _float(value):
    number=float(value)
    if not math.isfinite(number):raise ValueError()
    return number

def _json(raw):
    return json.loads(raw.decode('utf-8'),object_pairs_hook=_pairs,parse_constant=_constant,parse_float=_float)

def _request(model,messages,output_limit):
    if type(model) is not str or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}',model):raise ValueError()
    if type(messages) is not list or not 1<=len(messages)<=32:raise ValueError()
    characters=0
    for item in messages:
        if type(item) is not dict or set(item)!={'role','content'} or item['role'] not in ('system','user','assistant') or type(item['content']) is not str:raise ValueError()
        characters+=len(item['content'])
        if characters>MAX_WIRE:raise ValueError()
    raw=json.dumps({'model':model,'messages':messages,'stream':False,'format':'json','think':False,'options':{'num_predict':output_limit,'num_ctx':8448,'temperature':0,'seed':0}},ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')
    if len(raw)>MAX_WIRE:raise ValueError()
    return raw

def _response(raw,model,output_limit,input_tokens):
    if not raw or len(raw)>MAX_WIRE:raise ValueError()
    data=_json(raw)
    if type(data) is not dict or data.get('model')!=model or data.get('done') is not True or data.get('done_reason')!='stop':raise ValueError()
    message=data.get('message')
    if type(message) is not dict or message.get('role')!='assistant' or any(message.get(k) for k in ('thinking','tool_calls','images')):raise ValueError()
    content=message.get('content')
    if type(content) is not str or not content or len(content.encode('utf-8'))>MAX_CONTENT or type(_json(content.encode('utf-8'))) is not dict:raise ValueError()
    input_count,output_count=data.get('prompt_eval_count'),data.get('eval_count')
    for value,limit in ((input_count,8192),(output_count,output_limit)):
        if value is not None and (type(value) is not int or not 0<=value<=limit):raise ValueError()
    if input_count is not None and input_count!=input_tokens:raise ValueError()
    return content,input_count,output_count

def _worker(port):
    connection=None
    try:
        if type(port) is not int or not 1<=port<=65535:return 2
        raw=sys.stdin.buffer.read(MAX_WIRE+1)
        if not raw or len(raw)>MAX_WIRE:return 2
        connection=http.client.HTTPConnection('127.0.0.1',port,timeout=20)
        connection.request('POST','/api/chat',body=raw,headers={'Content-Type':'application/json','Connection':'close'})
        reply=connection.getresponse()
        if reply.status!=200:return 1  # Never follow redirects.
        raw=reply.read(MAX_WIRE+1)
        if len(raw)>MAX_WIRE:return 1
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()
        return 0
    except Exception:return 1
    finally:
        if connection is not None:connection.close()

def _reap(process):
    if process.poll() is None:
        try:process.terminate()
        except ProcessLookupError:pass
    try:return process.communicate(timeout=.25)
    except subprocess.TimeoutExpired:
        process.kill()
        return process.communicate(timeout=1)

def call_ollama(*,port,model,messages,input_tokens,budget,output_limit=256,cancel=None,timeout_cap=20):
    """Return bounded data only. Cancellation suppresses output and reaps our worker.

    The caller must validate returned JSON using the action broker before use.
    Every dispatched attempt reserves budget; there are no automatic retries.
    A trusted tokenizer must count the full rendered prompt, including chat framing.
    """
    from tools.pilot.inference_budget import InferenceBudget,BudgetExceeded
    result={'schema_version':1,'status':'failed','worker_reaped':True,'worker_returncode':None}
    process=None;reserved=False;output_count=None;raw=b'';content=None
    try:
        if type(port) is not int or not 1<=port<=65535:raise ValueError()
        if type(timeout_cap) not in (int,float) or not math.isfinite(timeout_cap) or not 0<timeout_cap<=20:raise ValueError()
        if not isinstance(budget,InferenceBudget):raise ValueError()
        wire=_request(model,messages,output_limit)
        if cancel is not None and cancel.is_set():result['status']='cancelled';return result
        timeout=min(budget.begin(input_tokens,output_limit),timeout_cap);reserved=True
        deadline=time.monotonic()+timeout
        result['effective_timeout_seconds']=timeout
        result['request_sha256']=hashlib.sha256(wire).hexdigest()
        process=subprocess.Popen([sys.executable,'-m','tools.pilot.ollama_adapter','--worker',str(port)],cwd=Path(__file__).resolve().parents[2],env={'PATH':os.defpath,'LANG':'C.UTF-8'},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
        first=True
        while True:
            if cancel is not None and cancel.is_set():result['status']='cancelled';break
            remaining=deadline-time.monotonic()
            if remaining<=0:result['status']='timeout';break
            try:
                raw,_=process.communicate(input=wire if first else None,timeout=min(.05,remaining))
                if cancel is not None and cancel.is_set():result['status']='cancelled';break
                if time.monotonic()>deadline:result['status']='timeout';break
                if process.returncode!=0:break
                content,input_count,output_count=_response(raw,model,output_limit,input_tokens)
                if time.monotonic()>deadline:result['status']='timeout';break
                if cancel is not None and cancel.is_set():result['status']='cancelled';break
                result.update(status='completed',provider_input_tokens=input_count,provider_output_tokens=output_count)
                break
            except subprocess.TimeoutExpired:first=False
    except Exception:
        result['status']='failed'
    finally:
        if process is not None:
            try:
                _reap(process)
                result['worker_returncode']=process.returncode
                result['worker_reaped']=process.returncode is not None
            except Exception:result.update(status='cleanup_uncertain',worker_reaped=False)
        if result['status']=='completed':
            if cancel is not None and cancel.is_set():result['status']='cancelled'
            elif time.monotonic()>deadline:result['status']='timeout'
        if raw:result['response_sha256']=hashlib.sha256(raw).hexdigest()
        if reserved:
            try:budget.finish(output_count if result['status']=='completed' else None,outcome='completed' if result['status']=='completed' else 'cancelled' if result['status']=='cancelled' else 'failed')
            except BudgetExceeded:result['status']='failed'
    if result['status']=='completed':result['content']=content
    return result

if __name__=='__main__':
    try:code=_worker(int(sys.argv[2])) if len(sys.argv)==3 and sys.argv[1]=='--worker' else 2
    except Exception:code=2
    raise SystemExit(code)
