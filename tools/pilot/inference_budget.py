"""Accounting only for the proposed first pilot; no provider calls or cancellation.

A future trusted adapter must tokenize inputs, enforce begin()'s returned wall
limit and requested token limit, cancel timed-out work, and always call finish().
Caller-owned clocks and usage are trusted evidence inputs, not model assertions.
No money/energy cost is inferred. Caps are provisional, not a frozen study.
"""
from dataclasses import dataclass
import math
import time

class BudgetExceeded(ValueError):
    """Invalid accounting or an exhausted limit permanently closes this ledger."""

@dataclass(frozen=True)
class CallRecord:
    sequence: int
    input_tokens: int
    reserved_output_tokens: int
    actual_output_tokens: int | None
    charged_output_tokens: int
    usage_known: bool
    elapsed_seconds: float
    outcome: str

class InferenceBudget:
    def __init__(self, *, clock=time.monotonic):
        self._clock=clock
        self._failed=False
        self._last=None
        self._pending=None
        self._records=[]
        self._calls=0
        self._output=0
        self._inference=0.
        self._start=self._now()

    @property
    def failed(self):return self._failed
    @property
    def calls_used(self):return self._calls
    @property
    def output_tokens_used(self):return self._output
    @property
    def inference_seconds_used(self):return self._inference
    @property
    def records(self):return tuple(self._records)

    def _reject(self):
        self._failed=True
        raise BudgetExceeded('inference budget unavailable')

    def _now(self):
        if self._failed:self._reject()
        try:value=self._clock()
        except Exception:self._reject()
        if type(value) not in (int,float):self._reject()
        try:valid=math.isfinite(value) and value>=0 and (self._last is None or value>=self._last)
        except (OverflowError,TypeError):self._reject()
        if not valid:self._reject()
        self._last=value
        return value

    def begin(self,input_tokens,output_limit=256):
        now=self._now()
        if self._pending is not None:self._reject()
        if type(input_tokens) is not int or not 0<=input_tokens<=8192:self._reject()
        if type(output_limit) is not int or not 1<=output_limit<=256:self._reject()
        timeout=min(20.,90.-self._inference,120.-(now-self._start))
        if timeout<=0 or self._calls>=8 or self._output+output_limit>2048:self._reject()
        self._calls+=1
        self._output+=output_limit
        self._pending=(now,input_tokens,output_limit,timeout)
        return timeout

    def finish(self,actual_output_tokens=None,*,outcome='completed'):
        now=self._now()
        if self._pending is None:self._reject()
        started,input_tokens,reserved,timeout=self._pending
        invalid_usage=actual_output_tokens is not None and (type(actual_output_tokens) is not int or not 0<=actual_output_tokens<=reserved)
        invalid_outcome=type(outcome) is not str or outcome not in ('completed','failed','cancelled')
        elapsed=now-started
        self._inference+=elapsed
        if invalid_usage or invalid_outcome:
            self._records.append(CallRecord(self._calls,input_tokens,reserved,None,reserved,False,elapsed,'invalid_accounting'))
            self._pending=None
            self._reject()
        over=elapsed>timeout or self._inference>90 or now-self._start>120
        # Errors/timeouts/unknown usage retain the entire pre-dispatch reservation.
        charged=actual_output_tokens if not over and outcome=='completed' and actual_output_tokens is not None else reserved
        self._output-=reserved-charged
        record=CallRecord(self._calls,input_tokens,reserved,actual_output_tokens,charged,actual_output_tokens is not None,elapsed,'budget_exceeded' if over else outcome)
        self._records.append(record)
        self._pending=None
        if over:self._reject()
        return record

