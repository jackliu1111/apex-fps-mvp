"""Public PowerShell CLI checks; these do not emulate Windows execution."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import struct
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'verify_model_desktop_windows.ps1'
BUILD_SCRIPT = ROOT / 'scripts' / 'build_model_desktop_windows.ps1'


class WindowsPreparationCliTests(unittest.TestCase):
    def setUp(self):
        self.pwsh = (os.environ.get('APEX_PWSH') or shutil.which('pwsh')
                     or str(ROOT / 'build/windows-validation-tools/powershell/pwsh'))
        if not Path(self.pwsh).is_file():
            self.skipTest('PowerShell CLI unavailable; no Windows acceptance inferred')
        self.temp = tempfile.TemporaryDirectory(prefix='windows public CLI ')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def package_headers(self, media_machine=0x8664):
        """Known PE header literals, not runnable Windows or fixture inference."""
        package = self.folder / 'package with spaces'
        runtime = package / 'resources/runtime'
        manifest = {
            'schema_version': 1, 'platform': 'win-x64',
            'service': 'apex-model-service/apex-model-service.exe',
            'ffmpeg': 'apex-model-service/_internal/bin/ffmpeg.exe',
            'ffprobe': 'apex-model-service/_internal/bin/ffprobe.exe',
            'model_workspace': 'model', 'checkpoint': 'model/checkpoints/BEATs_strong_1.pt',
        }
        for target, machine in ((package / 'Apex Model Review.exe', 0x8664),
                                (runtime / manifest['service'], 0x8664),
                                (runtime / manifest['ffmpeg'], media_machine),
                                (runtime / manifest['ffprobe'], 0x8664)):
            target.parent.mkdir(parents=True, exist_ok=True)
            header = bytearray(512)
            header[:2] = b'MZ'
            struct.pack_into('<I', header, 0x3c, 0x80)
            header[0x80:0x84] = b'PE\0\0'
            struct.pack_into('<HH', header, 0x84, machine, 1)
            struct.pack_into('<HH', header, 0x94, 240, 0x22)
            struct.pack_into('<H', header, 0x98, 0x20b)
            target.write_bytes(header)
        checkpoint = runtime / manifest['checkpoint']
        checkpoint.parent.mkdir(parents=True)
        checkpoint.write_bytes(b'fixture checkpoint metadata only')
        (runtime / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        return package

    @unittest.skipIf(sys.platform == 'win32', 'non-Windows refusal scenario')
    def test_native_validation_refuses_non_windows_without_claiming_acceptance(self):
        output = self.folder / 'evidence'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
            '-PackageDirectory', str(self.folder / 'not-a-windows-package'),
            '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['error']['code'], 'windows_required')
        self.assertEqual(report['status'], 'blocked')
        self.assertFalse(report['native_windows_acceptance'])
        self.assertEqual(report['scope'], 'native Windows package validation')

    def test_inspection_reports_missing_bundled_resources_without_running_a_service(self):
        package = self.folder / 'Windows package'
        runtime = package / 'resources/runtime'
        runtime.mkdir(parents=True)
        (runtime / 'manifest.json').write_text(json.dumps({
            'schema_version': 1, 'platform': 'win-x64',
            'service': 'apex-model-service/apex-model-service.exe',
            'ffmpeg': 'apex-model-service/_internal/bin/ffmpeg.exe',
            'ffprobe': 'apex-model-service/_internal/bin/ffprobe.exe',
            'model_workspace': 'model', 'checkpoint': 'model/checkpoints/BEATs_strong_1.pt',
        }), encoding='utf-8')
        output = self.folder / 'inspection evidence'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
            '-InspectOnly', '-PackageDirectory', str(package),
            '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['error']['code'], 'package_incomplete')
        self.assertIn('service', report['missing_resources'])
        self.assertEqual(report['status'], 'failed')
        self.assertFalse(report['native_windows_acceptance'])

    def test_inspection_rejects_a_non_x64_media_binary(self):
        package = self.package_headers(media_machine=0x14c)
        output = self.folder / 'architecture evidence'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
            '-InspectOnly', '-PackageDirectory', str(package),
            '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['error']['code'], 'architecture_mismatch')
        self.assertEqual(report['invalid_native_files'][0]['machine'], '0x014c')
        self.assertTrue(report['invalid_native_files'][0]['path'].endswith('ffmpeg.exe'))
        self.assertFalse(report['native_windows_acceptance'])

    def test_inspection_refuses_manifest_resources_outside_the_installation(self):
        package = self.package_headers()
        manifest_path = package / 'resources/runtime/manifest.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest['checkpoint'] = '../outside.pt'
        (package / 'resources/outside.pt').write_bytes(b'outside installation runtime')
        manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
        output = self.folder / 'path evidence'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
            '-InspectOnly', '-PackageDirectory', str(package),
            '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['error']['code'], 'invalid_resource_reference')
        self.assertEqual(report['invalid_resource'], 'checkpoint')

    def test_valid_headers_can_be_inspected_without_claiming_native_execution(self):
        package = self.package_headers()
        output = self.folder / 'header evidence'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
            '-InspectOnly', '-PackageDirectory', str(package),
            '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['status'], 'inspected')
        self.assertEqual(len(report['native_files']), 4)
        self.assertEqual(report['invalid_native_files'], [])
        self.assertFalse(report['native_windows_acceptance'])
        self.assertEqual(report['native_execution'], 'not_run')

    @unittest.skipUnless(sys.platform == 'darwin', 'actual Mac packaged-core mechanism check')
    def test_mac_protocol_check_uses_the_packaged_core_and_preserves_unicode_paths(self):
        location = ROOT / 'outputs/desktop-archive-macos27/location.json'
        if not location.is_file():
            self.skipTest('verified Mac package unavailable; no native Windows proof inferred')
        package = Path(json.loads(location.read_text(encoding='utf-8'))['extract_dir']) / 'Apex Model Review.app'
        if not package.is_dir():
            self.skipTest('verified Mac package unavailable')
        output = self.folder / '协议 中文 evidence'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
            '-MacProtocolCheck', '-PackageDirectory', str(package),
            '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['status'], 'protocol_passed')
        self.assertFalse(report['native_windows_acceptance'])
        self.assertEqual(report['scope'], 'Mac PowerShell 7 packaged-core protocol mechanisms only')
        self.assertEqual(report['config']['data_dir'], str((output / 'core-data').resolve()))
        self.assertEqual(report['config']['model_state'], 'not_loaded')
        self.assertEqual(report['core_exit_code'], 0)
        evidence = ROOT / 'outputs/windows-preparation-validation/mac-protocol-evidence.json'
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    def test_invalid_package_json_still_leaves_a_structured_diagnostic(self):
        package = self.folder / 'broken package'
        runtime = package / 'resources/runtime'
        runtime.mkdir(parents=True)
        (runtime / 'manifest.json').write_text('{not valid JSON', encoding='utf-8')
        output = self.folder / 'failure diagnostic'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
            '-InspectOnly', '-PackageDirectory', str(package),
            '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['error']['code'], 'package_invalid')
        self.assertTrue(report['error']['message'])

    @unittest.skipIf(sys.platform == 'win32', 'non-Windows build refusal scenario')
    def test_windows_build_wrapper_refuses_cross_compilation_before_running_tools(self):
        output = self.folder / 'build evidence'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(BUILD_SCRIPT),
            '-PythonExecutable', 'must-not-run-python', '-ModelWorkspace', 'must-not-read-model',
            '-FFmpeg', 'must-not-run-ffmpeg', '-FFprobe', 'must-not-run-ffprobe',
            '-MediaLicenseDirectory', 'must-not-read-licenses', '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['error']['code'], 'windows_required')
        self.assertEqual(report['status'], 'blocked')
        self.assertFalse(report['native_windows_build'])
        self.assertFalse(report['native_windows_acceptance'])

    @unittest.skipUnless(sys.platform == 'darwin', 'actual Mac packaged-core mechanism check')
    def test_protocol_request_timeout_can_be_set_for_large_recording_io(self):
        location = ROOT / 'outputs/desktop-archive-macos27/location.json'
        if not location.is_file():
            self.skipTest('verified Mac package unavailable')
        package = Path(json.loads(location.read_text(encoding='utf-8'))['extract_dir']) / 'Apex Model Review.app'
        if not package.is_dir():
            self.skipTest('verified Mac package unavailable')
        output = self.folder / 'request budget evidence'
        completed = subprocess.run([
            self.pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', str(SCRIPT),
            '-MacProtocolCheck', '-RequestTimeoutSeconds', '400',
            '-PackageDirectory', str(package), '-OutputDirectory', str(output),
        ], capture_output=True, text=True, encoding='utf-8', timeout=40)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['request_timeout_seconds'], 400)
        self.assertEqual(report['status'], 'protocol_passed')
        self.assertFalse(report['native_windows_acceptance'])


if __name__ == '__main__':
    unittest.main()
