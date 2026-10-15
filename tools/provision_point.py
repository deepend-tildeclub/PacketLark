#!/usr/bin/env python3
"""Provision one PacketLark point link for SBBSecho/BinkIT. Python 3.10+, stdlib only."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile

ADDRESS = re.compile(r"^(\d{1,5}):(\d{1,5})/(\d{1,5})(?:\.(\d{1,5}))?(?:@([a-z0-9.-]{1,40}))?$", re.I)
TAG = re.compile(r"^[A-Z0-9_!.-]{1,60}$")


def parse_address(value: str) -> tuple[int, int, int, int, str]:
    m = ADDRESS.fullmatch(value)
    if not m:
        raise ValueError("Invalid FTN address; use zone:net/node.point@domain")
    z, n, f, p = (int(x or 0) for x in m.groups()[:4])
    if not z or any(x > 65535 for x in (z, n, f, p)):
        raise ValueError("FTN address values must fit unsigned 16-bit fields")
    return z, n, f, p, (m.group(5) or "fidonet").lower()


def format_address(value: tuple[int, int, int, int, str]) -> str:
    z, n, f, p, domain = value
    return f"{z}:{n}/{f}" + (f".{p}" if p else "") + f"@{domain}"


def section_addresses(text: str) -> set[tuple[int, int, int, int, str]]:
    found = set()
    for m in re.finditer(r"^\s*\[node:([^\]]+)\]", text, re.I | re.M):
        try:
            found.add(parse_address(m.group(1).strip()))
        except ValueError:
            pass  # Preserve wildcard and unrelated sections exactly.
    return found


def checked_line(value: str, maximum: int, label: str) -> str:
    if not value or len(value) > maximum or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"Invalid {label}")
    return value


def write_exclusive(filename: Path, data: bytes) -> None:
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        filename.unlink(missing_ok=True)
        raise


def replace_config(filename: Path, data: bytes) -> None:
    stat = filename.stat()
    fd, tmp = tempfile.mkstemp(prefix=".packetlark-", dir=filename.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            if hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), stat.st_mode & 0o777)
            if hasattr(os, "fchown"):
                os.fchown(stream.fileno(), stat.st_uid, stat.st_gid)
            os.fsync(stream.fileno())
        os.replace(tmp, filename)
    finally:
        Path(tmp).unlink(missing_ok=True)


def provision(args: argparse.Namespace) -> dict[str, object]:
    config = args.config.resolve(strict=True)
    if args.config.is_symlink():
        raise ValueError("Use the real configuration path, not a symlink")
    original = config.read_bytes()
    # Read only enough INI syntax to identify collisions; never reserialize existing settings.
    text = original.decode("utf-8-sig")
    boss = parse_address(args.boss)
    if boss[3]:
        raise ValueError("--boss must be a node address, without a point number")
    checked_line(args.name, 35, "name")
    checked_line(args.provider, 80, "provider")
    if not re.fullmatch(r"[a-zA-Z0-9.:_-]{1,253}", args.host):
        raise ValueError("Invalid hostname or IP address")
    if not 1 <= args.port <= 65535:
        raise ValueError("Port must be between 1 and 65535")
    existing = section_addresses(text)
    used = {a[3] for a in existing if a[:3] == boss[:3] and a[4] == boss[4]}
    if args.point == "auto":
        number = next((p for p in range(args.start, 65536) if p not in used), None)
        if number is None:
            raise ValueError("No unused point numbers in the requested range")
    else:
        number = int(args.point)
    if not 1 <= number <= 65535 or number in used:
        raise ValueError("Point number is invalid or already configured; nothing overwritten")
    point = (*boss[:3], number, boss[4])
    areas = []
    for value in args.area:
        tag, _, label = value.partition("=")
        tag = tag.upper()
        if not TAG.fullmatch(tag) or tag in [a["tag"] for a in areas]:
            raise ValueError("Discussion tags must be unique, uppercase FTN tags")
        areas.append({"tag": tag, "name": checked_line(label or tag, 100, "discussion label")})
    if len(areas) > 500:
        raise ValueError("At most 500 discussion groups may be listed")
    session = secrets.token_hex(12).upper()
    packet = secrets.token_hex(4).upper()
    area_password = secrets.token_hex(4).upper()
    point_address = format_address(point)
    profile = {
        "format": "packetlark-account", "version": 1,
        "provider": args.provider, "name": args.name, "address": point_address,
        "uplink": {"address": format_address(boss), "host": args.host, "port": args.port,
                   "tls": args.tls, "sessionPassword": session,
                   "packetPassword": packet, "areaFixPassword": area_password},
        "areas": areas, "pollMinutes": 10, "charset": args.charset,
    }
    # Hold and no polling: a desktop point collects mail; the BBS never dials its hostname.
    newline = "\r\n" if b"\r\n" in original else "\n"
    snippet = newline.join([
        "", "; PacketLark point link (provision_point.py)", f"[node:{point_address}]",
        f"Name = {args.name}", "Comment = PacketLark desktop point", "PacketType = 2+",
        "Archive = None", f"SessionPwd = {session}", f"PacketPwd = {packet}",
        f"AreaFixPwd = {area_password}", "Status = Hold", "Direct = false",
        "Passive = false", "BinkpPoll = false", "BinkpAllowPlainAuth = false",
        "BinkpPlainAuthOnly = false", "BinkpAllowPlainText = true", "",
    ])
    # Preview contains no credentials and does not create an account file.
    summary = {"point": point_address, "provider": args.provider, "host": args.host,
               "port": args.port, "tls": args.tls, "output": str(args.output.resolve()),
               "groups": [a["tag"] for a in areas], "apply": args.apply}
    if not args.apply:
        return summary
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output.exists() or output.is_symlink():
        raise ValueError("Output file already exists; refusing to overwrite credentials")
    # Coordinate with the original provisioning script during the rename as well.
    lock = config.with_name(config.name + ".retropost.lock")
    lock_fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    backup = config.with_name(config.name + ".packetlark-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".bak")
    try:
        # Protect against our own concurrent runs and detect editors/tossers that changed it since preview.
        if config.read_bytes() != original:
            raise ValueError("Configuration changed while provisioning. Retry with the current file")
        write_exclusive(backup, original)
        write_exclusive(output, (json.dumps(profile, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
        try:
            replace_config(config, original + snippet.encode("utf-8"))
        except BaseException:
            output.unlink(missing_ok=True)
            raise
        summary["backup"] = str(backup)
    finally:
        os.close(lock_fd)
        lock.unlink(missing_ok=True)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="Existing Synchronet ctrl/sbbsecho.ini")
    parser.add_argument("--boss", required=True, help="Your existing FidoNet node address")
    parser.add_argument("--host", required=True, help="Public BinkP host name")
    parser.add_argument("--port", type=int, default=24554)
    parser.add_argument("--tls", action="store_true", help="Use an existing implicit TLS BinkP listener with a trusted certificate")
    parser.add_argument("--point", default="auto", help="Unused point number, or auto")
    parser.add_argument("--start", type=int, default=100, help="First auto-allocation point number (default 100)")
    parser.add_argument("--name", required=True)
    parser.add_argument("--provider", default="RetroDigital BBS")
    parser.add_argument("--area", action="append", default=[], help="TAG=Display name (repeatable); not a server subscription")
    parser.add_argument("--charset", choices=["UTF-8", "CP437", "CP850", "CP866", "WINDOWS-1252"], default="UTF-8")
    parser.add_argument("--output", type=Path, required=True, help="New private .packetlark signup file")
    parser.add_argument("--apply", action="store_true", help="Back up and append the point link, then create the signup file")
    args = parser.parse_args()
    if not 1 <= args.start <= 65535:
        parser.error("--start must be between 1 and 65535")
    try:
        print(json.dumps(provision(args), indent=2))
        if not args.apply:
            print("Preview only. Add --apply to create the point link and account file.")
        else:
            print("Created. Deliver the account file privately; it contains reusable credentials.")
            print("Use the client to request discussion subscriptions after its first successful exchange.")
        return 0
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
