# camera-ai

Local control and recognition for a Tapo C500 pan / tilt camera, no cloud:
live view, pan / tilt and presets (ONVIF), object detection (YOLOX-S on OpenCV DNN), loud-sound events,
event log by day, frame descriptions and a chat that moves the camera (local LLM through Ollama),
e-mail alerts through the Cerbo GX mail tool (`tools/send-mail.js`).

Status, design notes and deployment: [PLAN.md](PLAN.md).

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
mkdir -p models && curl -L -o models/yolox_s.onnx \
  https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/object_detection_yolox/object_detection_yolox_2022nov.onnx
ollama pull qwen3-vl:4b-instruct
.venv/bin/python setup_camera.py   # asks for the camera account, writes config/camera.json (not in git)
.venv/bin/python app.py            # http://<host>:8090
```

The page has no login: bind it to `127.0.0.1` (`web_host` in `config/camera.json`) or allow the port only
from the home network.
