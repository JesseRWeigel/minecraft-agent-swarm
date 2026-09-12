"""Conservative, versioned legacy labels; never alter source observations."""
import re

LABEL_VERSION = 'legacy-text-v1'


def classify_legacy(row: dict) -> dict:
    original = row.get('success')
    result = row.get('result')
    text = result if isinstance(result, str) else ''
    status, reason = 'unknown', 'unverified_legacy_outcome'
    if re.match(r'^Blocked: "[^"\n]+" recently failed\.', text):
        status, reason = 'blocked', 'recent_failure_gate'
    elif re.match(r'^Action "[^"\n]+" not allowed for [^\n]+\. Use:', text):
        status, reason = 'blocked', 'policy_denied'
    elif re.match(r'^Action "[^"\n]+" timed out after \d+s', text):
        status, reason = 'timed_out', 'execution_timeout'
    elif text.startswith('Action failed: Navigation timed out'):
        status, reason = 'timed_out', 'navigation_timeout'
    elif text.startswith('Action failed: '):
        status, reason = 'failed', 'reported_execution_failure'
    return {'original_success': original if type(original) is bool else None,
            'revised_status': status, 'reason_code': reason,
            'label_version': LABEL_VERSION,
            'evidence_kind': 'explicit_result_text' if status != 'unknown' else 'unverified_result_text',
            'review_required': True}
