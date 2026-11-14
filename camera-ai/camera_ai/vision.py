"""Local vision LLM through Ollama (default qwen3-vl:4b): describe a frame or answer a question about it."""
import base64

import requests

OLLAMA = "http://127.0.0.1:11434"
MODEL = "qwen3-vl:4b-instruct"  # the plain 4b tag is the thinking variant and ignores think=false
NUM_CTX = 8192  # the model default (262k) needs a 36 GB KV cache and fails to load
SYSTEM = ("You look at frames of a home security camera in Norway (house, driveway, garden). "
          "Answer in Russian, short and factual: who or what is visible, where, what they do. "
          "Do not guess identities. If nothing notable is visible, say so.")


def ask(jpeg: bytes, question: str = "Что видно на кадре?", model: str = MODEL, timeout: float = 180) -> str:
    r = requests.post(f"{OLLAMA}/api/chat", timeout=timeout, json={
        "model": model,
        "stream": False,
        "think": False,
        "keep_alive": "10m",
        "options": {"temperature": 0.2, "num_predict": 300, "num_ctx": NUM_CTX},
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": question, "images": [base64.b64encode(jpeg).decode()]},
        ],
    })
    r.raise_for_status()
    return (r.json().get("message", {}).get("content") or "").strip()


def text(prompt: str, model: str = MODEL, timeout: float = 240) -> str:
    r = requests.post(f"{OLLAMA}/api/chat", timeout=timeout, json={
        "model": model, "stream": False, "think": False, "keep_alive": "10m",
        "options": {"temperature": 0.2, "num_predict": 500, "num_ctx": NUM_CTX},
        "messages": [{"role": "user", "content": prompt}]})
    r.raise_for_status()
    return (r.json().get("message", {}).get("content") or "").strip()


def available(model: str = MODEL) -> bool:
    try:
        tags = requests.get(f"{OLLAMA}/api/tags", timeout=3).json().get("models", [])
        return any(m.get("name") == model or m.get("model") == model for m in tags)
    except requests.RequestException:
        return False
