"""Asset tooling must run on the documented Python 3.9+ interpreter."""
import hashlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
TOOLS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('download_runtime_under_test', TOOLS / 'download_runtime.py')
download_runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download_runtime)


class DigestTest(unittest.TestCase):
    def test_sha256_file_matches_hashlib_across_chunk_boundaries(self):
        data = b'apex-local-cut' * 200000
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'asset.bin'
            path.write_bytes(data)
            self.assertEqual(download_runtime.sha256_file(path), hashlib.sha256(data).hexdigest())

    def test_asset_tools_do_not_use_the_python_311_only_digest_api(self):
        for name in ('download_runtime.py', 'export_efficientat.py', 'export_model.py'):
            self.assertNotIn('hashlib.file_digest(', (TOOLS / name).read_text(), name)

    def test_empty_file_hashes_like_hashlib(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'empty.bin'
            path.write_bytes(b'')
            self.assertEqual(download_runtime.sha256_file(path), hashlib.sha256(b'').hexdigest())


if __name__ == '__main__':
    unittest.main()
