import io
import os
import re
import struct
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from tools.pilot.prepare import PreparationError, _open_regular

MAX_JAR_BYTES = 512 * 1024 * 1024
MAX_CENTRAL_DIRECTORY_BYTES = 1024 * 1024
MAX_ENTRIES = 10_000
MAX_METADATA_BYTES = 4096
MAX_METADATA_COMPRESSED_BYTES = 64 * 1024
_METADATA = "META-INF/download-context"
_NAME = re.compile(r"mojang_[0-9]+\.[0-9]+(?:\.[0-9]+)?\.jar\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")

class BootstrapError(ValueError):
    pass

def _archive_signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class _BoundedReader:
    def __init__(self, source, size):
        self._source = source
        self._size = size
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self._source.tell()
    def seek(self, offset, whence=os.SEEK_SET):
        if whence == os.SEEK_SET: target = offset
        elif whence == os.SEEK_CUR: target = self.tell() + offset
        elif whence == os.SEEK_END: target = self._size + offset
        else: raise ValueError("invalid whence")
        if target < 0 or target > self._size:
            raise BootstrapError("ZIP seek exceeds captured file size")
        return self._source.seek(target)
    def read(self, size=-1):
        remaining = self._size - self.tell()
        requested = remaining if size is None or size < 0 else size
        if requested > MAX_CENTRAL_DIRECTORY_BYTES:
            raise BootstrapError("ZIP read exceeds inspection limit")
        if requested < 0 or requested > remaining:
            requested = remaining
        data = self._source.read(requested)
        if len(data) > requested:
            raise BootstrapError("ZIP read exceeds captured file size")
        return data
    def close(self): return self._source.close()
    @property
    def closed(self): return self._source.closed


def _eocd(source, size):
    source.seek(max(0, size - 65_557))
    tail = source.read(min(size, 65_557))
    pos = tail.rfind(b"PK\x05\x06")
    if pos < 0 or pos + 22 > len(tail):
        raise BootstrapError("invalid ZIP end record")
    fields = struct.unpack_from("<4s4H2LH", tail, pos)
    disk, cd_disk, disk_entries, entries, cd_size, cd_offset, comment = fields[1:]
    if disk or cd_disk or disk_entries != entries:
        raise BootstrapError("multi-disk ZIP is unsupported")
    if entries == 0xFFFF or cd_size == 0xFFFFFFFF or cd_offset == 0xFFFFFFFF:
        raise BootstrapError("ZIP64 is unsupported")
    if entries > MAX_ENTRIES or cd_size > MAX_CENTRAL_DIRECTORY_BYTES:
        raise BootstrapError("ZIP index exceeds inspection limits")
    if pos + 22 + comment != len(tail) or cd_offset + cd_size > size:
        raise BootstrapError("malformed ZIP index")


def inspect_bootstrap(jar_path: Path):
    path = Path(jar_path)
    try:
        fd, info = _open_regular(path, "bootstrap JAR", MAX_JAR_BYTES)
    except PreparationError as exc:
        raise BootstrapError(str(exc)) from exc
    initial_signature = _archive_signature(info)
    source = _BoundedReader(os.fdopen(os.dup(fd), "rb", buffering=0), info.st_size)
    try:
        _eocd(source, info.st_size)
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            matches = [i for i in archive.infolist() if i.filename == _METADATA]
            if not matches:
                return None
            if len(matches) != 1:
                raise BootstrapError("duplicate download-context entry")
            entry = matches[0]
            if (
                entry.file_size > MAX_METADATA_BYTES
                or entry.compress_size > MAX_METADATA_COMPRESSED_BYTES
            ):
                raise BootstrapError("download-context exceeds limit")
            with archive.open(entry) as metadata:
                raw = metadata.read(MAX_METADATA_BYTES + 1)
            if len(raw) > MAX_METADATA_BYTES:
                raise BootstrapError("download-context exceeds limit")
    except BootstrapError:
        raise
    except (zipfile.BadZipFile, RuntimeError, OSError, EOFError) as exc:
        raise BootstrapError("invalid ZIP archive") from exc
    finally:
        source.close()
        try:
            final_signature = _archive_signature(os.fstat(fd))
        finally:
            os.close(fd)
        if final_signature != initial_signature:
            raise BootstrapError("bootstrap JAR changed during inspection")
    try:
        line = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise BootstrapError("download-context must be ASCII") from exc
    if line.endswith("\n"):
        line = line[:-1]
        if line.endswith("\r"): line = line[:-1]
    fields = line.split("\t")
    if len(fields) != 3:
        raise BootstrapError("download-context must contain exactly three fields")
    digest, url, basename = fields
    parsed = urlsplit(url)
    if not _HASH.fullmatch(digest) or not _NAME.fullmatch(basename):
        raise BootstrapError("invalid bootstrap identity")
    try:
        port = parsed.port
    except ValueError as exc:
        raise BootstrapError("untrusted bootstrap URL") from exc
    if parsed.scheme != "https" or parsed.hostname != "piston-data.mojang.com" or parsed.username or parsed.password or port not in (None, 443) or not parsed.path or parsed.query or parsed.fragment:
        raise BootstrapError("untrusted bootstrap URL")
    return {"path": f"cache/{basename}", "sha256": digest}