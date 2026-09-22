"""Private, fixed-capacity ext4 storage mounted through a pinned FUSE helper."""
import hashlib
import os
from pathlib import Path
import subprocess
import time

from tools.pilot import prepare
from tools.pilot.server import _validate_executable


DEFAULT_CAPACITY_BYTES = 2 * 1024 ** 3
MIN_CAPACITY_BYTES = 64 * 1024 ** 2
MAX_CAPACITY_BYTES = 4 * 1024 ** 3
HOST_FREE_RESERVE_BYTES = 40 * 1024 ** 3
FUSE2FS_SHA256 = "bbf0aa57d97be717d4137fef2500f7f43a18186a93aced12a01a6ea64b9a8d7c"
LIBFUSE_SHA256 = "654ae57bdd98c3c85e7a592e4f73cc59dc19a12d545bce77a57b0c4e7af8f394"
DAEMON_AS_BYTES = 512 * 1024 ** 2
DAEMON_CPU_SECONDS = 120


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _is_mounted(path):
    return os.path.ismount(path)


def _mount_entry(path):
    target = str(Path(path))
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        try:
            before, after = line.split(" - ", 1)
            fields, filesystem = before.split(), after.split()
            mountpoint = fields[4].replace("\\040", " ").replace("\\011", "\t")
            if mountpoint != target:
                continue
            return filesystem[0], filesystem[1]
        except (IndexError, ValueError):
            continue
    return False


def _mount_matches(path, image):
    entry = _mount_entry(path)
    return bool(entry and entry[0] in {"fuse.ext4", "fuse2fs", "fuse.fuse2fs"}
                and entry[1] == str(Path(image)))


def _host_free_bytes(path):
    stat = os.statvfs(path)
    return stat.f_bavail * stat.f_frsize


class BoundedStorage:
    """Own one new storage directory, a preserved image, and one FUSE mount."""
    def __init__(self, workspace, tool_root, capacity_bytes=DEFAULT_CAPACITY_BYTES):
        if (type(capacity_bytes) is not int or not MIN_CAPACITY_BYTES <= capacity_bytes <= MAX_CAPACITY_BYTES
                or capacity_bytes % (1024 ** 2)):
            raise ValueError("capacity_bytes must be a whole MiB from 64 MiB through 4 GiB")
        self.workspace = Path(workspace)
        self.tool_root = Path(tool_root)
        self.capacity_bytes = capacity_bytes
        self.image = self.workspace / "storage.ext4"
        self.mountpoint = self.workspace / "mount"
        self._helper = None
        self._started = False
        self._closed = False
        self._fusermount = None

    def _capture_pinned_tools(self):
        sources = (
            (self.tool_root / "usr/bin/fuse2fs", FUSE2FS_SHA256, "fuse2fs"),
            (self.tool_root / "lib/x86_64-linux-gnu/libfuse.so.2.9.9", LIBFUSE_SHA256, "libfuse"),
        )
        captured = []
        for path, expected, label in sources:
            item = prepare._capture_file(path, label, 1024 * 1024)
            if item.sha256 != expected:
                raise ValueError(f"pinned {label} hash mismatch")
            captured.append(item.raw)
        return captured

    def _helpers(self):
        mkfs = _validate_executable(Path("/usr/sbin/mkfs.ext4"), "mkfs.ext4",
                                    expected_name="mke2fs", allowed_root=Path("/usr"))
        prlimit = _validate_executable(Path("/usr/bin/prlimit"), "prlimit",
                                       expected_name="prlimit", allowed_root=Path("/usr"))
        fusermount = _validate_executable(Path("/usr/bin/fusermount3"), "fusermount3",
                                           expected_name="fusermount3", allowed_root=Path("/usr"))
        fallocate = _validate_executable(Path("/usr/bin/fallocate"), "fallocate",
                                         expected_name="fallocate", allowed_root=Path("/usr"))
        return mkfs, prlimit, fusermount, fallocate

    def _write_tools(self, fuse_raw, library_raw):
        binary = self.workspace / "bin"
        library = self.workspace / "lib"
        binary.mkdir(mode=0o700)
        library.mkdir(mode=0o700)
        fuse = binary / "fuse2fs"
        libfuse = library / "libfuse.so.2.9.9"
        for path, raw, mode in ((fuse, fuse_raw, 0o700), (libfuse, library_raw, 0o600)):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            try:
                view = memoryview(raw)
                while view:
                    view = view[os.write(fd, view):]
                os.fchmod(fd, mode)
            finally:
                os.close(fd)
        (binary / "fusermount").symlink_to("/usr/bin/fusermount3")
        (library / "libfuse.so.2").symlink_to("libfuse.so.2.9.9")
        return fuse, library

    @staticmethod
    def _quiet_run(argv):
        return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=30, check=False,
                              env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})

    def start(self):
        if not self.workspace.is_absolute() or self.workspace.is_symlink() or self._closed or self.workspace.exists():
            raise RuntimeError("storage workspace must be new")
        try:
            prepare._reject_symlink_components(self.workspace, "storage workspace", include_leaf=False)
        except prepare.PreparationError as error:
            raise RuntimeError("storage workspace parent may not contain a symlink") from error
        parent = self.workspace.parent
        try:
            parent_info = parent.stat()
        except OSError as error:
            raise RuntimeError("storage parent must exist and be private") from error
        if parent.is_symlink() or parent_info.st_uid != os.getuid() or parent_info.st_mode & 0o077:
            raise RuntimeError("storage parent must be private")
        fuse_raw, library_raw = self._capture_pinned_tools()
        mkfs, prlimit, self._fusermount, fallocate = self._helpers()
        if not parent.is_dir() or _host_free_bytes(parent) < self.capacity_bytes + HOST_FREE_RESERVE_BYTES:
            raise RuntimeError("insufficient host free space for bounded storage")
        self.workspace.mkdir(mode=0o700)
        try:
            fuse, library = self._write_tools(fuse_raw, library_raw)
            self.mountpoint.mkdir(mode=0o700)
            fd = os.open(self.image, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            if self._quiet_run([str(fallocate), "-l", str(self.capacity_bytes), str(self.image)]).returncode != 0:
                raise RuntimeError("storage image allocation failed")
            image_stat = self.image.stat()
            if image_stat.st_size != self.capacity_bytes or image_stat.st_blocks * 512 < self.capacity_bytes:
                raise RuntimeError("storage image is not fixed size")
            uid, gid = os.getuid(), os.getgid()
            if self._quiet_run([str(mkfs), "-q", "-F", "-m", "0", "-O", "^has_journal", "-E",
                                f"root_owner={uid}:{gid},nodiscard,lazy_itable_init=0", str(self.image)]).returncode != 0:
                raise RuntimeError("storage filesystem formatting failed")
            image_stat = self.image.stat()
            if image_stat.st_size != self.capacity_bytes or image_stat.st_blocks * 512 < self.capacity_bytes:
                raise RuntimeError("storage image reservation was not preserved")
            env = {"PATH": str(self.workspace / "bin"), "LD_LIBRARY_PATH": str(library), "LANG": "C.UTF-8"}
            self._helper = subprocess.Popen(
                [str(prlimit), f"--as={DAEMON_AS_BYTES}", f"--cpu={DAEMON_CPU_SECONDS}",
                 f"--fsize={self.capacity_bytes}", "--", str(fuse), "-f", "-s", "-o",
                 f"fsname={self.image},subtype=fuse2fs", str(self.image), str(self.mountpoint)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                close_fds=True, env=env,
            )
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if self._helper.poll() is not None:
                    break
                if _mount_matches(self.mountpoint, self.image):
                    os.chmod(self.mountpoint, 0o700)
                    if self.mountpoint.stat().st_mode & 0o777 != 0o700:
                        raise RuntimeError("storage mount root is not private")
                    self._started = True
                    stats = os.statvfs(self.mountpoint)
                    self._mount_capacity_bytes = stats.f_blocks * stats.f_frsize
                    return self.mountpoint
                time.sleep(0.05)
            raise RuntimeError("storage mount failed")
        except Exception:
            self.close()
            raise

    def close(self):
        if self._closed:
            return dict(self._close_result)
        result = {"status": "failed", "valid": False, "verified_clean": False,
                  "unmount_attempted": False, "unmounted": False, "helper_exited": False,
                  "helper_forced_cleanup": False, "cleanup_uncertain": True,
                  "image_preserved": self.image.exists(), "image_fixed_size": False,
                  "image_sha256": None, "capacity_bytes": self.capacity_bytes,
                  "mount_capacity_bytes": getattr(self, "_mount_capacity_bytes", None),
                  "module_sha256": _sha256(__file__), "fuse2fs_sha256": FUSE2FS_SHA256,
                  "libfuse_sha256": LIBFUSE_SHA256, "daemon_as_bytes": DAEMON_AS_BYTES,
                  "daemon_cpu_seconds": DAEMON_CPU_SECONDS, "daemon_fsize_bytes": self.capacity_bytes}
        mounted = bool(_mount_entry(self.mountpoint))
        if mounted and self._fusermount is not None:
            result["unmount_attempted"] = True
            try:
                result["unmounted"] = self._quiet_run([str(self._fusermount), "-u", str(self.mountpoint)]).returncode == 0
            except Exception:
                result["unmounted"] = False
        elif self._started:
            result["unmounted"] = not _mount_entry(self.mountpoint)
        if self._helper is not None:
            try:
                self._helper.wait(timeout=10)
                result["helper_exited"] = True
            except subprocess.TimeoutExpired:
                result["helper_forced_cleanup"] = True
                try:
                    self._helper.terminate()
                    self._helper.wait(timeout=2)
                    result["helper_exited"] = True
                except (subprocess.TimeoutExpired, ProcessLookupError):
                    try:
                        self._helper.kill()
                        self._helper.wait(timeout=2)
                        result["helper_exited"] = True
                    except (subprocess.TimeoutExpired, ProcessLookupError):
                        pass
            result["helper_returncode"] = self._helper.poll()
        else:
            result["helper_exited"] = True
        if self.image.exists() and self.image.is_file():
            result["image_preserved"] = True
            result["image_fixed_size"] = self.image.stat().st_size == self.capacity_bytes
            result["image_allocated_bytes"] = self.image.stat().st_blocks * 512
        mount_gone = not _mount_entry(self.mountpoint)
        if mount_gone and result["helper_exited"] and result["image_preserved"]:
            result["image_sha256"] = _sha256(self.image)
        result["cleanup_uncertain"] = not (mount_gone and result["helper_exited"])
        result["verified_clean"] = bool(self._started and result["unmount_attempted"] and result["unmounted"]
                                          and mount_gone and result["helper_exited"]
                                          and result.get("helper_returncode") == 0
                                          and not result["helper_forced_cleanup"] and result["image_preserved"]
                                          and result["image_fixed_size"])
        result["valid"] = result["verified_clean"]
        result["status"] = "closed" if result["verified_clean"] else "failed"
        self._closed = True
        self._close_result = result
        return dict(result)
