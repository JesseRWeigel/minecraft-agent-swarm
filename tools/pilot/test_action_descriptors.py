import os
import select
import subprocess
import sys
import time
import unittest

from tools.pilot.action_descriptors import ActionDescriptors, spawn_action_sandbox, validate_action_descriptors


class ActionDescriptorTests(unittest.TestCase):
    def test_adapter_forwards_only_action_pipes(self):
        descriptors = ActionDescriptors.create()
        leak_read, leak_write = os.pipe()
        process = None
        os.set_inheritable(leak_read, True)
        try:
            program = (
                "import os,sys; os.write(4,b'ready'); request=os.read(3,16); "
                "os.write(4,request+b':' + str(os.path.exists('/proc/self/fd/'+sys.argv[1])).encode())"
            )
            process = spawn_action_sandbox([
                sys.executable, "-c", program, str(leak_read),
            ], descriptors)
            assert descriptors.host_write is not None and descriptors.host_read is not None
            os.write(descriptors.host_write, b"action")
            received=b"";deadline=time.monotonic()+2
            while len(received)<len(b"readyaction:False"):
                remaining=deadline-time.monotonic()
                self.assertGreater(remaining,0)
                self.assertTrue(select.select([descriptors.host_read],[],[],remaining)[0])
                data=os.read(descriptors.host_read,64)
                self.assertTrue(data)
                received+=data
            self.assertEqual(received,b"readyaction:False")
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            if process is not None and process.poll() is None:
                process.kill();process.wait(timeout=2)
            descriptors.close_child()
            descriptors.close_host()
            os.close(leak_read)
            os.close(leak_write)

    def test_validator_requires_distinct_fifo_read_and_write_endpoints(self):
        descriptors = ActionDescriptors.create()
        try:
            self.assertEqual(validate_action_descriptors(descriptors.child_read, descriptors.child_write), (descriptors.child_read, descriptors.child_write))
            with self.assertRaises(ValueError):
                validate_action_descriptors(descriptors.child_read, descriptors.child_read)
            with self.assertRaises(ValueError):
                validate_action_descriptors(descriptors.child_write, descriptors.child_read)
            same_read, same_write = os.pipe()
            try:
                with self.assertRaises(ValueError):
                    # The directions are valid but a single FIFO is ambiguous.
                    from tools.pilot.action_descriptors import _validated_child_fds
                    _validated_child_fds(ActionDescriptors(None, None, same_read, same_write))
            finally:
                os.close(same_read)
                os.close(same_write)
            with self.assertRaises(ValueError):
                validate_action_descriptors(0, descriptors.child_write)
        finally:
            descriptors.close_child()
            descriptors.close_host()

    def test_rejects_unsafe_spawn_overrides_and_closes_idempotently(self):
        descriptors = ActionDescriptors.create()
        try:
            with self.assertRaises(ValueError):
                spawn_action_sandbox(["/bin/true"], descriptors, close_fds=False)
        finally:
            descriptors.close_child()
            descriptors.close_child()
            descriptors.close_host()
            descriptors.close_host()


if __name__ == "__main__":
    unittest.main()
