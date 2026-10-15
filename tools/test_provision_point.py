import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import subprocess
import sys
from unittest.mock import patch

from provision_point import provision
from live_provision import data_directory


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.config = root / "sbbsecho.ini"
        self.data = root / "data"
        self.data.mkdir()
        (root / "main.ini").write_text("[dir]\ndata = data\n")
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

    def test_live_apply_holds_native_mutex_only_during_commit_and_resumes_events(self):
        import provision_point
        replace = provision_point.replace_config
        mutex = self.config.parent / "sbbsecho.bsy"
        def verify(filename, data):
            self.assertTrue(mutex.exists())
            self.assertFalse((self.data / 'fidoin.now').exists())
            self.assertFalse((self.data / 'fidoout.now').exists())
            replace(filename, data)
        with patch('provision_point.replace_config', side_effect=verify):
            result = provision(self.args(apply=True))
        self.assertFalse(mutex.exists())
        self.assertEqual(result['coordination'], 'sbbsecho.bsy')
        for event in ['fidoin', 'fidoout']:
            self.assertTrue((self.data / (event + '.now')).exists())

    def test_busy_native_mutex_times_out_without_touching_configuration_or_removing_lock(self):
        mutex = self.config.parent / 'sbbsecho.bsy'
        mutex.write_text('Existing SBBSecho owner')
        with self.assertRaisesRegex(ValueError, 'timed out'):
            provision(self.args(apply=True, wait_seconds=0))
        self.assertEqual(mutex.read_text(), 'Existing SBBSecho owner')
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.data.glob('*.now')))
        self.assertFalse(list(self.config.parent.glob('*.retropost.lock')))

    def test_waits_for_tosser_and_allocates_from_its_updated_configuration(self):
        mutex = self.config.parent / 'sbbsecho.bsy'
        mutex.write_text('SBBSecho processing')
        updated = self.original + b'[node:1:123/456.101@fidonet]\nSessionPwd = OTHER\n'
        def finish_tosser():
            time.sleep(0.15)
            self.config.write_bytes(updated)
            mutex.unlink()
        worker = threading.Thread(target=finish_tosser)
        worker.start()
        try:
            result = provision(self.args(apply=True, wait_seconds=2))
        finally:
            worker.join()
        self.assertEqual(result['point'], '1:123/456.102@fidonet')
        self.assertTrue(self.config.read_bytes().startswith(updated))
        self.assertEqual(Path(result['backup']).read_bytes(), updated)

    def test_waits_for_echocfg_instead_of_saving_over_its_snapshot(self):
        with patch('live_provision.echocfg_running', side_effect=[True, False, False, False]):
            result = provision(self.args(apply=True, wait_seconds=2))
        self.assertTrue(result['apply'])
        with patch('live_provision.echocfg_running', return_value=True):
            with self.assertRaisesRegex(ValueError, 'EchoCfg is open'):
                provision(self.args(apply=True, wait_seconds=0, output=self.output.with_name('other.packetlark')))

    def test_editor_or_config_change_during_preparation_aborts_and_removes_account(self):
        with patch('provision_point.check_editor', side_effect=ValueError('EchoCfg opened')):
            with self.assertRaisesRegex(ValueError, 'EchoCfg opened'):
                provision(self.args(apply=True))
        self.assertFalse(self.output.exists())
        self.assertEqual(self.config.read_bytes(), self.original)
        import provision_point
        write = provision_point.write_exclusive
        def concurrent_edit(filename, data):
            write(filename, data)
            if filename == self.output.resolve():
                self.config.write_bytes(self.original + b'; concurrent manual edit\n')
        with patch('provision_point.write_exclusive', side_effect=concurrent_edit):
            with self.assertRaisesRegex(ValueError, 'Configuration changed'):
                provision(self.args(apply=True))
        self.assertFalse(self.output.exists())
        self.assertTrue(self.config.read_bytes().endswith(b'; concurrent manual edit\n'))
        self.assertFalse((self.config.parent / 'sbbsecho.bsy').exists())

    def test_interruption_releases_both_locks_and_signals_pending_mail(self):
        with patch('provision_point.replace_config', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                provision(self.args(apply=True))
        self.assertFalse(self.output.exists())
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse((self.config.parent / 'sbbsecho.bsy').exists())
        self.assertFalse(list(self.config.parent.glob('*.retropost.lock')))
        self.assertTrue((self.data / 'fidoin.now').exists())

    def test_existing_event_semaphores_and_custom_codes_are_preserved(self):
        sem = self.data / 'import.now'
        sem.write_text('already queued')
        provision(self.args(apply=True, resume_event=['IMPORT', 'EXPORT']))
        self.assertEqual(sem.read_text(), 'already queued')
        self.assertTrue((self.data / 'export.now').exists())
        self.assertFalse((self.data / 'fidoin.now').exists())

    def test_missing_data_directory_and_invalid_event_codes_abort_before_commit(self):
        with self.assertRaises(OSError):
            provision(self.args(apply=True, data_dir=self.data / 'missing'))
        with self.assertRaisesRegex(ValueError, 'internal event codes'):
            provision(self.args(apply=True, resume_event=['../outside']))
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(self.output.exists())

    def test_reads_real_synchronet_dir_section_and_supports_explicit_override(self):
        self.assertEqual(data_directory(self.config, None), self.data)
        (self.config.parent / 'main.ini').write_text('!include other.ini\n')
        with self.assertRaisesRegex(ValueError, 'includes'):
            data_directory(self.config, None)
        self.assertEqual(data_directory(self.config, self.data), self.data)

    def test_offline_mode_preserves_existing_stopped_bbs_workflow(self):
        mutex = self.config.parent / 'sbbsecho.bsy'
        mutex.write_text('untouched offline marker')
        result = provision(self.args(apply=True, offline=True))
        self.assertTrue(result['apply'])
        self.assertEqual(mutex.read_text(), 'untouched offline marker')
        self.assertFalse(list(self.data.glob('*.now')))

    def test_resume_failure_reports_committed_account_without_destroying_it(self):
        with patch('live_provision.resume_events', side_effect=OSError('Disk unavailable')):
            result = provision(self.args(apply=True))
        self.assertTrue(self.output.exists())
        self.assertIn(result['point'].encode(), self.config.read_bytes())
        self.assertIn('Could not signal', result['warnings'][0])

    def test_interrupt_after_atomic_commit_keeps_the_matching_credentials(self):
        import provision_point
        replace = provision_point.replace_config
        def commit_then_interrupt(filename, data):
            replace(filename, data)
            raise KeyboardInterrupt
        with patch('provision_point.replace_config', side_effect=commit_then_interrupt):
            with self.assertRaises(KeyboardInterrupt):
                provision(self.args(apply=True))
        profile = json.loads(self.output.read_text())
        self.assertIn(profile['uplink']['sessionPassword'].encode(), self.config.read_bytes())
        self.assertFalse((self.config.parent / 'sbbsecho.bsy').exists())

    def test_cli_live_apply_uses_companion_and_does_not_print_credentials(self):
        command = [sys.executable, str(Path(__file__).with_name('provision_point.py')),
                   '--config', str(self.config), '--boss', '1:123/456',
                   '--host', 'bbs.example.invalid', '--name', 'Test Person',
                   '--output', str(self.output), '--apply']
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = json.loads(self.output.read_text())
        for key in ['sessionPassword', 'packetPassword', 'areaFixPassword']:
            self.assertNotIn(profile['uplink'][key], result.stdout + result.stderr)
        self.assertIn('sbbsecho.bsy', result.stdout)
        self.assertTrue((self.data / 'fidoin.now').exists())

    def test_namespace_module_entry_point_still_supports_side_effect_free_preview(self):
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run([sys.executable, '-m', 'tools.provision_point',
                                 '--config', str(self.config), '--boss', '1:123/456',
                                 '--host', 'bbs.example.invalid', '--name', 'Test Person',
                                 '--output', str(self.output)],
                                cwd=root, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Preview only', result.stdout)
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.data.iterdir()))


if __name__ == "__main__":
    unittest.main()
