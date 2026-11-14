import contextlib
import io
import unittest
from unittest.mock import patch
from tools.pilot.local_model_demo import main


class LocalDemoTests(unittest.TestCase):
    def args(self):
        return ["--workspace","/new-private-trial","--archive","/fixture",
            "--paper","/paper","--bootstrap","/bootstrap","--eula","/existing-eula",
            "--client-tools","/client","--storage-tools","/helpers","--bwrap","/bwrap",
            "--archive-sha256","a"*64,"--paper-sha256","b"*64,
            "--client-manifest-sha256","c"*64]

    def test_launch_is_explicit(self):
        with patch("tools.pilot.local_model_demo.run_oak_qualification") as run:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                main(self.args())
            run.assert_not_called()

    def test_selected_model_and_infrastructure_outcome(self):
        result={"status":"qualified","result":{"task_acquired":False}}
        with patch("tools.pilot.local_model_demo.pin_local_model",return_value={"pin":"fixture"}) as pin, \
             patch("tools.pilot.local_model_demo.run_oak_qualification",return_value=result) as run, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(self.args()+["--launch","--model","qwen3.5:9b"]),0)
            pin.assert_called_once_with("qwen3.5:9b")
            self.assertEqual(run.call_args.kwargs["action_driver"],"local_model")
            self.assertIn('"task_acquired": false',output.getvalue())
            self.assertIn('"infrastructure": "qualified"',output.getvalue())

    def test_failed_infrastructure_nonzero(self):
        with patch("tools.pilot.local_model_demo.pin_local_model",return_value={}), \
             patch("tools.pilot.local_model_demo.run_oak_qualification",return_value={"status":"failed"}), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(self.args()+["--launch"]),1)
