"""Explicit local-model demo launcher. Never downloads or touches a live world."""
import argparse
import json
from pathlib import Path
from tools.pilot.local_model_config import pin_local_model
from tools.pilot.oak_qualification import run_oak_qualification


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--launch",action="store_true",help="explicitly permit a disposable GPU/game trial")
    for name in ("workspace","archive","paper","bootstrap","eula","client-tools","storage-tools","bwrap"):
        parser.add_argument("--"+name,type=Path,required=True)
    for name in ("archive-sha256","paper-sha256","client-manifest-sha256"):
        parser.add_argument("--"+name,required=True)
    parser.add_argument("--model",choices=("llama3.2:3b","qwen3.5:9b"),default="llama3.2:3b")
    parser.add_argument("--reuse-model-snapshot",type=Path,help="existing private0400 snapshot, rehashed before read-only mount")
    args=parser.parse_args(argv)
    if not args.launch:
        parser.error("--launch is required; no work started")
    result=run_oak_qualification(launch=True,workspace=args.workspace,
        restore_kwargs={"archive":args.archive,"archive_sha256":args.archive_sha256,
                        "jar":args.paper,"jar_sha256":args.paper_sha256,
                        "bootstrap":args.bootstrap,"eula":args.eula},
        tool_snapshot=args.client_tools,tool_manifest_sha256=args.client_manifest_sha256,
        control_mode="forward",action_driver="local_model",resource_profile="local_model",
        storage_tool_root=args.storage_tools,bwrap_path=args.bwrap,
        local_model_config=pin_local_model(args.model),model_snapshot=args.reuse_model_snapshot)
    worker=result.get("result") or {}
    print(json.dumps({"infrastructure":result["status"],"task_acquired":worker.get("task_acquired"),
        "stage":result.get("stage"),"error":result.get("error"),
        "worker_stage":worker.get("stage"),"worker_error":worker.get("error"),
        "evidence":str(args.workspace/"protected-summary.json"),
        "scope":"One fixed fixture, one local model; not a general agent benchmark"},indent=2))
    return 0 if result["status"]=="qualified" else 1


if __name__=="__main__":
    raise SystemExit(main())
