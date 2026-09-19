import os
import re
import stat
import struct
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

MAX_JAR_BYTES = 512 * 1024 * 1024
MAX_CENTRAL_DIRECTORY_BYTES = 1024 * 1024
MAX_ENTRIES = 10_000
MAX_METADATA_BYTES = 4096
_METADATA = "META-INF/download-context"
_NAME = re.compile(r"mojang_[0-9]+\.[0-9]+(?:\.[0-9]+)?\.jar\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")

class BootstrapError(ValueError):
    pass

def _eocd(path, size):
    with path.open("rb") as f:
        f.seek(max(0, size - 65_557))
        tail = f.read(65_557)
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
        info = path.lstat()
    except OSError as exc:
        raise BootstrapError("cannot inspect JAR") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise BootstrapError("JAR must be a regular non-symlink file")
    if info.st_size > MAX_JAR_BYTES:
        raise BootstrapError("JAR exceeds inspection limit")
    _eocd(path, info.st_size)
    try:
        with zipfile.ZipFile(path) as archive:
            matches = [i for i in archive.infolist() if i.filename == _METADATA]
            if not matches:
                return None
            if len(matches) != 1:
                raise BootstrapError("duplicate download-context entry")
            entry = matches[0]
            if entry.file_size > MAX_METADATA_BYTES:
                raise BootstrapError("download-context exceeds limit")
            with archive.open(entry) as source:
                raw = source.read(MAX_METADATA_BYTES + 1)
            if len(raw) > MAX_METADATA_BYTES:
                raise BootstrapError("download-context exceeds limit")
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise BootstrapError("invalid ZIP archive") from exc
    try:
        line = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise BootstrapError("download-context must be ASCII") from exc
    if line.endswith("\n"):
        line = line[:-1]
        if line.endswith("\r"):
            line = line[:-1]
    fields = line.split("\t")
    if len(fields) != 3:
        raise BootstrapError("download-context must contain exactly three fields")
    digest, url, basename = fields
    parsed = urlsplit(url)
    if not _HASH.fullmatch(digest) or not _NAME.fullmatch(basename):
        raise BootstrapError("invalid bootstrap identity")
    if parsed.scheme != "https" or parsed.hostname != "piston-data.mojang.com" or parsed.username or parsed.password or parsed.port not in (None, 443) or not parsed.path or parsed.query or parsed.fragment:
        raise BootstrapError("untrusted bootstrap URL")
    return {"path": f"cache/{basename}", "sha256": digest}