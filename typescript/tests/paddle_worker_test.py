import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

spec = importlib.util.spec_from_file_location("paddle_worker", Path(__file__).parents[1] / "src/ocr/paddle_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_numeric_contract(self):
        for text, score, minimum, expected in [
            (" 64 ", .9, 0, 64), ("0", .8, 0, 0), ("00103", .9, 0, 103),
            ("84", .1, 0, 84), ("84", .1, .8, None), ("1O3", .99, 0, None),
            ("103 HP", .99, 0, None), ("12 34", .99, 0, None),
            ("123456", .99, 0, None), ("12", float("nan"), 0, None),
        ]:
            with self.subTest(text=text, score=score):
                self.assertEqual(worker.numeric_value(text, score, minimum)[0], expected)

    def test_exact_input_pixels_annotation_and_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            data = bytes((i * 13) % 256 for i in range(80 * 60 * 3))
            original = Image.frombytes("RGB", (80, 60), data)
            expected = original.crop((12, 24, 32, 39))
            case = self

            class Recognizer:
                def predict(self, path, batch_size):
                    with Image.open(path) as loaded:
                        case.assertEqual(loaded.tobytes(), expected.tobytes())
                    return [{"rec_text": "64", "rec_score": .95}]

            request = dict(width=80, height=60, rgb=base64.b64encode(data).decode(),
                           frame_index=1, time=4.123456, attempt=1,
                           region=dict(x=12, y=24, width=20, height=15))
            result = worker.process(request, Recognizer(), folder, "test", 0)
            self.assertEqual(result["value"], 64)
            with Image.open(result["input_path"]) as loaded:
                self.assertEqual(loaded.size, (20, 15))
            with Image.open(result["frame_path"]) as loaded:
                marked = loaded.copy()
            self.assertEqual(marked.size, original.size)
            self.assertEqual(marked.getpixel((12, 24)), (255, 0, 0))
            self.assertEqual(marked.getpixel((50, 50)), original.getpixel((50, 50)))
            self.assertEqual(json.loads(Path(result["metadata_path"]).read_text())["time"], 4.123456)
            request.update(region=None, frame_index=2, attempt=0)
            result = worker.process(request, None, folder, "test", 0)
            self.assertIsNone(result["value"])
            self.assertIsNone(result["input_path"])
            self.assertTrue(Path(result["frame_path"]).exists())

    def test_failure_keeps_evidence(self):
        class Broken:
            def predict(self, *args, **kwargs):
                raise RuntimeError("inference failed")

        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            request = dict(width=40, height=40, rgb=base64.b64encode(bytes(4800)).decode(),
                           frame_index=1, time=0, attempt=1, region=dict(x=4, y=20, width=20, height=12))
            with self.assertRaisesRegex(RuntimeError, "inference failed"):
                worker.process(request, Broken(), folder, "test", 0)
            self.assertEqual(len(list(folder.glob('*.png'))), 2)
            record = json.loads(next(folder.glob('*.json')).read_text())
            self.assertEqual(record['status'], 'ocr_error')


if __name__ == '__main__':
    unittest.main()
