import json, os, tempfile, unittest
from pathlib import Path
from unittest import mock
from tools.pilot.qualification import run_qualification, QualificationError, QUAL_PROPERTIES
from tools.pilot.server import ProcessResult
LIFE = {'schema_version': 1, 'status': 'passed', 'readiness': 'ready', 'client': 'exited', 'client_returncode': 0, 'java_returncode': 0, 'stop_sent': True, 'term_sent': False, 'kill_sent': False}

def evidence(mode="forward", passed=True):
    distance = 1.0 if mode == "forward" else 0.0
    return {
        "schemaVersion": 1,
        "status": "passed" if passed else "failed",
        "claimsLiveBenchmarkResult": False,
        "endpoint": {"host": "127.0.0.1", "gamePort": 25585, "rconPort": 25595},
        "username": "PilotProbe",
        "movementMode": mode,
        "before": {
            "position": {"x": 0, "y": 64, "z": 0},
            "dimension": "minecraft:overworld",
            "health": 20,
        },
        "after": {
            "position": {"x": distance, "y": 64, "z": 0},
            "dimension": "minecraft:overworld",
            "health": 20,
        },
        "mineflayer": {"after": {"x": distance, "y": 64, "z": 0}},
        "checks": {"transportIntact": True},
    }

class Tests(unittest.TestCase):

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = Path(self.t.name)
        self.tools = self.root / 'tools'
        (self.tools / 'bin').mkdir(parents=True)
        (self.tools / 'node_modules').mkdir()
        (self.tools / 'bin/node').write_text('node')
        (self.tools / 'qualification-client.mjs').write_text('client')

    def tearDown(self):
        self.t.cleanup()

    def restore(self, output, **kw):
        output.mkdir(mode=448)
        os.chmod(output, 448)
        (output / 'server.properties').write_text('base')
        os.chmod(output / 'server.properties', 384)
        (output / 'runtime-manifest.json').write_text('{}')
        os.chmod(output / 'runtime-manifest.json', 384)
        return {'snapshot_sha256': 'a' * 64, 'server_jar_sha256': 'b' * 64}

    def result(self, code=0, **kw):
        return ProcessResult('exited', code, None, kw.get('timed_out', False), False, False, False, False, kw.get('uncertain', False), b'', b'', kw.get('truncated', False), False, 0.1)

    def runner(self, life=LIFE, ev=None, code=0):

        def run(argv, **kw):
            for name, value in [('qualification-evidence.json', ev or evidence()), ('namespace-result.json', life)]:
                p = kw['cwd'] / name
                p.write_text(json.dumps(value))
                os.chmod(p, 384)
            self.argv = argv
            return self.result(code)
        return run

    def call(self, name='work', **kw):
        with mock.patch('tools.pilot.qualification.restore_mod.verify_runtime', return_value={}), mock.patch('tools.pilot.qualification.verify_tools', return_value={}):
            return run_qualification(workspace=self.root / name, restore_kwargs={}, tool_snapshot=self.tools, tool_manifest_sha256='c' * 64, restore_fn=self.restore, validate_executables=False, **kw)

    def test_fixed_contract_private_and_hashed(self):
        report = self.call(runner=self.runner())
        self.assertEqual(report['status'], 'completed')
        self.assertIn('--unshare-net', self.argv)
        self.assertNotIn('rcon.password', ' '.join(self.argv))
        self.assertEqual(len(report['evidence_sha256']), 64)
        self.assertFalse(report['independent_observer_process'])
        self.assertFalse((self.root / 'work/runtime/.qualification-rcon-password').exists())
        self.assertEqual((self.root / 'work').stat().st_mode & 511, 448)
        self.assertIn(QUAL_PROPERTIES, (self.root / 'work/runtime/server.properties').read_text())
        self.assertTrue(report['qualification_config']['retained_private_rcon_credential'])

    def test_lifecycle_false_positive_never_completes(self):
        for i, patch in enumerate([{'java_returncode': 1}, {'term_sent': True}, {'stop_sent': False}, {'status': 'passed', 'readiness': 'timeout'}]):
            life = {**LIFE, **patch}
            self.assertEqual(self.call(f'f{i}', runner=self.runner(life=life))['status'], 'failed')

    def test_stationary_is_recorded_negative_control_and_flagged(self):
        life = {**LIFE, 'status': 'failed', 'client_returncode': 1}
        report = self.call('stationary', movement_mode='stationary', runner=self.runner(life=life, ev=evidence('stationary', False), code=1))
        self.assertEqual(report['status'], 'failed')
        self.assertTrue(report['negative_control_observed'])
        self.assertEqual(self.argv[-1], 'stationary')

    def test_stationary_large_motion_or_transport_failure_is_not_a_control(self):
        life = {**LIFE, "status": "failed", "client_returncode": 1}
        moved = evidence("stationary", False)
        moved["after"]["position"]["x"] = 11
        moved["mineflayer"]["after"]["x"] = 11
        report = self.call("stationary-moved", movement_mode="stationary", runner=self.runner(life=life, ev=moved, code=1))
        self.assertFalse(report["negative_control_observed"])
        broken = evidence("stationary", False)
        broken["checks"]["transportIntact"] = False
        report = self.call("stationary-broken", movement_mode="stationary", runner=self.runner(life=life, ev=broken, code=1))
        self.assertFalse(report["negative_control_observed"])

    def test_bool_codes_and_non_numeric_positions_never_pass(self):
        for index, patch in enumerate([
            {"schema_version": True},
            {"client_returncode": False},
            {"java_returncode": False},
        ]):
            report = self.call(
                f"bool-life-{index}",
                runner=self.runner(life={**LIFE, **patch}),
            )
            self.assertEqual(report["status"], "failed")
        for index, bad_value in enumerate([True, "1"]):
            malformed = evidence()
            malformed["before"]["position"]["x"] = bad_value
            report = self.call(
                f"bad-position-{index}", runner=self.runner(ev=malformed)
            )
            self.assertEqual(report["status"], "failed")
        malformed = evidence()
        malformed["schemaVersion"] = True
        self.assertEqual(
            self.call("bool-schema", runner=self.runner(ev=malformed))["status"],
            "failed",
        )

    def test_runner_exception_still_writes_failed_summary(self):
        report = self.call('raised', runner=lambda *a, **k: (_ for _ in ()).throw(RuntimeError('secret')))
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['error'], 'qualification launch failed')
        self.assertTrue((self.root / 'raised/qualification-summary.json').is_file())

    def test_path_and_inputs_fail_closed(self):
        with self.assertRaises(QualificationError):
            run_qualification(workspace=Path('relative'), restore_kwargs={}, tool_snapshot=self.tools, tool_manifest_sha256='c' * 64)
        with self.assertRaises(QualificationError):
            self.call('badmode', movement_mode='sideways')
        existing = self.root / 'existing'
        existing.mkdir()
        with self.assertRaises(QualificationError):
            run_qualification(workspace=existing, restore_kwargs={}, tool_snapshot=self.tools, tool_manifest_sha256='c' * 64)

    def test_malformed_or_symlink_evidence_never_completes(self):
        self.assertEqual(self.call('malformed', runner=self.runner(ev={'status': 'passed'}))['status'], 'failed')

        def symlink_runner(argv, **kw):
            target = kw['cwd'] / 'elsewhere.json'
            target.write_text(json.dumps(evidence()))
            os.chmod(target, 384)
            (kw['cwd'] / 'qualification-evidence.json').symlink_to(target)
            life = kw['cwd'] / 'namespace-result.json'
            life.write_text(json.dumps(LIFE))
            os.chmod(life, 384)
            return self.result()
        self.assertEqual(self.call('symlink-evidence', runner=symlink_runner)['status'], 'failed')

    def test_symlinked_workspace_parent_is_rejected(self):
        real = self.root / 'real'
        real.mkdir()
        link = self.root / 'link'
        link.symlink_to(real, target_is_directory=True)
        with self.assertRaises(QualificationError):
            run_qualification(workspace=link / 'child', restore_kwargs={}, tool_snapshot=self.tools, tool_manifest_sha256='c' * 64)
if __name__ == '__main__':
    unittest.main()
