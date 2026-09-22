import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from tools.pilot.fresh_fixture import generate,pack_world,PROPERTIES


class FreshFixtureTests(unittest.TestCase):
    def test_explicit_launch_gate_before_workspace_creation(self):
        with self.assertRaisesRegex(ValueError,"launch=True"):
            generate(workspace=Path('/not-created'),jar=None,jar_sha256=None,bootstrap=None,eula=None,storage_tool_root=None,bwrap_path=None)

    def test_package_only_worlds_with_stable_tar_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            r=Path(temp)
            for name in ('ai-world','ai-world_nether','ai-world_the_end'):(r/name).mkdir()
            (r/'ai-world/level.dat').write_bytes(b'synthetic world metadata')
            (r/'eula.txt').write_text('private')
            (r/'ops.json').write_text('private')
            first=pack_world(r,r/'one.tar')
            os.utime(r/'ai-world/level.dat',(123,123))
            second=pack_world(r,r/'two.tar')
            self.assertEqual(first['sha256'],second['sha256'])
            with tarfile.open(r/'one.tar') as archive:
                self.assertEqual(set(archive.getnames()),{'ai-world','ai-world/level.dat','ai-world_nether','ai-world_the_end'})
                self.assertTrue(all(m.uid==m.gid==m.mtime==0 for m in archive.getmembers()))

    def test_rejects_player_history_and_links(self):
        for variant in ('history','link'):
            with tempfile.TemporaryDirectory() as temp:
                r=Path(temp)
                for name in ('ai-world','ai-world_nether','ai-world_the_end'):(r/name).mkdir()
                (r/'ai-world/level.dat').write_bytes(b'test')
                if variant=='history':
                    (r/'ai-world/playerdata').mkdir();(r/'ai-world/playerdata/player.dat').write_bytes(b'private')
                else:(r/'ai-world/leak').symlink_to('/etc/passwd')
                with self.assertRaises(ValueError):pack_world(r,r/'out.tar')
                self.assertFalse((r/'out.tar').exists())

    def test_recipe_has_no_rcon_or_external_listener(self):
        self.assertIn('enable-rcon=false\n',PROPERTIES)
        self.assertIn('server-ip=127.0.0.1\n',PROPERTIES)
        self.assertIn('level-seed=20260922\n',PROPERTIES)
        self.assertIn('level-type=minecraft:flat\n',PROPERTIES)
        self.assertNotIn('rcon.password',PROPERTIES)
