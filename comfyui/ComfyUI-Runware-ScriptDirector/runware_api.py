"""Small Runware REST client (Python standard library only, so ComfyUI Desktop needs no extra installs).

Every request is a JSON array: an authentication task followed by the real tasks, sent to
https://api.runware.ai/v1 (the same format the Craftush website relay uses).
"""
import base64
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid

API_URL = os.environ.get("RUNWARE_API_URL", "https://api.runware.ai/v1")
PACK_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(PACK_DIR, "runware_api_key.txt")

# Dropdown values are "Name — AIR id"; the id after the dash is what is sent to Runware.
TEXT_MODELS = [
    "Claude Opus 5.5 — anthropic:claude@opus-5.5",
    "Claude Sonnet 5 — anthropic:claude@sonnet-5",
    "Claude Opus 4.8 — anthropic:claude@opus-4.8",
]
IMAGE_MODELS = [
    "FLUX.2 [max] — bfl:7@1",
    "GPT-Image-2.5 Sunburst — openai:gpt-image@2.5-sunburst",
    "GPT Image 2 — openai:gpt-image@2",
]
AIR_RE = re.compile(r"^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$")

MODEL_REJECTED = re.compile(
    r"invalid value for 'model'|valid text model|model not found|unknown model|invalid model|"
    r"not a valid model|unsupported model|model .{0,40}not (?:found|available|supported|exist)|invalidModel|modelNotFound",
    re.I,
)
TRANSIENT = re.compile(
    r"unavailable|bad gateway|gateway|timed? ?out|overloaded|temporar|capacity|try again|rate.?limit|"
    r"too many requests|internal server|connection|502|503|504",
    re.I,
)


def model_id(value, custom=""):
    """Returns the AIR id from a dropdown value, or the custom id when one is filled in."""
    custom = (custom or "").strip()
    if custom:
        if not AIR_RE.match(custom):
            raise RunwareError(f"'{custom}' doesn't look like a Runware model id (it should look like creator:family@version).")
        return custom
    return str(value).split("—")[-1].strip()


class RunwareError(Exception):
    def __init__(self, message, status=0, code="", parameter=""):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code or ""
        self.parameter = parameter or ""

    @property
    def text(self):
        return f"{self.message} {self.code} {self.parameter}"

    @property
    def model_rejected(self):
        return bool(MODEL_REJECTED.search(self.text)) or (self.parameter == "model" and 400 <= self.status < 500)

    @property
    def transient(self):
        return self.status >= 500 or self.status == 429 or bool(TRANSIENT.search(self.text))

    @property
    def auth(self):
        return self.status in (401, 403) or bool(re.search(r"api ?key|authenticat|unauthori", self.text, re.I))


def clean(msg):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", str(msg or ""))).strip()[:400]


def resolve_key(value=""):
    """Key order: the node's text box, then the RUNWARE_API_KEY environment variable,
    then runware_api_key.txt inside this node folder."""
    key = (value or "").strip()
    if not key:
        key = os.environ.get("RUNWARE_API_KEY", "").strip()
    if not key and os.path.isfile(KEY_FILE):
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
    if not key:
        raise RunwareError(
            "No Runware API key. Paste it into the 'Runware API Key' node, or save it in "
            f"{KEY_FILE}, or set the RUNWARE_API_KEY environment variable."
        )
    return key


class RunwareClient:
    bad_models = set()  # model ids Runware refused, remembered for the whole ComfyUI session

    def __init__(self, api_key, log=print):
        self.api_key = api_key
        self.log = log
        self.lock = threading.Lock()
        self.cost = {"text": 0.0, "images": 0.0}

    # ---------- transport ----------
    def _post(self, tasks, timeout=180):
        body = json.dumps([{"taskType": "authentication", "apiKey": self.api_key}] + list(tasks)).encode("utf-8")
        req = urllib.request.Request(
            API_URL, data=body, method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "ComfyUI-Runware-ScriptDirector/1.0"},
        )
        status = 200
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
                status = res.status
        except urllib.error.HTTPError as e:
            status = e.code
            raw = e.read() or b""
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RunwareError(f"Couldn't reach Runware ({clean(getattr(e, 'reason', e))}). Check the internet connection.", status=503)
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            raise RunwareError(f"Runware answered with HTTP {status}: {clean(raw[:300])}", status=status or 502)
        errors = data.get("errors") or ([data["error"]] if isinstance(data.get("error"), dict) else [])
        if errors:
            e = errors[0] if isinstance(errors[0], dict) else {"message": str(errors[0])}
            raise RunwareError(clean(e.get("message") or "Runware returned an error"), status=status if status >= 400 else 400,
                               code=str(e.get("code") or ""), parameter=str(e.get("parameter") or ""))
        if status >= 400:
            raise RunwareError(f"Runware answered with HTTP {status}", status=status)
        items = [d for d in (data.get("data") or []) if isinstance(d, dict) and d.get("taskType") != "authentication" and "connectionSessionUUID" not in d]
        return items

    def _retry(self, fn, what, attempts=3):
        delay = 2.0
        for n in range(attempts):
            try:
                return fn()
            except RunwareError as e:
                if e.auth:
                    raise RunwareError("Runware rejected the API key: " + e.message, status=401)
                if not e.transient or n == attempts - 1:
                    raise
                self.log(f"{what}: {e.message} (retrying in {delay:.0f}s)")
                time.sleep(delay)
                delay *= 2.5

    def verify(self):
        """Authentication-only request: free, generates nothing."""
        self._retry(lambda: self._post([], timeout=30), "Key check")

    # ---------- text / vision ----------
    def text(self, prompt, model, fallbacks=(), max_tokens=4000, temperature=0.4, images=None):
        """Runs one textInference. If Runware rejects the model id, the fallbacks are tried in order.
        Returns (text, model_used)."""
        order = [m for m in [model, *fallbacks] if m]
        order = list(dict.fromkeys(order))
        last = None
        for m in order:
            if m in self.bad_models and m != order[-1]:
                continue
            task = {
                "taskType": "textInference", "taskUUID": str(uuid.uuid4()), "model": m,
                "deliveryMethod": "sync", "includeCost": True,
                "messages": [{"role": "user", "content": prompt}],
                "settings": {"maxTokens": int(max_tokens), "temperature": float(temperature)},
            }
            if images:
                task["inputs"] = {"images": list(images)}
            try:
                items = self._retry(lambda: self._post([task], timeout=300), f"Text ({m})")
            except RunwareError as e:
                last = e
                if e.model_rejected:
                    if m not in self.bad_models:
                        self.log(f"Runware doesn't accept text model {m} on this account ({e.message}). Trying the next one.")
                    self.bad_models.add(m)
                    continue
                raise
            hit = next((d for d in items if d.get("taskType") == "textInference" or "text" in d), None)
            if not hit or not str(hit.get("text") or "").strip():
                raise RunwareError(f"{m} returned an empty answer")
            self._add("text", hit.get("cost"))
            return str(hit["text"]), m
        raise last or RunwareError("No text model worked")

    # ---------- images ----------
    def image(self, prompt, model, width, height, seed=None, extra=None, timeout=300):
        task = {
            "taskType": "imageInference", "taskUUID": str(uuid.uuid4()), "model": model,
            "positivePrompt": prompt, "width": int(width), "height": int(height), "numberResults": 1,
            "outputType": "base64Data", "outputFormat": "JPG", "includeCost": True,
        }
        if seed is not None:
            task["seed"] = int(seed)
        if extra:
            task.update(extra)
        items = self._retry(lambda: self._post([task], timeout=timeout), f"Image ({model})", attempts=3)
        hit = next((d for d in items if d.get("imageBase64Data") or d.get("imageURL")), None)
        if not hit:
            raise RunwareError("Runware returned no image")
        if hit.get("imageBase64Data"):
            data = base64.b64decode(hit["imageBase64Data"])
        else:
            with urllib.request.urlopen(hit["imageURL"], timeout=120) as r:
                data = r.read()
        self._add("images", hit.get("cost"))
        return {"bytes": data, "cost": hit.get("cost"), "uuid": hit.get("imageUUID")}

    def _add(self, kind, cost):
        if isinstance(cost, (int, float)):
            with self.lock:
                self.cost[kind] += float(cost)

    @property
    def total_cost(self):
        return self.cost["text"] + self.cost["images"]
