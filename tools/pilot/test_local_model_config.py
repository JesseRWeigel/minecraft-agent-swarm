"""Local-model integration gates; never loads a model or changes host settings."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.pilot import local_model_config as config
from tools.pilot.oak_worker import action_driver_valid
from tools.pilot.oak_qualification import run_oak_qualification, capture_sources, validate_result
from tools.pilot.scoped_trial import PROFILES


class LocalModelConfigTests(unittest.TestCase):
    def test_driver_mode_fault_gate(self):
        for mode in ("forward","stationary","mine_only","blocked","unknown"):
            for fault in ("none","scripted_deadline","observer_timeout","item_only"):
                self.assertEqual(action_driver_valid("local_model",mode,fault),
                                 mode=="forward" and fault=="none")
        self.assertTrue(action_driver_valid("fixed","forward","none"))
        self.assertTrue(action_driver_valid("scripted","stationary","none"))
        self.assertTrue(action_driver_valid("fake_model","forward","none"))

    def test_profile_limits(self):
        self.assertEqual(PROFILES["local_model"],dict(memory=16*1024**3,tasks=256,cpu_percent=200))
        self.assertEqual(PROFILES["game"]["memory"],4*1024**3)

    def test_explicit_config_and_profile_before_mutation(self):
        base=dict(launch=True,workspace=Path("/never-created"),restore_kwargs={},
                  tool_snapshot=None,tool_manifest_sha256=None)
        cases=[
            dict(action_driver="local_model"),
            dict(action_driver="local_model",resource_profile="local_model"),
            dict(action_driver="fixed",resource_profile="local_model"),
            dict(action_driver="scripted",local_model_config={}),
            dict(action_driver="local_model",resource_profile="local_model",local_model_config={},control_mode="stationary")]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(ValueError):
                run_oak_qualification(**base,**args)

    def test_pin_mismatch_fails_before_launch(self):
        with patch("tools.pilot.oak_qualification.verify_config",side_effect=ValueError("changed")) as verify:
            with self.assertRaisesRegex(ValueError,"changed"):
                run_oak_qualification(launch=True,workspace=Path("/never-created"),restore_kwargs={},
                    tool_snapshot=None,tool_manifest_sha256=None,action_driver="local_model",
                    resource_profile="local_model",local_model_config={})
            verify.assert_called_once_with({})

    def test_config_exact_type_binding(self):
        pinned={"schema_version":1,"runtime":"/fixed","environment":{"flag":"1"}}
        with patch.object(config,"pin_local_model",return_value=pinned):
            self.assertEqual(config.verify_config(copy.deepcopy(pinned)),pinned)
            for bad in (None,{}, {**pinned,"schema_version":True}, {**pinned,"runtime":"/other"}):
                with self.subTest(bad=bad), self.assertRaises(ValueError):
                    config.verify_config(bad)

    def test_cleanup_receipts_fail_closed(self):
        good=dict(status="closed",backend_reaped=True,process_group_gone=True,log_reader_stopped=True,gpu_verified=True)
        self.assertTrue(config.backend_cleanup_valid(good))
        for bad in (None,{},dict(good,backend_reaped=1),dict(good,process_group_gone=False),
                    dict(good,status="cleanup_uncertain"),dict(good,log_reader_stopped=False),dict(good,gpu_verified=False)):
            with self.subTest(bad=bad):
                self.assertFalse(config.backend_cleanup_valid(bad))

    def test_infrastructure_separate_from_acquired_with_strict_cleanup(self):
        rows=json.loads((Path(__file__).parents[2]/"docs/research/oak-negative-results-2026-09-22.json").read_text())["attempts"]
        row=rows[2]
        fixture={"schema_version":1,"phase":"fixture","baseline":row["before"],
            "baselineVerification":{"status":"verified"},"setup":{"status":"configured",
            "fixture":{"sha256":"b8d4a036e735f449674c207c94af99be2dc40680245ceb56c4f7c2a76e91a942"},
            "parentSetup":{"status":"configured"},"commandReceipts":[{"outcome":"issued"}]*7,
            "blockChecks":[{"status":"verified"}]*7}}
        value={**row["lifecycle"],"schema_version":1,"status":"qualified","failure_case":"none",
            "control_mode":"forward","trial_id":"collect-oak-log-v1","action_id":"collect-01",
            "independent_observer_process":True,"error":None,"network_policy":"game_only_unix_v1",
            "fixture":fixture,"before":row["before"],"terminal":row["terminal"],
            "action_started_monotonic":10,"action_finished_monotonic":14,"injection":None,
            "action_driver":"local_model","action_output_eof":True,"action_script":{},
            "local_backend_start":{"status":"ready","gpu_verified":True},
            "local_backend_warmup":dict(schema_version=1,status="completed",content='{"ready":true}',
                worker_reaped=True,input_tokens=20,output_tokens=5,tokens_evaluated=20,
                stop_type="eos",truncated=False,reserved_output_tokens=32,elapsed_seconds=.1),
            "local_backend":dict(status="closed",backend_reaped=True,process_group_gone=True,
                                 log_reader_stopped=True,gpu_verified=True),"task_acquired":False}
        score={"baselineVerification":{"status":"verified"},
               "endpoint":{"status":"observed","gameplayQualified":False,"acquired":False}}
        # This isolates outer lifecycle gates; real receipt validator has dedicated broker tests.
        with patch("tools.pilot.oak_qualification.real_model_receipt_valid",return_value=True):
            self.assertTrue(validate_result(value,"forward",score,action_driver="local_model"))
            for key,bad in [("local_backend_start",None),("local_backend",{}),
                            ("action_output_eof",False),("task_acquired",True),("local_backend_warmup",None)]:
                changed=copy.deepcopy(value);changed[key]=bad
                self.assertFalse(validate_result(changed,"forward",score,action_driver="local_model"),key)
            for bad in (None,{},{"endpoint":score["endpoint"]},dict(score,baselineVerification={"status":"failed"}),{"endpoint":{"status":"observed","acquired":1,"gameplayQualified":False}}):
                self.assertFalse(validate_result(value,"forward",bad,action_driver="local_model"))

    def test_snapshot_exact_bytes_read_only_and_collision(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);source=root/"source";destination=root/"copy"
            content=b"small fake model";source.write_bytes(content)
            info={"path":str(source),"bytes":len(content),"sha256":hashlib.sha256(content).hexdigest()}
            self.assertEqual(config.capture_model({"model":info},destination),
                             {"bytes":len(content),"sha256":info["sha256"]})
            self.assertEqual(destination.read_bytes(),content)
            self.assertEqual(destination.stat().st_mode & 0o777,0o400)
            with self.assertRaises(FileExistsError):
                config.capture_model({"model":info},destination)
            self.assertEqual(destination.read_bytes(),content)
            link=root/"link";link.symlink_to(source)
            with self.assertRaises(OSError):
                config.capture_model({"model":info},link)
            self.assertEqual(source.read_bytes(),content)

    def test_snapshot_size_and_digest_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);source=root/"source";source.write_bytes(b"abc")
            good={"path":str(source),"bytes":3,"sha256":hashlib.sha256(b"abc").hexdigest()}
            for index,changes in enumerate(({"bytes":2},{"bytes":4},{"sha256":"0"*64})):
                with self.subTest(changes=changes),self.assertRaises(ValueError):
                    config.capture_model({"model":{**good,**changes}},root/str(index))

    def test_manifest_binds_config_only_to_observer(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);payload={"schema_version":1,"test_fixture":True}
            capture_sources(root,payload)
            manifest=json.loads((root/"source-manifest.json").read_text())
            relative="observer-code/local-model-config.json"
            self.assertEqual(json.loads((root/relative).read_text()),payload)
            self.assertEqual(manifest["generated"][relative]["sha256"],
                             hashlib.sha256((root/relative).read_bytes()).hexdigest())
            self.assertFalse((root/"participant-code/local-model-config.json").exists())


    def test_model_space_reserves_snapshot_and_game_before_copy(self):
        from types import SimpleNamespace
        from tools.pilot.bounded_storage import HOST_FREE_RESERVE_BYTES
        model={"model":{"bytes":6*1024**3}}
        capacity=2*1024**3
        needed=HOST_FREE_RESERVE_BYTES+capacity+model["model"]["bytes"]+16*1024**2
        with patch("tools.pilot.local_model_config.shutil.disk_usage",return_value=SimpleNamespace(free=needed-1)):
            with self.assertRaises(ValueError):config.preflight_model_space("/unused",model,capacity)
        with patch("tools.pilot.local_model_config.shutil.disk_usage",return_value=SimpleNamespace(free=needed)):
            config.preflight_model_space("/unused",model,capacity)

    def test_clean_cpu_teardown_is_not_gpu_qualification(self):
        receipt=dict(status="closed",backend_reaped=True,process_group_gone=True,
                     log_reader_stopped=True,gpu_verified=False)
        self.assertTrue(config.backend_cleanup_valid(receipt,require_gpu=False))
        self.assertFalse(config.backend_cleanup_valid(receipt))

    def test_reuse_verifies_private_snapshot_and_exact_hash(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as name:
            root=Path(name);snapshot=root/"weights"
            raw=b"small pinned fixture";snapshot.write_bytes(raw);snapshot.chmod(0o400)
            model={"model":{"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()}}
            self.assertTrue(config.verify_model_snapshot(snapshot,model)["reused"])
            bad=copy.deepcopy(model);bad["model"]["sha256"]="0"*64
            with self.assertRaises(ValueError):config.verify_model_snapshot(snapshot,bad)
            link=root/"link";link.symlink_to(snapshot)
            with self.assertRaises(ValueError):config.verify_model_snapshot(link,model)
            snapshot.chmod(0o600)
            with self.assertRaises(ValueError):config.verify_model_snapshot(snapshot,model)

    def test_reuse_space_does_not_reserve_another_model_copy(self):
        from types import SimpleNamespace
        from tools.pilot.bounded_storage import HOST_FREE_RESERVE_BYTES
        model={"model":{"bytes":6*1024**3}};capacity=2*1024**3
        free=HOST_FREE_RESERVE_BYTES+capacity+16*1024**2
        with patch("tools.pilot.local_model_config.shutil.disk_usage",return_value=SimpleNamespace(free=free)):
            config.preflight_model_space("/unused",model,capacity,reuse=True)
            with self.assertRaises(ValueError):config.preflight_model_space("/unused",model,capacity)

    def test_gpu_window_rejects_competing_compute_and_small_or_busy_gpu(self):
        from types import SimpleNamespace
        def check(row,pids=""):
            with patch("subprocess.run",side_effect=[SimpleNamespace(stdout=row),SimpleNamespace(stdout=pids)]):
                return config.verify_gpu_window(6*1024**3)
        self.assertEqual(check("NVIDIA GeForce RTX 5090, 31000, 0")["other_compute_processes"],0)
        for row,pids in [("NVIDIA GeForce RTX 5090, 31000, 0","123"),
                         ("NVIDIA GeForce RTX 5090, 9000, 0",""),
                         ("NVIDIA GeForce RTX 5090, 31000, 90",""),
                         ("NVIDIA GeForce RTX 5090, 31000, -1","")]:
            with self.assertRaises(ValueError):check(row,pids)
        with patch("subprocess.run",return_value=SimpleNamespace(stdout="Other GPU, 31000, 0")):
            with self.assertRaises(ValueError):config.verify_gpu_window(6*1024**3)

if __name__=="__main__":
    unittest.main()
