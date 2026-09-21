"""Real Python/Node pipe handshake with a fake bot, no Minecraft or namespaces.

This qualifies the language/process interface only. Authoritative observation,
containment, and game scoring are intentionally not simulated as passing here.
"""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

from tools.pilot.participant_transport import ParticipantTransport


NODE_FIXTURE = r'''
import { EventEmitter } from 'node:events';
import { runParticipantProcess } from './tools/pilot/protected-participant-cli.mjs';
const movement = process.argv[1];
let loaded = false, forward = false, stopped = false, quit = false;
const bot = new EventEmitter();
bot.entity = {};
bot._client = { write(name) { if(name !== 'player_loaded') throw Error('packet'); loaded = true; }, socket: { destroyed: false, destroy() { this.destroyed = true; } } };
bot.waitForTicks = async () => {};
bot.setControlState = (name, value) => {
  if(name !== 'forward') throw Error('control');
  if(value) { if(!loaded) throw Error('not ready'); forward = true; }
  else stopped = true;
};
bot.quit = async () => { quit = true; };
const code = await runParticipantProcess({
  argv: ['--trial-id','trial-01','--action-id','walk-01','--movement',movement],
  loadMineflayer: async () => ({createBot(options) {
    if(options.respawn !== false || options.version !== '1.21.4' || options.host !== '127.0.0.1' || options.port !== 25585 || options.username !== 'PilotProbe') throw Error('bot configuration');
    return bot;
  }}),
});
if(code !== 0 || !loaded || !stopped || !quit || forward !== (movement === 'forward')) process.exitCode = 13;
'''


@unittest.skipUnless(shutil.which('node'), 'Node required for cross-language process qualification')
class ParticipantProcessIntegrationTests(unittest.TestCase):
    def test_python_supervisor_and_node_participant_complete_both_modes(self):
        root = Path(__file__).resolve().parents[2]
        for mode in ('forward', 'stationary'):
            with self.subTest(mode=mode):
                process = subprocess.Popen(
                    [shutil.which('node'), '--input-type=module', '-e', NODE_FIXTURE, mode],
                    cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, close_fds=True,
                )
                transport = None
                try:
                    transport = ParticipantTransport(process, trial_id='trial-01', action_id='walk-01', overall_timeout=8)
                    self.assertEqual(transport.wait_ready(), 'ready')
                    # A future worker captures its protected before-state here.
                    transport.send_begin()
                    self.assertEqual(transport.wait_action_finished(), 'action_finished')
                    # A future worker captures its protected terminal-state here.
                    transport.send_finalize()
                    transport.wait_exit()
                    self.assertEqual(process.returncode, 0)
                    self.assertEqual(transport.stderr, b'')
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=2)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if stream and not stream.closed:
                            stream.close()
                    if transport is not None:
                        transport.close()


if __name__ == '__main__':
    unittest.main()
