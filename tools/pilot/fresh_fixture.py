"""Generate a local seed-based fixture without reading an existing world."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tarfile

from tools.pilot import prepare, restore
from tools.pilot.bootstrap import inspect_bootstrap
from tools.pilot.bounded_storage import BoundedStorage
from tools.pilot.qualification import _private_new, _write, _sha, _capture_json
from tools.pilot.scoped_trial import run_scoped
from tools.pilot.server import _build_sandbox_argv, _validate_executable

PROPERTIES = restore.PROPERTIES.replace("max-players=5", "max-players=1") + """level-seed=20260922
level-type=minecraft:flat
generate-structures=false
difficulty=peaceful
gamemode=survival
spawn-protection=0
"""
RECIPE = {"schema_version":1, "name":"fresh-flat-v1", "properties":PROPERTIES,
          "archive_roots":sorted(restore.WORLD_ROOTS), "players_admitted":False}
RECIPE_SHA256 = hashlib.sha256(json.dumps(RECIPE,sort_keys=True,separators=(",",":")).encode()).hexdigest()
MAX_WORLD_BYTES = 512*1024**2


def pack_world(runtime, archive):
    """Whitelist generated dimensions; exclude configuration, binaries and logs."""
    entries=[]; size=0
    for root in sorted(restore.WORLD_ROOTS):
        tree=runtime/root
        if not tree.is_dir() or tree.is_symlink(): raise ValueError("missing fresh dimension")
        for path in [tree,*sorted(tree.rglob("*"))]:
            if path.is_symlink() or not (path.is_file() or path.is_dir()): raise ValueError("unsafe generated file")
            if path.is_file():
                if any(part in {"playerdata","advancements","stats"} for part in path.relative_to(runtime).parts):
                    raise ValueError("player history in fresh fixture")
                size+=path.stat().st_size
            entries.append(path)
            if len(entries)>100000 or size>MAX_WORLD_BYTES:raise ValueError("fixture size limit")
    if not (runtime/"ai-world/level.dat").is_file(): raise ValueError("missing generated level")
    with archive.open("xb") as stream:
        os.chmod(archive,0o600)
        with tarfile.open(fileobj=stream,mode="w",format=tarfile.USTAR_FORMAT) as output:
            for path in entries:
                info=output.gettarinfo(str(path),arcname=path.relative_to(runtime).as_posix())
                info.uid=info.gid=0;info.uname=info.gname="";info.mtime=0
                info.mode=0o700 if info.isdir() else 0o600
                if info.isfile():
                    with path.open("rb") as source:output.addfile(info,source)
                else:output.addfile(info)
    restore._inspect(archive,MAX_WORLD_BYTES)
    return {"sha256":_sha(archive),"bytes":archive.stat().st_size,"world_bytes":size,"entries":len(entries)}


def generate(*,launch=False,workspace,jar,jar_sha256,bootstrap,eula,storage_tool_root,bwrap_path):
    if launch is not True: raise ValueError("explicit launch=True required")
    restore._pin(jar_sha256)
    accepted=prepare._capture_file(Path(eula),"existing accepted EULA",65536);restore._eula(accepted.raw)
    bwrap=_validate_executable(Path(bwrap_path),"bwrap",expected_name="bwrap")
    _validate_executable(Path('/usr/bin/java'),"Java",expected_name="java",allowed_root=Path('/usr/lib/jvm'))
    python=Path('/usr/bin/python3').resolve(strict=True)
    _validate_executable(python,"Python",expected_name=python.name,allowed_root=Path('/usr'))
    workspace=_private_new(workspace)
    storage=BoundedStorage(workspace/'storage',Path(storage_tool_root))
    result={"schema_version":1,"status":"failed","recipe":RECIPE,"recipe_sha256":RECIPE_SHA256,
            "server_jar_sha256":jar_sha256,"private_world_input":False,"eula_source":"existing_operator_accepted_file"}
    try:
        code=workspace/'code';code.mkdir(mode=0o700)
        worker=prepare._capture_file(Path(__file__).with_name('fresh_fixture_worker.py'),"generator worker",1024*1024)
        _write(code/'worker.py',worker.raw);_write(code/'host-netns',os.readlink('/proc/self/ns/net').encode())
        result['worker_sha256']=worker.sha256;result['controller_sha256']=_sha(Path(__file__))
        result['stage']='prepare_runtime'
        runtime=storage.start()/'runtime';runtime.mkdir(mode=0o700)
        reserve=64*1024**2
        restore._copy_pinned(Path(jar),runtime/'server.jar',jar_sha256,restore.MAX_JAR,runtime,reserve)
        dependency=inspect_bootstrap(runtime/'server.jar')
        if dependency is None:raise ValueError("supported Paper bootstrap required")
        (runtime/'cache').mkdir(mode=0o700)
        restore._copy_pinned(Path(bootstrap),runtime/dependency['path'],dependency['sha256'],restore.MAX_JAR,runtime,reserve)
        result['bootstrap']=dependency
        _write(runtime/'eula.txt',accepted.raw);_write(runtime/'server.properties',PROPERTIES.encode())
        args=_build_sandbox_argv(runtime,bwrap_path=bwrap,command=[str(python),'/fixture-code/worker.py'])
        i=args.index('--proc');args[i:i]=['--ro-bind',str(code),'/fixture-code']
        i=args.index('--tmpfs');args[i:i]=['--size',str(64*1024**2)]
        result['stage']='generate'
        process,resources=run_scoped(args,workspace=workspace,cwd=runtime,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
        result['resource_scope']=resources;result['process']=process.to_dict()
        lifecycle,digest=_capture_json(runtime/'generation-result.json',65536)
        result['lifecycle']=lifecycle;result['lifecycle_sha256']=digest
        if (process.returncode!=0 or process.timed_out or process.cleanup_uncertain or process.stdout_truncated or process.stderr_truncated
                or not resources['valid'] or not lifecycle or lifecycle.get('error') or lifecycle.get('ready') is not True
                or lifecycle.get('stop_sent') is not True or lifecycle.get('forced_cleanup') is not False
                or type(lifecycle.get('returncode')) is not int or lifecycle['returncode']!=0):
            raise ValueError("unclean generator lifecycle")
        result['stage']='package'
        archive=runtime/'fixture.tar';metadata=pack_world(runtime,archive)
        restore._copy_pinned(archive,workspace/'fixture.tar',metadata['sha256'],restore.MAX_ARCHIVE,workspace,restore.RESERVE)
        result['archive']=metadata;result['status']='generated'
    except Exception:
        result['error']='fixture_generation_failed'
    finally:
        result['storage']=storage.close()
        if not result['storage']['valid']:result['status']='failed'
        _write(workspace/'fixture-manifest.json',(json.dumps(result,indent=2,sort_keys=True)+'\n').encode())
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--launch',action='store_true',required=True)
    for name in ('workspace','jar','bootstrap','eula','storage-tool-root','bwrap-path'):parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--jar-sha256',required=True)
    result=generate(**vars(parser.parse_args()))
    print(json.dumps({k:result.get(k) for k in ('status','stage','archive','error')}))
    return 0 if result['status']=='generated' else 1


if __name__=='__main__':raise SystemExit(main())
