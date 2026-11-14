"""Chat agent: a local LLM (Ollama tool calling) that turns the camera, uses presets and looks.

Tools: move, goto_preset, list_presets, save_preset, look (vision LLM on the current frame),
recent_events. The same model (qwen3-vl:4b) is used for chat, tools and vision.
"""
import json
import threading
import time

import requests

from . import vision

MODEL = vision.MODEL
SYSTEM = (
    "Ты помощник, который управляет домашней камерой Tapo C500 (поворот и наклон) у дома в Норвегии. "
    "Отвечай по-русски, коротко. Используй инструменты: move — повернуть (left/right/up/down, секунды 0.2–3), "
    "goto_preset — перейти к сохранённой позиции, list_presets, save_preset, look — посмотреть на текущий кадр "
    "и ответить на вопрос о нём, recent_events — последние события детектора. Чтобы ответить, что видно, "
    "всегда сначала вызывай look; не выдумывай то, чего не видел. После поворота подожди и снова вызови look, "
    "если пользователь просит что-то найти. Не делай больше 6 действий на один запрос."
)

TOOLS = [
    {"type": "function", "function": {
        "name": "move", "description": "Turn the camera for some seconds in a direction, then stop.",
        "parameters": {"type": "object", "required": ["direction"], "properties": {
            "direction": {"type": "string", "enum": ["left", "right", "up", "down"]},
            "seconds": {"type": "number", "description": "0.2-3, about 0.5 s = a small step"}}}}},
    {"type": "function", "function": {
        "name": "goto_preset", "description": "Move the camera to a saved position by its name.",
        "parameters": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "list_presets", "description": "List saved camera positions.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "save_preset", "description": "Save the current camera position under a name.",
        "parameters": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "look", "description": "Look at the current camera frame and answer a question about it.",
        "parameters": {"type": "object", "properties": {"question": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "recent_events", "description": "Recent detector events (time, objects, description).",
        "parameters": {"type": "object", "properties": {"n": {"type": "integer"}}}}},
]


class Agent:
    def __init__(self, cam_ptz, grabber, watcher, max_steps: int = 6):
        """cam_ptz(fn_name, *args) runs an Onvif method under the PTZ lock."""
        self.ptz, self.grabber, self.watcher, self.max_steps = cam_ptz, grabber, watcher, max_steps
        self.history: list = []
        self.lock = threading.Lock()

    # --- tools ----------------------------------------------------------------
    def _move(self, direction: str, seconds: float = 0.5) -> str:
        v = {"left": (-0.5, 0), "right": (0.5, 0), "up": (0, 0.5), "down": (0, -0.5)}.get(direction)
        if not v:
            return "unknown direction"
        self.ptz("move_for", v[0], v[1], max(0.2, min(3.0, float(seconds))))
        self.watcher.clear_known()
        time.sleep(1.0)  # let the picture settle before the next look
        return f"moved {direction} for {seconds} s"

    def _find_preset(self, name: str):
        ps = self.ptz("presets")
        n = name.strip().lower()
        return next((p for p in ps if p["name"].lower() == n), None) or \
            next((p for p in ps if n in p["name"].lower()), None), ps

    def _goto(self, name: str) -> str:
        p, ps = self._find_preset(name)
        if not p:
            return "no such preset; known: " + ", ".join(x["name"] for x in ps)
        self.ptz("goto_preset", p["token"])
        self.watcher.clear_known()
        time.sleep(3.0)
        return f"at preset {p['name']}"

    def _look(self, question: str = "Что видно на кадре?") -> str:
        jpg = self.grabber.jpeg(quality=85)
        if jpg is None:
            return "no video frame"
        return vision.ask(jpg, question or "Что видно на кадре?")

    def _events(self, n: int = 5) -> str:
        evs = self.watcher.recent(max(1, min(20, int(n))))
        return json.dumps([{k: e.get(k) for k in ("time", "labels", "description")} for e in evs], ensure_ascii=False)

    def run_tool(self, name: str, args: dict) -> str:
        try:
            if name == "move":
                return self._move(args.get("direction", ""), args.get("seconds", 0.5))
            if name == "goto_preset":
                return self._goto(str(args.get("name", "")))
            if name == "list_presets":
                return ", ".join(p["name"] for p in self.ptz("presets")) or "no presets"
            if name == "save_preset":
                self.ptz("set_preset", str(args.get("name", ""))[:30])
                return "saved"
            if name == "look":
                return self._look(str(args.get("question", "")))
            if name == "recent_events":
                return self._events(args.get("n", 5))
            return f"unknown tool {name}"
        except Exception as e:  # noqa: BLE001
            return f"error: {e}"

    # --- chat -----------------------------------------------------------------
    def chat(self, text: str) -> dict:
        with self.lock:
            msgs = [{"role": "system", "content": SYSTEM}] + self.history[-12:] + [{"role": "user", "content": text}]
            steps = []
            for _ in range(self.max_steps + 1):
                r = requests.post(f"{vision.OLLAMA}/api/chat", timeout=300, json={
                    "model": MODEL, "stream": False, "think": False, "keep_alive": "10m",
                    "options": {"temperature": 0.2, "num_ctx": vision.NUM_CTX}, "messages": msgs, "tools": TOOLS})
                r.raise_for_status()
                m = r.json().get("message", {})
                calls = m.get("tool_calls") or []
                msgs.append({"role": "assistant", "content": m.get("content", ""), "tool_calls": calls})
                if not calls or len(steps) >= self.max_steps:
                    answer = (m.get("content") or "").strip() or "(нет ответа)"
                    self.history += [{"role": "user", "content": text}, {"role": "assistant", "content": answer}]
                    return {"answer": answer, "steps": steps}
                for c in calls:
                    fn = c.get("function", {})
                    args = fn.get("arguments") or {}
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except ValueError:
                            args = {}
                    result = self.run_tool(fn.get("name", ""), args)
                    steps.append({"tool": fn.get("name"), "args": args, "result": result[:500]})
                    msgs.append({"role": "tool", "tool_name": fn.get("name"), "content": result})
            return {"answer": "(слишком много шагов)", "steps": steps}

    def reset(self) -> None:
        with self.lock:
            self.history = []
