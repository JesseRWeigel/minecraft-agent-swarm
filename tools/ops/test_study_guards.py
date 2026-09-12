"""Exercise operations scripts with fake npm/RCON; no world or model access."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class StudyGuards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'ops').mkdir()
        (self.root / 'bin').mkdir()
        for name in ['run-swarm.sh', 'swarm-health.sh', 'ops-state.sh', 'backup-world.sh', 'ops-mode.sh']:
            source = ROOT / 'scripts' / name
            if source.exists():
                shutil.copy2(source, self.root / 'scripts' / name)
        self.state('live')
        self.env = dict(os.environ, PATH=str(self.root / 'bin') + ':' + os.environ['PATH'], RESTART_CAP='3', COOLDOWN_S='0')
        self.fake('npm', 'echo launch >> launches; exit 143')

    def fake(self, name, code):
        target = self.root / 'bin' / name
        target.write_text('#!/bin/bash\n' + code + '\n')
        target.chmod(0o755)

    def state(self, value):
        (self.root / 'ops/state.json').write_text(json.dumps({'mode': value, 'trial': None}))

    def run_script(self, name, *args):
        return subprocess.run(['bash', str(self.root / 'scripts' / name), *args], cwd=self.root, env=self.env, capture_output=True, text=True, timeout=10)

    def test_missing_malformed_or_unknown_state_never_launches(self):
        for content in [None, '{', '{"mode":"typo"}', '{}', '{"mode":null}', '{"mode":"maintenance"}\n{"mode":"live"}']:
            with self.subTest(content=content):
                path = self.root / 'ops/state.json'
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_text(content)
                result = self.run_script('run-swarm.sh')
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / 'launches').exists())

    def test_maintenance_and_deliberate_override(self):
        self.state('maintenance')
        self.assertEqual(self.run_script('run-swarm.sh').returncode, 0)
        self.assertFalse((self.root / 'launches').exists())
        self.env['FORCE_START'] = '1'
        self.assertEqual(self.run_script('run-swarm.sh').returncode, 0)
        self.assertEqual((self.root / 'launches').read_text(), 'launch\n')

    def test_maintenance_entered_during_cooldown_prevents_next_start(self):
        self.fake('npm', 'echo launch >> launches; exit 1')
        self.fake('sleep', "printf '%s' '{\"mode\":\"maintenance\"}' > ops/state.json")
        self.assertEqual(self.run_script('run-swarm.sh').returncode, 0)
        self.assertEqual((self.root / 'launches').read_text(), 'launch\n')

    def test_invalid_mode_health_is_reported_as_invalid(self):
        (self.root / 'ops/state.json').write_text('{')
        result = self.run_script('swarm-health.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('OPS_MODE=invalid', result.stdout)
        self.assertIn('ops_state_invalid', result.stdout)

    def test_failed_state_write_preserves_previous_mode(self):
        before = (self.root / 'ops/state.json').read_bytes()
        self.fake('jq', 'exit 9')
        result = self.run_script('ops-state.sh', 'enter-maintenance', 'test')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'ops/state.json').read_bytes(), before)
        self.assertFalse((self.root / 'ops/interventions.jsonl').exists())

    def test_state_transition_and_ledger(self):
        result = self.run_script('ops-state.sh', 'enter-evaluation', 'trial-one', 'fixture')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((self.root / 'ops/state.json').read_text())['trial'], 'trial-one')
        ledger = json.loads((self.root / 'ops/interventions.jsonl').read_text())
        self.assertEqual(ledger['study_mode'], 'evaluation')

    def test_invalid_status_and_log_fail_without_ledger_write(self):
        (self.root / 'ops/state.json').write_text('{')
        self.assertNotEqual(self.run_script('ops-state.sh', 'status').returncode, 0)
        self.assertNotEqual(self.run_script('ops-state.sh', 'log', 'infra', 'probe').returncode, 0)
        self.assertFalse((self.root / 'ops/interventions.jsonl').exists())

    def test_actor_identity_is_preserved_in_state_and_ledger(self):
        self.env['OPS_BY'] = 'Codex reviewer'
        for args in [('enter-maintenance', 'fixture'), ('exit-maintenance',), ('enter-evaluation', 'trial', 'fixture'), ('log', 'infra', 'fixture'), ('exit-evaluation',)]:
            result = self.run_script('ops-state.sh', *args)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((self.root / 'ops/state.json').read_text())['by'], 'Codex reviewer')
        ledger = [json.loads(line) for line in (self.root / 'ops/interventions.jsonl').read_text().splitlines()]
        self.assertTrue(all(row['by'] == 'Codex reviewer' for row in ledger))

    def test_failed_flush_still_restores_autosave(self):
        self.fake('node', 'echo "$*" >> rcon-calls; if [[ "$*" == *save-off* ]]; then exit 7; fi')
        result = self.run_script('backup-world.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('save-on', (self.root / 'rcon-calls').read_text())


if __name__ == '__main__':
    unittest.main()
