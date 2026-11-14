"""Object detector: YOLOX-S (COCO, 80 classes) from the OpenCV model zoo, run by OpenCV DNN (no torch).

Model: models/yolox_s.onnx (opencv_zoo object_detection_yolox_2022nov.onnx). Input 640x640 BGR 0..255,
letterbox padded with 114; output decoded with grids / strides 8, 16, 32.
"""
from pathlib import Path

import cv2
import numpy as np

COCO = ("person bicycle car motorcycle airplane bus train truck boat traffic_light fire_hydrant stop_sign "
        "parking_meter bench bird cat dog horse sheep cow elephant bear zebra giraffe backpack umbrella handbag "
        "tie suitcase frisbee skis snowboard sports_ball kite baseball_bat baseball_glove skateboard surfboard "
        "tennis_racket bottle wine_glass cup fork knife spoon bowl banana apple sandwich orange broccoli carrot "
        "hot_dog pizza donut cake chair couch potted_plant bed dining_table toilet tv laptop mouse remote keyboard "
        "cell_phone microwave oven toaster sink refrigerator book clock vase scissors teddy_bear hair_drier "
        "toothbrush").split()

MODEL = Path(__file__).resolve().parent.parent / "models" / "yolox_s.onnx"


class Detector:
    def __init__(self, model: Path = MODEL, conf: float = 0.45, nms: float = 0.5, size: int = 640):
        self.net = cv2.dnn.readNet(str(model))
        self.conf, self.nms, self.size = conf, nms, size
        grids, strides = [], []
        for s in (8, 16, 32):
            n = size // s
            xv, yv = np.meshgrid(np.arange(n), np.arange(n))
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
            strides.append(np.full((n * n, 1), s))
        self.grids = np.concatenate(grids).astype(np.float32)
        self.strides = np.concatenate(strides).astype(np.float32)

    def detect(self, frame: np.ndarray) -> list[dict]:
        """Returns [{label, conf, box: [x1, y1, x2, y2]}] in frame pixels."""
        h, w = frame.shape[:2]
        r = min(self.size / h, self.size / w)
        img = np.full((self.size, self.size, 3), 114.0, np.float32)
        img[: int(h * r), : int(w * r)] = cv2.resize(frame, (int(w * r), int(h * r))).astype(np.float32)
        self.net.setInput(np.transpose(img, (2, 0, 1))[None])
        out = self.net.forward(self.net.getUnconnectedOutLayersNames())[0][0]
        xy = (out[:, :2] + self.grids) * self.strides
        wh = np.exp(out[:, 2:4]) * self.strides
        scores = out[:, 4:5] * out[:, 5:]
        cls = scores.argmax(1)
        best = scores[np.arange(len(cls)), cls]
        keep = best >= self.conf
        if not keep.any():
            return []
        xy, wh, cls, best = xy[keep], wh[keep], cls[keep], best[keep]
        boxes = np.concatenate([xy - wh / 2, wh], 1) / r  # x, y, w, h in frame pixels
        idx = cv2.dnn.NMSBoxesBatched(boxes.tolist(), best.tolist(), cls.tolist(), self.conf, self.nms)
        dets = []
        for i in np.array(idx).flatten():
            x, y, bw, bh = boxes[i]
            dets.append({"label": COCO[int(cls[i])], "conf": round(float(best[i]), 2),
                         "box": [int(max(0, x)), int(max(0, y)), int(min(w, x + bw)), int(min(h, y + bh))]})
        return sorted(dets, key=lambda d: -d["conf"])


def draw(frame: np.ndarray, dets: list[dict]) -> np.ndarray:
    img = frame.copy()
    for d in dets:
        x1, y1, x2, y2 = d["box"]
        color = (0, 200, 255) if d["label"] == "person" else (80, 220, 80)
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        cv2.putText(img, f"{d['label']} {d['conf']:.2f}", (x1 + 3, max(14, y1 - 5)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2, cv2.LINE_AA)
    return img
