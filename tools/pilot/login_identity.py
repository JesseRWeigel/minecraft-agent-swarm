"""Bounded fixed-identity Minecraft 1.21.4 login admission."""
import hashlib
import socket
import select
import time
import uuid

PROTOCOL = 769
USERNAME = "PilotProbe"


def _offline_uuid(name=USERNAME):
    raw = bytearray(hashlib.md5(("OfflinePlayer:" + name).encode()).digest())
    raw[6] = (raw[6] & 15) | 0x30; raw[8] = (raw[8] & 63) | 0x80
    return str(uuid.UUID(bytes=bytes(raw)))


OFFLINE_UUID = _offline_uuid()


def _varint(data, offset=0):
    value = 0
    for index in range(5):
        if offset + index >= len(data): raise ValueError("truncated varint")
        byte = data[offset + index]; value |= (byte & 127) << (7 * index)
        if not byte & 128:
            if index and byte == 0: raise ValueError("noncanonical varint")
            if value > 0x7fffffff: raise ValueError("varint range")
            return value, offset + index + 1
    raise ValueError("oversize varint")


def _recv(sock, count, stop, deadline):
    out = bytearray()
    while len(out) < count:
        remaining = deadline - time.monotonic()
        if stop.is_set() or remaining <= 0: raise TimeoutError("login admission cancelled")
        ready, _, _ = select.select([sock], [], [], min(.05, remaining))
        if not ready: continue
        chunk = sock.recv(count - len(out))
        if not chunk: raise ValueError("login EOF")
        out.extend(chunk)
    return bytes(out)


def _frame(sock, stop, deadline):
    prefix = bytearray()
    while True:
        prefix += _recv(sock, 1, stop, deadline)
        if prefix[-1] & 128:
            if len(prefix) >= 5: raise ValueError("oversize frame length")
            continue
        length, used = _varint(prefix)
        if used != len(prefix) or not 0 < length <= 1024: raise ValueError("invalid frame length")
        return bytes(prefix) + _recv(sock, length, stop, deadline)


def _string(data, offset):
    size, offset = _varint(data, offset)
    if size > 255 or offset + size > len(data): raise ValueError("invalid string")
    try: return data[offset:offset+size].decode("utf8", "strict"), offset + size
    except UnicodeError as error: raise ValueError("invalid UTF-8") from error


def admit_login(sock, stop, timeout=5):
    if type(timeout) not in (int, float) or not 0 < timeout <= 5 or timeout != timeout:
        raise ValueError("timeout must be finite and within five seconds")
    deadline = time.monotonic() + timeout
    handshake = _frame(sock, stop, deadline); body = handshake[_varint(handshake)[1]:]
    packet, pos = _varint(body)
    protocol, pos = _varint(body, pos); host, pos = _string(body, pos)
    if pos + 3 != len(body): raise ValueError("handshake trailing data")
    port = int.from_bytes(body[pos:pos+2], "big"); state, pos = _varint(body, pos+2)
    if (packet, protocol, host, port, state) != (0, PROTOCOL, "127.0.0.1", 25585, 2): raise ValueError("login handshake rejected")
    login = _frame(sock, stop, deadline); body = login[_varint(login)[1]:]
    packet, pos = _varint(body); name, pos = _string(body, pos)
    if pos + 16 != len(body): raise ValueError("login trailing data")
    player = str(uuid.UUID(bytes=body[pos:]))
    if packet != 0 or name != USERNAME or player != OFFLINE_UUID: raise ValueError("login identity rejected")
    return handshake + login, {"policy":"fixed_offline_login_v1","username":USERNAME,"uuid":OFFLINE_UUID,"protocol":PROTOCOL,"status":"admitted"}
