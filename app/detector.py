"""Animal detector using a configurable YOLO model. Batched inference via queue,
N parallel worker threads.
Pre-processing (PIL→tensor) happens in caller threads; batch threads only run the GPU kernel."""

import logging
import os
import queue
import threading
import time

import numpy as np
import torch
from PIL import Image

log = logging.getLogger("detector")

YOLO_BATCH_SIZE = int(os.environ.get("YOLO_BATCH_SIZE", 32))
YOLO_WORKERS = int(os.environ.get("GPU_WORKERS", 2))
YOLO_INPUT_SIZE = int(os.environ.get("YOLO_INPUT_SIZE", 640))
YOLO_MODEL = os.environ.get("YOLO_MODEL", "yolo26s.pt")
YOLO_DEDUP_IOU = float(os.environ.get("YOLO_DEDUP_IOU", 0.85))
YOLO_DEDUP_IOA = float(os.environ.get("YOLO_DEDUP_IOA", 0.9))

ANIMAL_CLASS_IDS = {
    14,  # bird
    15,  # cat
    16,  # dog
    17,  # horse
    18,  # sheep
    19,  # cow
    20,  # elephant
    21,  # bear
    22,  # zebra
    23,  # giraffe
}


def _bbox_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    a_area = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    b_area = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = a_area + b_area - inter
    return inter / union if union > 0.0 else 0.0


def _bbox_area(box: tuple[float, float, float, float]) -> float:
    x1, y1, x2, y2 = box
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def _bbox_intersection_area(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    return max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)


def _bbox_ioa_small(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    """Intersection over smaller box area.

    This catches nested duplicate detections where IoU may be moderate but one
    box mostly overlaps the other.
    """
    inter = _bbox_intersection_area(a, b)
    if inter <= 0.0:
        return 0.0
    min_area = min(_bbox_area(a), _bbox_area(b))
    return inter / min_area if min_area > 0.0 else 0.0


def _dedupe_overlapping_boxes(
    scored_boxes: list[tuple[float, tuple[float, float, float, float]]],
    iou_threshold: float,
    ioa_threshold: float,
) -> list[tuple[float, float, float, float]]:
    """Class-agnostic suppression to remove near-duplicate detections.

    Ultralytics NMS is class-aware, so the same animal can appear twice if
    classified under different animal classes. Keep the highest-confidence box.
    """
    kept: list[tuple[float, float, float, float]] = []
    for _, box in scored_boxes:
        if any((_bbox_iou(box, prev) >= iou_threshold) or (_bbox_ioa_small(box, prev) >= ioa_threshold) for prev in kept):
            continue
        kept.append(box)
    return kept


class _YoloReq:
    __slots__ = ("tensor", "event", "result")
    def __init__(self, tensor: torch.Tensor):
        self.tensor = tensor
        self.event = threading.Event()
        self.result: list | None = None


_yolo_queue: queue.Queue[_YoloReq] = queue.Queue()
_yolo_worker_threads: list[threading.Thread] = []
_yolo_worker_lock = threading.Lock()

yolo_batch_total = 0
yolo_batch_count = 0
_yolo_stats_lock = threading.Lock()

# Set when the first YOLO worker finishes loading. Never set if loading fails.
_yolo_worker_ready = threading.Event()
# Set to an error string if loading fails.
_yolo_load_error: str | None = None


def is_yolo_ready() -> bool:
    return _yolo_worker_ready.is_set()


def get_yolo_error() -> str | None:
    return _yolo_load_error


def get_yolo_model() -> str:
    return YOLO_MODEL


def _yolo_batch_loop(worker_id: int) -> None:
    global yolo_batch_total, yolo_batch_count, _yolo_load_error
    from ultralytics import YOLO
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info(f"YOLO worker {worker_id} loading model '{YOLO_MODEL}' on {device}...")
    try:
        model = YOLO(YOLO_MODEL)
        model.to(device)
    except Exception as e:
        _yolo_load_error = str(e)
        log.error(
            f"YOLO worker {worker_id} failed to load: {e}. "
            "On first start the model is downloaded (~6 MB). "
            "Ensure the container has internet access, then restart. "
            f"Alternatively, copy {YOLO_MODEL} into the data volume manually."
        )
        return
    _yolo_worker_ready.set()
    log.info(f"YOLO worker {worker_id} ready")

    while True:
        first = _yolo_queue.get()
        batch = [first]
        try:
            while len(batch) < YOLO_BATCH_SIZE:
                batch.append(_yolo_queue.get_nowait())
        except queue.Empty:
            pass

        with _yolo_stats_lock:
            yolo_batch_total += len(batch)
            yolo_batch_count += 1

        try:
            # Tensors are already preprocessed by caller threads: B×C×H×W, float32, [0,1], RGB.
            # Ultralytics skips PIL/numpy conversion when given a tensor directly.
            stacked = torch.stack([req.tensor for req in batch])
            results_list = model(stacked, verbose=False, imgsz=YOLO_INPUT_SIZE)
            for req, result in zip(batch, results_list):
                boxes: list[tuple[float, tuple[float, float, float, float]]] = []
                for box in result.boxes:
                    cls = int(box.cls[0])
                    if cls not in ANIMAL_CLASS_IDS:
                        continue
                    conf = float(box.conf[0])
                    x1, y1, x2, y2 = box.xyxyn[0].tolist()
                    boxes.append((conf, (x1, y1, x2, y2)))
                boxes.sort(key=lambda x: x[0], reverse=True)
                req.result = _dedupe_overlapping_boxes(boxes, YOLO_DEDUP_IOU, YOLO_DEDUP_IOA)
                req.event.set()
        except Exception as e:
            log.warning(f"YOLO worker {worker_id} batch error: {e}")
            for req in batch:
                req.result = []
                req.event.set()


def _ensure_yolo_workers() -> None:
    with _yolo_worker_lock:
        alive = [t for t in _yolo_worker_threads if t.is_alive()]
        for i in range(len(alive), YOLO_WORKERS):
            t = threading.Thread(target=_yolo_batch_loop, args=(i,), daemon=True, name=f"yolo-batch-{i}")
            t.start()
            _yolo_worker_threads.append(t)


def _wait_for_yolo_ready(timeout: float = 300) -> None:
    deadline = time.time() + timeout
    while not _yolo_worker_ready.is_set():
        if _yolo_load_error:
            raise RuntimeError(f"YOLO not available: {_yolo_load_error}")
        if time.time() > deadline:
            raise RuntimeError(_yolo_load_error or "YOLO worker did not become ready")
        time.sleep(0.1)


def detect_animals(img: Image.Image) -> list[tuple[float, float, float, float]]:
    """Returns (x1, y1, x2, y2) normalized bboxes for detected animals, sorted by confidence."""
    _ensure_yolo_workers()
    _wait_for_yolo_ready()
    # Pre-process in caller's thread (parallel across all scan workers).
    small = img.resize((YOLO_INPUT_SIZE, YOLO_INPUT_SIZE), Image.BILINEAR)
    arr = np.array(small, dtype=np.float32) / 255.0  # H×W×3, RGB, [0,1]
    tensor = torch.from_numpy(arr.transpose(2, 0, 1))  # C×H×W
    req = _YoloReq(tensor)
    _yolo_queue.put(req)
    if not req.event.wait(timeout=120):
        raise RuntimeError("YOLO worker did not respond within 120 s. Model may still be downloading.")
    return req.result
