import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from provision_point import provision


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.config = root / "sbbsecho.ini"
        self.original = b"; Existing config and comments\r\nBinkleyStyleOutbound = true\r\n[node:1:123/456.100]\r\nSessionPwd = EXISTING\r\n"
        self.config.write_bytes(self.original)
        self.output = root / "private" / "test.packetlark"

    def args(self, **overrides):
        data = dict(config=self.config, boss="1:123/456", host="bbs.example.invalid", port=24554,
                    tls=False, point="auto", start=100, name="Test Person", provider="RetroDigital BBS",
                    area=["TEST=Test discussion"], charset="UTF-8", output=self.output, apply=False)
        data.update(overrides)
        return argparse.Namespace(**data)

    def test_preview_has_no_side_effects_or_secrets(self):
        summary = provision(self.args())
        self.assertEqual(summary["point"], "1:123/456.101@fidonet")
        self.assertFalse(self.output.exists())
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertNotIn("Password", json.dumps(summary))

    def test_apply_preserves_existing_bytes_and_creates_matching_credentials(self):
        result = provision(self.args(apply=True))
        profile = json.loads(self.output.read_text())
        config = self.config.read_bytes()
        self.assertTrue(config.startswith(self.original))
        self.assertIn(b"Status = Hold\r\n", config)
        for key in ("sessionPassword", "packetPassword", "areaFixPassword"):
            self.assertIn(profile["uplink"][key].encode(), config)
        self.assertEqual(Path(result["backup"]).read_bytes(), self.original)
        self.assertEqual(profile["address"], "1:123/456.101@fidonet")
        self.assertEqual(profile["areas"][0]["tag"], "TEST")

    def test_existing_explicit_point_is_never_overwritten(self):
        with self.assertRaisesRegex(ValueError, "already configured"):
            provision(self.args(point="100", apply=True))
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_existing_signup_file_prevents_config_mutation(self):
        self.output.parent.mkdir()
        self.output.write_text("keep this")
        with self.assertRaisesRegex(ValueError, "already exists"):
            provision(self.args(apply=True))
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(self.output.read_text(), "keep this")

    def test_locks_prevent_two_allocators_writing_at_once(self):
        lock = self.config.with_name(self.config.name + ".retropost.lock")
        lock.write_text("busy")
        with self.assertRaises(FileExistsError):
            provision(self.args(apply=True))
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_injection_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "name"):
            provision(self.args(name="Test\nSessionPwd = bad", apply=True))
        with self.assertRaisesRegex(ValueError, "tags"):
            provision(self.args(area=["TEST\n[node:1:2/3]"]))

    def test_private_file_modes_on_unix(self):
        import os
        if os.name == "nt":
            self.skipTest("Windows uses inherited ACLs")
        result = provision(self.args(apply=True))
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(result["backup"]).stat().st_mode & 0o777, 0o600)

    def test_auto_allocation_scopes_points_to_the_boss(self):
        self.config.write_bytes(self.original + b"[node:1:999/111.101@fidonet]\n")
        self.assertEqual(provision(self.args())["point"], "1:123/456.101@fidonet")

    def test_repeated_apply_refuses_credentials_overwrite(self):
        provision(self.args(apply=True))
        current = self.config.read_bytes()
        with self.assertRaises(ValueError):
            provision(self.args(apply=True))
        self.assertEqual(self.config.read_bytes(), current)

    def test_config_failure_removes_unusable_signup_file(self):
        from unittest.mock import patch
        with patch("provision_point.replace_config", side_effect=OSError("simulated failure")):
            with self.assertRaises(OSError):
                provision(self.args(apply=True))
        self.assertFalse(self.output.exists())
        self.assertEqual(self.config.read_bytes(), self.original)


if __name__ == "__main__":
    unittest.main()
