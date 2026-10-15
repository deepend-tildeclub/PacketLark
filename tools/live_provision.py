"""Coordinate point creation with SBBSecho without stopping Synchronet."""

from __future__ import annotations

from contextlib import contextmanager
import configparser
import csv
import io
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def echocfg_running() -> bool:
    """EchoCfg keeps an editable snapshot and does not honor sbbsecho.bsy."""
    if sys.platform.startswith("linux"):
        for entry in Path("/proc").iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                name = (entry / "comm").read_text().strip().lower()
            except (FileNotFoundError, ProcessLookupError):
                continue
            if name in ("echocfg", "echocfg.exe"):
                return True
        return False
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["tasklist", "/FO", "CSV", "/NH"], check=True,
                capture_output=True, text=True, timeout=10,
            )
        except subprocess.SubprocessError:
            raise ValueError("Cannot check for EchoCfg; no live configuration change allowed") from None
        return any(row and row[0].lower() == "echocfg.exe"
                   for row in csv.reader(io.StringIO(result.stdout)))
    raise ValueError("Live provisioning supports Linux and Windows hosts")


def data_directory(config: Path, override: Path | None) -> Path:
    if override is not None:
        directory = override.resolve(strict=True)
    else:
        main = config.parent / "main.ini"
        text = main.read_text(encoding="utf-8-sig") if main.exists() else ""
        # An include can change the effective path; require an explicit path in that case.
        if re.search(r"^\s*!include\b", text, re.I | re.M):
            raise ValueError("main.ini uses includes; supply --data-dir for event signalling")
        ini = configparser.ConfigParser(interpolation=None, strict=False)
        try:
            ini.read_string("[__root__]\n" + text)
        except configparser.Error:
            raise ValueError("Cannot read main.ini paths; supply --data-dir") from None
        section = next((name for name in ini.sections() if name.lower() == "dir"), "dir")
        value = ini.get(section, "data", fallback="../data").strip().strip('"')
        directory = (config.parent / value).resolve(strict=True)
    if not directory.is_dir():
        raise ValueError("Synchronet data path is not a directory")
    return directory


def resume_events(directory: Path, events: list[str]) -> None:
    # Retry events that may have encountered the short-lived SBBSecho mutex.
    # Never delete or consume existing .now files.
    errors = []
    for event in events:
        target = directory / (event.lower() + ".now")
        try:
            if target.is_symlink():
                raise ValueError(f"Refusing symbolic-link event semaphore: {target.name}")
            target.touch(exist_ok=True)
        except (OSError, ValueError) as error:
            errors.append(f"{target.name}: {error}")
    if errors:
        raise OSError("; ".join(errors))


def check_editor() -> None:
    if echocfg_running():
        raise ValueError("EchoCfg opened while provisioning; configuration was not replaced")


@contextmanager
def live_window(config: Path, args, summary: dict[str, object]):
    wait = getattr(args, "wait_seconds", 60.0)
    if not 0 <= wait <= 3600:
        raise ValueError("--wait-seconds must be between 0 and 3600")
    events = getattr(args, "resume_event", None) or ["fidoin", "fidoout"]
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", event) for event in events):
        raise ValueError("Resume events must be Synchronet internal event codes")
    directory = data_directory(config, getattr(args, "data_dir", None))
    # Check event signalling before making any configuration changes.
    fd, probe = tempfile.mkstemp(prefix=".packetlark-probe-", dir=directory)
    os.close(fd)
    Path(probe).unlink()
    for event in events:
        target = directory / (event.lower() + ".now")
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError(f"Invalid event semaphore: {target.name}")
    deadline = time.monotonic() + wait
    mutex = config.parent / "sbbsecho.bsy"
    token = f"PacketLark provisioner PID {os.getpid()}\n".encode("ascii")
    identity = None
    waiting_notice = False
    try:
        while True:
            editor = echocfg_running()
            if not editor:
                try:
                    fd = os.open(mutex, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    pass
                else:
                    identity = os.fstat(fd)
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(token)
                        stream.flush()
                        os.fsync(stream.fileno())
                    break
            if time.monotonic() >= deadline:
                what = "EchoCfg is open" if editor else "SBBSecho is busy or its mutex remains"
                raise ValueError(f"{what}; wait timed out, no configuration changed")
            if not waiting_notice:
                print("Waiting for SBBSecho/EchoCfg to finish...", file=sys.stderr)
                waiting_notice = True
            time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))
        check_editor()
        summary["coordination"] = "sbbsecho.bsy"
        yield
    finally:
        if identity is not None:
            # A crash/other administrator must not cause us to unlink somebody else's lock.
            try:
                current = mutex.stat(follow_symlinks=False)
                if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino) or mutex.read_bytes() != token:
                    raise ValueError("SBBSecho mutex was replaced; refusing to remove it")
                mutex.unlink()
            finally:
                try:
                    resume_events(directory, events)
                except (OSError, ValueError) as error:
                    # The point/account may already be committed. Report accurately, never
                    # roll back a complete point or discard unrelated configuration changes.
                    summary.setdefault("warnings", []).append(
                        f"Could not signal mail processing: {error}"
                    )
            summary["resumeEvents"] = events
