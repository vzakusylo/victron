# camera-ai: local control and recognition for the Tapo C500

Local only: no cloud. Camera: Tapo C500 (pan / tilt), Kitchen, `192.168.0.146`
(DHCP reservation in the DIR-X1530 router).
RTSP `rtsp://<camera account>@192.168.0.146:554/stream1` (HD) and `/stream2` (low res),
ONVIF `http://192.168.0.146:2020/onvif/device_service` (PTZ, Media, Events, Analytics, Imaging).

PC: RTX 2000 Ada Laptop (8 GB VRAM), 63 GB RAM, Python 3.13 (`py`), Ollama.

## Status

| Part | What | Status |
|---|---|---|
| 1 | Credentials setup, ONVIF pan / tilt and presets, frame grabber, web page with arrows, live view, snapshot | **done 2026-11-13**: ONVIF ok (Tapo C500 fw 1.3.5, profile `profile_1`, 4 presets "Viewpoint 1-4"), pan right / left moves the camera (pan -0.01 -> 0.11 -> -0.02), live view 30 fps, snapshot saved, move through the web API ok |
| 2 | Detector on stream2 (person, car, animal) -> events with snapshot; Ollama vision model describes a snapshot ("What is visible?") | code written: `camera_ai/detector.py` (YOLOX-S ONNX via OpenCV DNN, no torch; 0.8 s per frame on CPU; parked car found, conf 0.83), `camera_ai/events.py` (new object = no same-class box with IoU > 0.3 in the last 60 s, seen 2 cycles in a row, 90 s cooldown per class, 15 s relearn after start / camera move; `tests/test_events.py` passes), `camera_ai/vision.py` (Ollama `qwen3-vl:4b`, think off), web: detector boxes, "Ask AI about the frame", event list with description. **Done 2026-11-13**: vision answer ok with `qwen3-vl:4b-instruct` (4 GB VRAM, 35 s first call incl. load, then ~3-6 s) |
| 3 (done) | LLM agent (`qwen3-vl:4b-instruct` with tool calling, one model for vision and tools) controls the camera by chat (move, preset, look and describe); alerts on events; autostart | **chat done**: `camera_ai/agent.py` (tools move, goto_preset, list_presets, save_preset, look, recent_events; max 6 steps), `/api/chat`, chat box on the page. Tested: "which presets" -> list_presets (2 s); "turn a bit right and say what is visible" -> move right 0.5 s -> look (6 s); "back left" ok. **E-mail alerts done** (user chose e-mail via the GX): `camera_ai/alerts.py` copies the event snapshot + JSON message by scp to the GX `/tmp` and runs `/data/home/nodered/tools/send-mail.js` there (same mailbox as the heat pump alerts; no mail password on the PC; 3 tries, the GX Wi-Fi link sometimes times out). Default: person only, at most 1 mail per 10 min; settings on the page ("Письма о событиях") and in `config/camera.json` `alerts`. Test mail sent 2026-11-13 15:30, arrival confirmed by the user. **Autostart done**: Task Scheduler is blocked by policy ("Access is denied"), so a shortcut `camera-ai.lnk` in the user's Startup folder runs `pythonw run_hidden.py` at logon: waits 20 s, starts `app.py` without a window, restarts it 30 s after any exit (tested: killed the app, it came back), exits if port 8090 is already busy; output in `logs/app.log` (cut at 5 MB). To stop: end the `pythonw.exe` / `python.exe` processes of camera-ai; to remove autostart: delete the shortcut. The unused `qwen3-vl:4b` thinking model was removed (2026-11-13); only `qwen3-vl:4b-instruct` is installed. (Task Scheduler at logon, needs the user's OK), optional removal of the unused `qwen3-vl:4b` thinking model (3.3 GB) |

| 4 (done 2026-11-13) | Sound and day view | `camera_ai/audio.py` (PyAV reads the RTSP audio, G.711 8 kHz; event when 2 blocks of 0.5 s in a row are >= 25 dB above the 60 s median and > -30 dBFS, 5 min cooldown (was 18 dB / -38 / 60 s / 1 block: 27 events in half a day); WAV clip 3 s before + 3 s after, frame described by the vision model). Page: sound level, audio player in events, "События за день" (counts, events per hour, AI summary of the day: `/api/day`, `/api/day/summary`). First real sound event 17:03. Sound is level-based, not classified (next: YAMNet-like classifier if wanted); "sound" can be ticked for mails. |

| 5 (2026-11-14) | Moved to omarchy | Runs on omarchy (Arch Linux, 192.168.0.165, 2 cores, 15 GB, no GPU) in `~/camera-ai` as `systemd --user` services `ollama.service` + `camera-ai.service` (linger on, starts at boot); page http://192.168.0.165:8090 (ufw allows 8090 from 192.168.0.0/24, no password). SSH: `ssh -i ~/.ssh/id_ed25519_cam165 -o IdentitiesOnly=yes user1@192.168.0.165`; sudo needs the user's password. Mail alerts off there (needs the GX key on omarchy, ask first). On the PC the app is stopped and the Startup shortcut moved to `C:\learn\camera-ai\camera-ai.lnk.disabled` (move it back to re-enable). Vision on CPU will be slow. |

## Layout

- `setup_camera.py` asks for the camera account (typed by the user) and writes `config/camera.json` (never printed, not in git).
- `camera_ai/config.py` loads the config.
- `camera_ai/onvif.py` minimal ONVIF client (SOAP + WS-Security digest): profiles, ContinuousMove, RelativeMove, Stop, presets.
- `camera_ai/video.py` background RTSP frame grabber (OpenCV, TCP), latest frame + JPEG.
- `app.py` Flask web page on `http://127.0.0.1:8090` (host / port in `config/camera.json`).
- `camera_ai/detector.py` YOLOX-S (`models/yolox_s.onnx`, opencv_zoo, 34 MB) on OpenCV DNN.
- `camera_ai/events.py` event watcher (thread), `events/<id>.jpg` + `events/events.jsonl`.
- `camera_ai/vision.py` Ollama vision chat (`qwen3-vl:4b-instruct`, `num_ctx` 8192: the default 262k
  context needs a 36 GB KV cache, fails to load and once took the whole RAM).
- `camera_ai/agent.py` chat agent with Ollama tool calling.
- `camera_ai/alerts.py` e-mail alerts through the Cerbo GX (scp + ssh with `~/.ssh/id_ed25519_cerbo`).
- Network and device discovery context: `C:\learn\home-network\NETWORK.md`.
- `tests/test_events.py` novelty logic without camera / model.

## Run

```powershell
cd C:\learn\camera-ai
.\.venv\Scripts\python.exe setup_camera.py   # once, type the camera account
.\.venv\Scripts\python.exe app.py
```

## Notes for the next session

- `stream2` is already 1280x720 H.264 (~30 fps) and is used for everything. `stream1` (full resolution)
  answers DESCRIBE 200 but does not open in the OpenCV FFmpeg build (fails right after the SDP, even alone);
  try a standalone ffmpeg or PyAV later if full resolution is needed.
- ONVIF `MoveStatus` is `UNKNOWN` on this camera; position (pan, tilt) is reported.
- The app normally runs hidden (Startup shortcut, `run_hidden.py`, log `logs/app.log`). To run it in a
  terminal for debugging, stop the hidden one first (port 8090), then
  `Set-Location C:\learn\camera-ai; .\.venv\Scripts\python.exe app.py`.

- Never put the camera password in code, logs or chat; it lives only in `config/camera.json`.
- Big downloads (torch CUDA, ultralytics, Ollama models) were allowed by the user for all 3 parts.
- **Disk:** C: had only ~5.5 GB free; the torch CUDA install failed with "No space left on device" and was
  stopped (nothing of torch / ultralytics installed, no Ollama model pulled). I: and J: are corporate network
  shares, not for models. ~9.7 GB in %TEMP% are old Visual Studio installer caches (z5g50oqc, alddovq1),
  deleted only if the user agrees. Light plan without torch: OpenCV DNN detector (ONNX, ~35 MB) plus one
  Ollama model that does vision and tool calling (`qwen3-vl:4b`, ~3.3 GB).
