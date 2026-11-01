"""Startup asset-readiness reporting for the local static host."""
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
SERVE = Path(__file__).resolve().parents[1] / 'serve.py'
spec = importlib.util.spec_from_file_location('serve_under_test', SERVE)
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


def touch(root, name):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'x')


def complete_assets(root):
    for name in serve.VENDOR_ASSETS:
        touch(root, name)
    for names in serve.MODEL_ASSETS.values():
        for name in names:
            touch(root, name)


class MissingAssetsTest(unittest.TestCase):
    def test_empty_directory_reports_runtime_and_every_model_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = serve.missing_assets(Path(tmp))
        expected = len(serve.VENDOR_ASSETS) + sum(len(names) for names in serve.MODEL_ASSETS.values())
        self.assertEqual(len(missing), expected)
        names = [name for _, name in missing]
        self.assertIn('vendor/mediabunny.mjs', names)
        self.assertIn('efficientat/model.json', names)
        self.assertIn('model.json', names)

    def test_complete_directory_reports_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            complete_assets(Path(tmp))
            self.assertEqual(serve.missing_assets(Path(tmp)), [])
            output = io.StringIO()
            serve.report_assets(Path(tmp), output)
        self.assertIn('齐全', output.getvalue())

    def test_missing_manifest_is_named_with_recovery_hint(self):
        with tempfile.TemporaryDirectory() as tmp:
            complete_assets(Path(tmp))
            (Path(tmp) / 'efficientat/model.json').unlink()
            output = io.StringIO()
            missing = serve.report_assets(Path(tmp), output)
        self.assertEqual(missing, [('EfficientAT 默认模型', 'efficientat/model.json')])
        text = output.getvalue()
        self.assertIn('efficientat/model.json', text)
        self.assertIn('--assets', text)
        self.assertIn('重建模型资产', text)


if __name__ == '__main__':
    unittest.main()
