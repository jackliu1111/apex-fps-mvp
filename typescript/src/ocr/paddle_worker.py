"""Local, persistent PaddleOCR recognition worker. stdout is JSONL only."""
import base64
import contextlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import traceback


def numeric_value(text, score, minimum):
    text = text.strip()
    if not re.fullmatch(r"[0-9]{1,5}", text):
        return None, "non_numeric"
    if not math.isfinite(score) or score < minimum:
        return None, "low_confidence"
    return int(text), "recognized"


def process(request, model, folder, model_name, minimum):
    from PIL import Image, ImageDraw

    started = time.perf_counter()
    width, height = request["width"], request["height"]
    raw = base64.b64decode(request["rgb"], validate=True)
    if len(raw) != width * height * 3:
        raise ValueError("RGB frame size mismatch")
    original = Image.frombytes("RGB", (width, height), raw)
    stem = f'{request["frame_index"]:06d}_{request["time"]:.6f}s_try{request["attempt"]:02d}'
    annotated_path = folder / f"{stem}.frame.png"
    crop_path = folder / f"{stem}.input.png"
    metadata_path = folder / f"{stem}.json"
    region = request.get("region")
    result = dict(frame_index=request["frame_index"], time=request["time"],
                  attempt=request["attempt"], anchor=request.get("anchor"), region=region,
                  engine="paddleocr", model=model_name, min_score=minimum,
                  text="", score=None, value=None, status="no_region",
                  frame_path=str(annotated_path), input_path=None, metadata_path=str(metadata_path))
    annotated = original.copy()
    draw = ImageDraw.Draw(annotated)
    if region:
        x, y, w, h = (region[k] for k in ("x", "y", "width", "height"))
        if min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
            raise ValueError("OCR crop is outside the original frame")
        # Save the unmodified, native-resolution crop BEFORE annotation/inference.
        # predict reads this exact PNG; no digit masks or template normalization.
        original.crop((x, y, x + w, y + h)).save(crop_path)
        result["input_path"] = str(crop_path)
        draw.rectangle((x, y, x + w - 1, y + h - 1), outline="red", width=2)
        try:
            prediction = next(iter(model.predict(str(crop_path), batch_size=1)))
            result["text"] = str(prediction["rec_text"])
            score = float(prediction["rec_score"])
            result["score"] = score if math.isfinite(score) else None
            result["value"], result["status"] = numeric_value(result["text"], score, minimum)
        except Exception as exc:
            result.update(status="ocr_error", error=str(exc))
            annotated.save(annotated_path, compress_level=1)
            metadata_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            raise
    label = f't={request["time"]:.6f}s  {result["status"]}  value={result["value"]}  score={result["score"]}'
    draw.rectangle((0, 0, min(width - 1, 760), 18), fill="black")
    draw.text((3, 3), label, fill="white")
    annotated.save(annotated_path, compress_level=1)
    result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
    metadata_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main():
    protocol = sys.stdout
    # Redirect native/Python library output away from the protocol, too.
    protocol = os.fdopen(os.dup(protocol.fileno()), "w", buffering=1, encoding="utf-8")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    folder = Path(sys.argv[1]).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    model_name = os.environ.get("APEX_OCR_MODEL", "PP-OCRv5_mobile_rec")
    minimum = float(os.environ.get("APEX_OCR_MIN_SCORE", "0"))
    if not math.isfinite(minimum) or not 0 <= minimum <= 1:
        raise ValueError("APEX_OCR_MIN_SCORE must be between 0 and 1")
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import TextRecognition

        kwargs = dict(model_name=model_name, device="cpu", enable_mkldnn=False, cpu_threads=4)
        if os.environ.get("APEX_OCR_MODEL_DIR"):
            kwargs["model_dir"] = os.environ["APEX_OCR_MODEL_DIR"]
        model = TextRecognition(**kwargs)
    print(json.dumps(dict(ready=True, model=model_name)), file=protocol, flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = process(request, model, folder, model_name, minimum)
            print(json.dumps(dict(id=request["id"], result=result), ensure_ascii=False), file=protocol, flush=True)
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps(dict(id=request["id"], error=str(exc))), file=protocol, flush=True)


if __name__ == "__main__":
    main()
