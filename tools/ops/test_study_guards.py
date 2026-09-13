"""Exercise operations scripts with fake npm/RCON; no world or model access."""
import hashlib
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
        for name in ['run-swarm.sh', 'launch-context.sh', 'swarm-health.sh', 'ops-state.sh', 'backup-world.sh', 'ops-mode.sh']:
            source = ROOT / 'scripts' / name
            if source.exists():
                shutil.copy2(source, self.root / 'scripts' / name)
        self.state('live')
        (self.root / 'tracked.txt').write_text('initial\n')
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True)
        subprocess.run(['git', 'config', 'user.email', 'fixture@example.invalid'], cwd=self.root, check=True)
        subprocess.run(['git', 'config', 'user.name', 'Fixture'], cwd=self.root, check=True)
        subprocess.run(['git', 'add', '.'], cwd=self.root, check=True)
        subprocess.run(['git', 'commit', '-qm', 'fixture'], cwd=self.root, check=True)
        self.env = dict(os.environ, PATH=str(self.root / 'bin') + ':' + os.environ['PATH'], RESTART_CAP='3', COOLDOWN_S='0')
        self.fake('npm', 'echo launch >> launches; exit 143')

    def fake(self, name, code):
        target = self.root / 'bin' / name
        target.write_text('#!/bin/bash\n' + code + '\n')
        target.chmod(0o755)

    def state(self, value, trial=None):
        (self.root / 'ops/state.json').write_text(json.dumps({'mode': value, 'trial': trial}))

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

    def test_launch_exports_commit_clean_diff_and_leaves_unknown_fields_empty(self):
        self.env['DATASET_TRIAL_ID'] = 'stale-trial'
        self.env['DATASET_WORLD_SNAPSHOT_ID'] = 'b' * 64
        self.fake('npm', 'env | sort > launch-env; exit 143')
        result = self.run_script('run-swarm.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        env = dict(line.split('=', 1) for line in (self.root / 'launch-env').read_text().splitlines() if '=' in line)
        commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()
        self.assertEqual(env['DATASET_GIT_COMMIT'], commit)
        self.assertEqual(env['DATASET_DIRTY_DIFF_HASH'], hashlib.sha256(b'').hexdigest())
        self.assertEqual(env['DATASET_OPERATION_MODE'], 'live')
        self.assertNotIn('DATASET_TRIAL_ID', env)
        self.assertNotIn('DATASET_WORLD_SNAPSHOT_ID', env)
        manifest = json.loads(env['SWARM_LAUNCH_CONTEXT_JSON'])
        self.assertEqual(manifest['git_commit'], commit)
        self.assertEqual(manifest['runtime_command'], ['npm', 'start'])

    def test_tracked_dirty_hash_is_recaptured_for_each_restart(self):
        self.fake('npm', '''
count=$(wc -l < launches 2>/dev/null || echo 0)
printf '%s\n' "$DATASET_DIRTY_DIFF_HASH" >> hashes
echo launch >> launches
if [[ "$count" == "0" ]]; then printf 'changed\n' > tracked.txt; exit 1; fi
exit 143
''')
        result = self.run_script('run-swarm.sh')
        self.assertEqual(result.returncode, 0, result.stderr)
        hashes = (self.root / 'hashes').read_text().splitlines()
        self.assertEqual(hashes[0], hashlib.sha256(b'').hexdigest())
        expected = subprocess.run(['git', 'diff', '--binary', 'HEAD', '--', '.'], cwd=self.root, check=True, capture_output=True).stdout
        self.assertEqual(hashes[1], hashlib.sha256(expected).hexdigest())
        self.assertNotEqual(hashes[0], hashes[1])

    def test_evaluation_requires_trial_and_sha256_world_snapshot_before_launch(self):
        for trial, snapshot in [(None, 'a' * 64), ('trial-a', None), ('trial-a', 'snapshot-label')]:
            with self.subTest(trial=trial, snapshot=snapshot):
                (self.root / 'launches').unlink(missing_ok=True)
                self.state('evaluation', trial)
                if snapshot is None:
                    self.env.pop('WORLD_SNAPSHOT_ID', None)
                else:
                    self.env['WORLD_SNAPSHOT_ID'] = snapshot
                result = self.run_script('run-swarm.sh')
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / 'launches').exists())

    def test_evaluation_exit_never_automatically_restarts_trial(self):
        self.state('evaluation', 'trial-a')
        self.env['WORLD_SNAPSHOT_ID'] = 'a' * 64
        self.fake('npm', 'echo launch >> launches; env | sort > launch-env; exit 1')
        result = self.run_script('run-swarm.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'launches').read_text(), 'launch\n')
        env = dict(line.split('=', 1) for line in (self.root / 'launch-env').read_text().splitlines() if '=' in line)
        self.assertEqual(env['DATASET_TRIAL_ID'], 'trial-a')
        self.assertEqual(env['DATASET_WORLD_SNAPSHOT_ID'], 'a' * 64)

    def test_duplicate_state_keys_and_untracked_evaluation_source_fail_closed(self):
        (self.root / 'ops/state.json').write_text('{"mode":"live","mode":"evaluation","trial":"trial-a"}')
        self.env['WORLD_SNAPSHOT_ID'] = 'a' * 64
        result = self.run_script('run-swarm.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'launches').exists())

        self.state('evaluation', 'trial-a')
        (self.root / 'src').mkdir()
        (self.root / 'src/untracked.ts').write_text('export {}\n')
        result = self.run_script('run-swarm.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'launches').exists())

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

    def test_invalid_backup_mode_fails_before_rcon_or_backup_creation(self):
        (self.root / 'ops/state.json').write_text('{')
        self.fake('node', 'echo invoked >> rcon-calls; exit 7')
        result = self.run_script('backup-world.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'rcon-calls').exists())
        self.assertFalse((self.root / 'backups').exists())

    def test_failed_archive_validation_never_logs_a_successful_backup(self):
        self.fake('node', 'exit 0')
        self.fake('sleep', 'exit 0')
        self.fake('tar', 'echo fixture')
        self.fake('zstd', 'if [[ "$1" == "-t" ]]; then exit 9; fi; while [[ "$1" != "-o" ]]; do shift; done; shift; cat > "$1"')
        result = self.run_script('backup-world.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'backups/MANIFEST.tsv').exists())
        self.assertFalse((self.root / 'ops/interventions.jsonl').exists())

    def test_failed_flush_still_restores_autosave(self):
        self.fake('node', 'echo "$*" >> rcon-calls; if [[ "$*" == *save-off* ]]; then exit 7; fi')
        result = self.run_script('backup-world.sh')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('save-on', (self.root / 'rcon-calls').read_text())


if __name__ == '__main__':
    unittest.main()
