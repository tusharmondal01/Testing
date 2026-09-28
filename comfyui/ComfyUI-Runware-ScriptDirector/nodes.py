"""ComfyUI nodes: whole script -> 60-70 photorealistic images, using only a Runware API key.

  Runware API Key -> 1 Script → Scenes -> 2 Character Bible -> 3 Visual Director -> 4 Prompt Writer -> 5 Generate Images
"""
import base64
import copy
import csv
import io
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import torch
from PIL import Image, ImageOps

from . import director as D
from .runware_api import IMAGE_MODELS, TEXT_MODELS, RunwareClient, RunwareError, model_id, resolve_key

try:
    import folder_paths
except ImportError:  # outside ComfyUI (tests)
    folder_paths = None
try:
    import comfy.model_management as mm
    import comfy.utils as cu
except ImportError:
    mm = cu = None

CATEGORY = "Runware Script Director"
ASPECTS = list(D.FRAME_WORDS.keys())
TAG = "[Runware Script Director]"
TEXT_IDS = [model_id(m) for m in TEXT_MODELS]
IMAGE_IDS = [model_id(m) for m in IMAGE_MODELS]

# Sizes: FLUX.2 takes any multiple of 16 up to 2048 px, so it renders true 9:16. If a model refuses a size,
# the GPT Image standard sizes are used instead and the result is centre-cropped to the chosen frame.
SIZES = {
    "Full HD": {"9:16 vertical": (1088, 1920), "16:9 horizontal": (1920, 1088), "1:1 square": (1440, 1440), "4:5 portrait": (1536, 1920)},
    "Standard": {"9:16 vertical": (768, 1344), "16:9 horizontal": (1344, 768), "1:1 square": (1024, 1024), "4:5 portrait": (896, 1120)},
}
SAFE_SIZES = {"9:16 vertical": (1024, 1536), "16:9 horizontal": (1536, 1024), "1:1 square": (1024, 1024), "4:5 portrait": (1024, 1536)}
RATIO = {"9:16 vertical": 9 / 16, "16:9 horizontal": 16 / 9, "1:1 square": 1.0, "4:5 portrait": 4 / 5}
SIZE_ERR = re.compile(r"width|height|dimension|resolution|size|aspect|pixel", re.I)
REF_ERR = re.compile(r"reference|\binputs\b", re.I)


class Reporter:
    """Prints to the console, shows live text on the node, and keeps a log for the node's output box."""

    def __init__(self, unique_id=None):
        self.uid = unique_id
        self.lines = []
        self.lock = threading.Lock()
        try:
            from server import PromptServer
            self.server = PromptServer.instance
        except Exception:
            self.server = None

    def __call__(self, msg):
        msg = str(msg)
        print(f"{TAG} {msg}", flush=True)
        with self.lock:
            self.lines.append(msg)
        if self.server is not None and self.uid is not None:
            try:
                self.server.send_progress_text(msg, self.uid)
            except Exception:
                pass


def interrupted():
    return bool(mm and mm.processing_interrupted())


def check_interrupt():
    if mm:
        mm.throw_exception_if_processing_interrupted()


def text_ai(client, project, log):
    """Returns ai(prompt, max_tokens, temperature) -> text, using the project's text model with automatic fallbacks."""
    main = project["text_model"]
    fallbacks = [m for m in TEXT_IDS if m != main]

    def ai(prompt, max_tokens=4000, temperature=0.4):
        text, used = client.text(prompt, main, fallbacks=fallbacks, max_tokens=max_tokens, temperature=temperature)
        if used != project.get("text_model_used"):
            project["text_model_used"] = used
            if used != main:
                log(f"Using text model {used}")
        return text

    return ai


def money(v):
    return f"${v:.4f}" if 0 < v < 0.01 else f"${v:.3f}"


def need_project(project, *keys):
    if not isinstance(project, dict) or "scenes" not in project:
        raise RunwareError("Connect the 'project' output of the previous Script Director node.")
    for k in keys:
        if not project.get(k):
            raise RunwareError(f"The project has no {k} yet. Run the earlier Script Director nodes first.")


# =====================================================================
# Runware API Key
# =====================================================================
class RunwareSD_APIKey:
    DESCRIPTION = ("Your Runware API key. Leave the box empty to use runware_api_key.txt in this node's folder "
                   "or the RUNWARE_API_KEY environment variable (safer: the key is then not saved inside the workflow).")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"api_key": ("STRING", {"default": "", "multiline": False, "tooltip": "Paste your Runware API key, or leave empty to use runware_api_key.txt / RUNWARE_API_KEY."})}}

    RETURN_TYPES = ("RUNWARE_KEY",)
    RETURN_NAMES = ("runware_key",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, api_key):
        key = resolve_key(api_key)
        RunwareClient(key).verify()
        print(f"{TAG} Runware key accepted.")
        return ({"key": key},)


# =====================================================================
# 1. Script -> Scenes
# =====================================================================
class RunwareSD_ScriptToScenes:
    DESCRIPTION = ("Step 1. Reads the whole script and splits it where a new meaningful visual idea starts "
                   "(one visual idea = one image), aiming softly for the min-max image range.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "runware_key": ("RUNWARE_KEY",),
                "script": ("STRING", {"multiline": True, "default": "", "placeholder": "Paste the whole script here (Hindi, Hinglish or English)"}),
                "video_title": ("STRING", {"default": "", "tooltip": "Helps the AI understand the topic."}),
                "aspect_ratio": (ASPECTS, {"default": "9:16 vertical"}),
                "min_images": ("INT", {"default": 60, "min": 1, "max": 300}),
                "max_images": ("INT", {"default": 70, "min": 1, "max": 300}),
                "split_mode": (["Smart split by scene (AI)", "Split at full stops (free)"],),
                "text_model": (TEXT_MODELS, {"default": TEXT_MODELS[0], "tooltip": "Used for splitting, casting, planning, prompt writing and the photo check. If Runware refuses it, the next Claude model is used automatically."}),
            },
            "optional": {
                "custom_text_model": ("STRING", {"default": "", "tooltip": "Optional: any Runware text model id (creator:family@version). Overrides the dropdown."}),
                "creator_notes": ("STRING", {"multiline": True, "default": "", "placeholder": "Optional direction for every image, e.g. 'Mumbai office startup, mostly women in their 20s'"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("SD_PROJECT", "INT", "STRING")
    RETURN_NAMES = ("project", "scene_count", "scenes_text")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, runware_key, script, video_title, aspect_ratio, min_images, max_images, split_mode, text_model,
            custom_text_model="", creator_notes="", unique_id=None):
        log = Reporter(unique_id)
        script = (script or "").strip()
        if not script:
            raise RunwareError("Paste the script into the 'script' box first.")
        lo, hi = min(min_images, max_images), max(min_images, max_images)
        project = {
            "version": 1, "api_key": runware_key["key"], "title": (video_title or "").strip(), "script": script,
            "notes": (creator_notes or "").strip(), "aspect": aspect_ratio,
            "text_model": model_id(text_model, custom_text_model), "cost": {},
        }
        client = RunwareClient(project["api_key"], log)
        note = ""
        if split_mode.startswith("Smart"):
            try:
                segs = D.smart_split(text_ai(client, project, log), script, project["title"], lo, hi, log)
            except RunwareError as e:
                if e.auth:
                    raise
                segs, note = D.split_sentences(script), f" Smart split didn't work ({e.message}); split at full stops instead."
            except ValueError as e:
                segs, note = D.split_sentences(script), f" Smart split didn't work ({e}); split at full stops instead."
        else:
            segs = D.split_sentences(script)
        found = len(segs)
        segs = D.fit_count(segs, lo, hi)
        project["scenes"] = segs
        project["cost"]["split"] = client.total_cost
        msg = f"{len(segs)} scenes"
        if found != len(segs):
            msg += f" (the split found {found}; adjusted to the {lo}-{hi} range)"
        if len(segs) < lo:
            msg += f". The script only has enough words for {len(segs)} images"
        log(msg + (f", cost {money(client.total_cost)}" if client.total_cost else "") + "." + note)
        text = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(segs))
        return {"ui": {"text": [log.lines[-1] + "\n\n" + text]}, "result": (project, len(segs), text)}


# =====================================================================
# 2. Character & style bible
# =====================================================================
class RunwareSD_CharacterBible:
    DESCRIPTION = ("Step 2. The AI reads the whole script and casts 1-5 recurring characters with fixed looks, so the "
                   "same people appear in every image. To edit it, copy the text it shows into 'bible_override'.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"project": ("SD_PROJECT",)},
            "optional": {"bible_override": ("STRING", {"multiline": True, "default": "", "placeholder": "Optional. Leave empty to let the AI cast. Format, one per line:\ntopic: ...\nsetting: ...\nemployee_01: Indian man, about 28, short black hair, wearing a light blue cotton shirt"})},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("SD_PROJECT", "STRING")
    RETURN_NAMES = ("project", "bible_text")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, project, bible_override="", unique_id=None):
        need_project(project, "scenes")
        log = Reporter(unique_id)
        p = copy.deepcopy(project)
        client = RunwareClient(p["api_key"], log)
        if (bible_override or "").strip():
            p["bible"] = D.parse_bible_text(bible_override)
            log(f"Using your character bible ({len(p['bible']['characters'])} characters).")
        else:
            log("Reading the whole script and casting the characters…")
            try:
                reply = text_ai(client, p, log)(D.casting_prompt(p["script"][:12000], p["title"], p["notes"]), max_tokens=2000, temperature=0.3)
                p["bible"] = D.bible_from_json(D.parse_json_loose(reply))
                log(f"Cast {len(p['bible']['characters'])} recurring characters.")
            except (ValueError, RunwareError) as e:
                if isinstance(e, RunwareError) and e.auth:
                    raise
                p["bible"] = {"topic": "", "audience": "", "setting": "", "characters": {}}
                log(f"Casting didn't work ({e}); continuing without a character bible.")
        p["cost"]["casting"] = client.total_cost
        text = D.bible_text(p["bible"])
        return {"ui": {"text": [text or "(empty bible)"]}, "result": (p, text)}


# =====================================================================
# 3. Visual Director: structured scene plan
# =====================================================================
class RunwareSD_VisualPlan:
    DESCRIPTION = ("Step 3. The Visual Director plans every scene as structured data: concept, subject, action, place, "
                   "emotion, shot, camera and composition, with shot variety and continuity across the video.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project": ("SD_PROJECT",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF, "control_after_generate": True, "tooltip": "Change it to get a fresh plan."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("SD_PROJECT", "STRING")
    RETURN_NAMES = ("project", "plan_text")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, project, seed, unique_id=None):
        need_project(project, "scenes")
        log = Reporter(unique_id)
        p = copy.deepcopy(project)
        p.setdefault("bible", {"topic": "", "audience": "", "setting": "", "characters": {}})
        client = RunwareClient(p["api_key"], log)
        p["plan"] = D.plan_scenes(text_ai(client, p, log), p, log, cancelled=interrupted)
        check_interrupt()
        p["cost"]["plan"] = client.total_cost
        missing = sum(1 for x in p["plan"] if not x)
        log(f"Planned {len(p['plan']) - missing} of {len(p['plan'])} scenes" + (f"; {missing} will be written directly" if missing else "") + f", cost {money(client.total_cost)}.")
        text = D.plan_text(p)
        return {"ui": {"text": [log.lines[-1] + "\n\n" + text]}, "result": (p, text)}


# =====================================================================
# 4. Prompt writer
# =====================================================================
class RunwareSD_PromptWriter:
    DESCRIPTION = ("Step 4. Turns each planned scene into a detailed photorealistic prompt and appends the permanent "
                   "style and 'avoid' layers. Tip: bypass step 5 (Ctrl+B) and run once to review the prompts before paying for images.")
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project": ("SD_PROJECT",),
                "prompt_detail": (list(D.PROMPT_DETAIL.keys()), {"default": "Maximum (160-210 words)"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF, "control_after_generate": True, "tooltip": "Change it to rewrite the prompts."}),
            },
            "optional": {
                "prompt_overrides": ("STRING", {"multiline": True, "default": "", "placeholder": "Optional. Replace any prompt, one per line:\n12: Create a photorealistic cinematic image of ..."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("SD_PROJECT", "STRING")
    RETURN_NAMES = ("project", "prompts_text")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, project, prompt_detail, seed, prompt_overrides="", unique_id=None):
        need_project(project, "scenes")
        log = Reporter(unique_id)
        p = copy.deepcopy(project)
        p.setdefault("bible", {"topic": "", "audience": "", "setting": "", "characters": {}})
        p.setdefault("plan", [None] * len(p["scenes"]))
        client = RunwareClient(p["api_key"], log)
        prompts, templated = D.write_prompts(text_ai(client, p, log), p, prompt_detail, log, cancelled=interrupted)
        check_interrupt()
        prompts, changed = D.apply_overrides(prompts, prompt_overrides)
        p["prompts"] = prompts
        p["cost"]["prompts"] = client.total_cost
        spent = sum(v for v in p["cost"].values() if isinstance(v, (int, float)))
        log(f"{len(prompts)} prompts ready (text cost so far {money(spent)}, model {p.get('text_model_used') or p['text_model']})."
            + (f" {templated} came from a template; review them." if templated else "")
            + (f" Your overrides replaced: {', '.join(map(str, changed))}." if changed else ""))
        text = "\n\n".join(f"{i + 1}. [{p['scenes'][i]}]\n{x}" for i, x in enumerate(prompts))
        return {"ui": {"text": [log.lines[-1] + "\n\n" + text]}, "result": (p, text)}


# =====================================================================
# 5. Generate images (+ photo check and regeneration)
# =====================================================================
def _shrink_data_uri(img, edge=640, q=80):
    im = img.copy()
    im.thumbnail((edge, edge))
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "JPEG", quality=q)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _crop_to_ratio(img, ratio):
    w, h = img.size
    if abs(w / h - ratio) < 0.01:
        return img, False
    if w / h > ratio:
        nw = int(round(h * ratio))
        box = ((w - nw) // 2, 0, (w - nw) // 2 + nw, h)
    else:
        nh = int(round(w / ratio))
        box = (0, (h - nh) // 2, w, (h - nh) // 2 + nh)
    return img.crop(box), True


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def _safe_subfolder(name):
    parts = [re.sub(r"[^\w\- ]", "_", x).strip() for x in re.split(r"[\\/]+", name or "")]
    parts = [x for x in parts if x and x not in (".", "..")]
    return os.path.join(*parts) if parts else "script_director"


class RunwareSD_GenerateImages:
    DESCRIPTION = ("Step 5. Generates one image per scene on Runware, checks each image with the AI photo editor "
                   "(realism, subject, action, place, text, faces and hands) and regenerates failures with a corrected prompt. "
                   "Images are saved as scene_001.jpg ... in ComfyUI's output folder with a manifest (CSV + JSON).")
    OUTPUT_NODE = True
    size_cache = {}
    ref_mode = {}
    no_seed = set()
    lock = threading.Lock()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project": ("SD_PROJECT",),
                "image_model": (IMAGE_MODELS, {"default": IMAGE_MODELS[0]}),
                "resolution": (["Full HD", "Standard"], {"default": "Full HD", "tooltip": "Full HD = 1088×1920 for 9:16. Standard is faster and cheaper."}),
                "parallel_requests": ("INT", {"default": 4, "min": 1, "max": 10}),
                "quality_check": ("BOOLEAN", {"default": True, "tooltip": "The text model looks at every image and regenerates failures."}),
                "pass_score": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 10.0, "step": 0.5}),
                "max_retries": ("INT", {"default": 1, "min": 0, "max": 3, "tooltip": "Regenerations per failed image. The best attempt is kept."}),
                "character_references": ("BOOLEAN", {"default": False, "tooltip": "Generate one reference portrait per recurring character and pass it with every scene they appear in, for stronger face consistency."}),
                "output_folder": ("STRING", {"default": "script_director/my_video", "tooltip": "Inside ComfyUI's output folder. Use one folder per video."}),
                "skip_existing": ("BOOLEAN", {"default": True, "tooltip": "Reuse images already in the folder when their prompt hasn't changed (resume after a stop, no double charges)."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF, "control_after_generate": True}),
            },
            "optional": {
                "only_scenes": ("STRING", {"default": "", "placeholder": "Optional, e.g. 3, 7, 12-15 to redo only these"}),
                "custom_image_model": ("STRING", {"default": "", "tooltip": "Optional: any Runware image model id. Overrides the dropdown."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "report")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    # ---------- image call with size / reference / model fallbacks ----------
    def _gen(self, client, st, prompt, refs, seed, log):
        model = st["model"]
        key = (model, st["aspect"], st["res"])
        with self.lock:
            size = self.size_cache.get(key, SIZES[st["res"]][st["aspect"]])
            mode = self.ref_mode.get(model, "inputs") if refs else None
        extra = None
        if refs and mode == "inputs":
            extra = {"inputs": {"referenceImages": refs}}
        elif refs and mode == "top":
            extra = {"referenceImages": refs}
        use_seed = seed if model.startswith("bfl:") and model not in self.no_seed else None
        try:
            return client.image(prompt, model, size[0], size[1], seed=use_seed, extra=extra)
        except RunwareError as e:
            if e.auth:
                raise
            if use_seed is not None and "seed" in e.text.lower() and not e.model_rejected:
                with self.lock:
                    self.no_seed.add(model)
                return self._gen(client, st, prompt, refs, seed, log)
            if refs and mode in ("inputs", "top") and REF_ERR.search(e.text) and not e.model_rejected:
                nxt = "top" if mode == "inputs" else "off"
                with self.lock:
                    self.ref_mode[model] = nxt
                log(f"{model} didn't accept reference images that way ({e.message}); " + ("trying another format." if nxt == "top" else "continuing without them."))
                return self._gen(client, st, prompt, refs if nxt != "off" else None, seed, log)
            safe = SAFE_SIZES[st["aspect"]]
            if SIZE_ERR.search(e.text) and tuple(size) != safe:
                with self.lock:
                    self.size_cache[key] = safe
                log(f"{model} refused {size[0]}×{size[1]} ({e.message}); using {safe[0]}×{safe[1]} and cropping to {st['aspect']}.")
                return self._gen(client, st, prompt, refs, seed, log)
            if e.model_rejected:
                nxt = next((m for m in IMAGE_IDS if m != model and m not in st["rejected"]), None)
                st["rejected"].add(model)
                if nxt:
                    log(f"Runware doesn't accept image model {model} on this account ({e.message}); switching to {nxt}.")
                    st["model"] = nxt
                    return self._gen(client, st, prompt, refs, seed, log)
            raise

    def _decode(self, st, raw):
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
        img, _ = _crop_to_ratio(img, RATIO[st["aspect"]])
        return img

    def _check(self, client, p, i, img, prompt, log, st):
        if not st["qc"]:
            return None
        try:
            txt, _ = client.text(D.qc_prompt(p["scenes"][i], (p.get("plan") or [None] * len(p["scenes"]))[i], prompt),
                                 p.get("text_model_used") or p["text_model"], fallbacks=[m for m in TEXT_IDS],
                                 max_tokens=600, temperature=0, images=[_shrink_data_uri(img)])
            return D.parse_json_loose(txt)
        except RunwareError as e:
            if e.auth:
                raise
            if not e.transient:
                with self.lock:
                    if st["qc"]:
                        st["qc"] = False
                        log(f"Photo check isn't available on this account ({e.message}). Images continue without checks.")
            return None
        except ValueError:
            return None

    def _one(self, client, p, i, st, refs, seed, log):
        prompt = p["prompts"][i]
        chars = [c for c in ((p.get("plan") or [None] * len(p["scenes"]))[i] or {}).get("character_ids") or [] if c in refs][:3]
        ref_list = [refs[c]["uri"] for c in chars]
        if chars:
            prompt = D.finish_prompt(" ".join(
                f"Reference image {k + 1} shows {c}: keep exactly the same face, hair, skin tone and build." for k, c in enumerate(chars))
                + " Use the references only for the person's identity, not for pose, framing, background or lighting. "
                + D.strip_tail(prompt))
        best, attempt_prompt, cost = None, prompt, 0.0
        for attempt in range(st["retries"] + 1):
            if st["cancel"].is_set():
                break
            res = self._gen(client, st, attempt_prompt, ref_list or None, (seed + i * 7919 + attempt * 104729) % 0xFFFFFFFF, log)
            cost += res["cost"] or 0.0
            img = self._decode(st, res["bytes"])
            r = self._check(client, p, i, img, attempt_prompt, log, st)
            if r is None:
                return {"img": img, "score": None, "pass": None, "issues": [], "tries": attempt + 1, "cost": cost, "prompt": attempt_prompt}
            ok, score = D.qc_verdict(r, st["pass_score"])
            cand = {"img": img, "score": score, "pass": ok, "issues": [str(x) for x in (r.get("issues") or [])][:4], "tries": attempt + 1, "cost": cost, "prompt": attempt_prompt}
            if best is None or score > best["score"]:
                best = cand
            best["tries"], best["cost"] = attempt + 1, cost
            if ok:
                break
            if attempt < st["retries"]:
                log(f"Scene {i + 1}: photo check {score:g}/10 ({'; '.join(cand['issues'][:2]) or 'low score'}), regenerating…")
                attempt_prompt = D.qc_fix(prompt, r)
        return best

    def _cast_refs(self, client, p, st, folder, log):
        chars = (p.get("bible") or {}).get("characters") or {}
        used = {c for sc in (p.get("plan") or []) if sc for c in (sc.get("character_ids") or [])}
        refs = {}
        for cid, desc in chars.items():
            if cid not in used or st["cancel"].is_set():
                continue
            path = os.path.join(folder, f"cast_{cid}.jpg")
            prompt = D.finish_prompt(
                f"Create a photorealistic head-and-shoulders portrait photograph of {desc}. Facing the camera at eye level with a calm, natural expression, "
                "plain softly lit light grey studio background, soft window light from the left, 85mm lens, sharp focus on the eyes. "
                "The image must look like a real photograph captured with a professional camera")
            meta = path + ".json"
            try:
                if os.path.isfile(path) and (read_json(meta) or {}).get("prompt") == prompt:
                    img = Image.open(path).convert("RGB")
                else:
                    sub = dict(st, aspect="1:1 square", res="Standard")
                    res = self._gen(client, sub, prompt, None, 12345, log)
                    img = self._decode(sub, res["bytes"])
                    img.save(path, "JPEG", quality=95)
                    write_json(meta, {"prompt": prompt})
                refs[cid] = {"uri": _shrink_data_uri(img, 1024, 92), "file": os.path.basename(path)}
                log(f"Reference portrait ready for {cid}.")
            except RunwareError as e:
                if e.auth:
                    raise
                log(f"Couldn't make a reference portrait for {cid} ({e.message}).")
        return refs

    def run(self, project, image_model, resolution, parallel_requests, quality_check, pass_score, max_retries,
            character_references, output_folder, skip_existing, seed, only_scenes="", custom_image_model="", unique_id=None):
        need_project(project, "scenes", "prompts")
        log = Reporter(unique_id)
        p = project
        n = len(p["prompts"])
        base = folder_paths.get_output_directory() if folder_paths else os.path.abspath("output")
        sub = _safe_subfolder(output_folder)
        folder = os.path.join(base, sub)
        os.makedirs(folder, exist_ok=True)
        manifest_path = os.path.join(folder, "manifest.json")
        try:
            old = {e["n"]: e for e in (read_json(manifest_path) or {}).get("scenes", [])}
        except (KeyError, TypeError, AttributeError):
            old = {}

        client = RunwareClient(p["api_key"], log)
        st = {"model": model_id(image_model, custom_image_model), "aspect": p["aspect"], "res": resolution, "qc": bool(quality_check),
              "pass_score": float(pass_score), "retries": int(max_retries) if quality_check else 0, "cancel": threading.Event(), "rejected": set()}
        only = D.parse_indices(only_scenes, n)
        todo, results = [], [None] * n
        for i in range(n):
            f = os.path.join(folder, f"scene_{i + 1:03d}.jpg")
            prev = old.get(i + 1)
            same = bool(prev and prev.get("file") and prev.get("prompt") == p["prompts"][i])
            reuse = os.path.isfile(f) and i not in only and (bool(only) or (skip_existing and same))
            if reuse:
                results[i] = {"img": Image.open(f).convert("RGB"), "reused": True, **{k: prev.get(k) for k in ("score", "pass", "issues", "tries", "model")}} if prev else {"img": Image.open(f).convert("RGB"), "reused": True}
            elif not only or i in only:
                todo.append(i)
        log(f"{len(todo)} image(s) to generate with {st['model']}" + (f", {n - len(todo)} reused from {sub}" if n - len(todo) else "") + ".")

        refs = self._cast_refs(client, p, st, folder, log) if character_references and todo else {}
        pbar = cu.ProgressBar(max(1, len(todo)), node_id=unique_id) if cu else None
        errors = {}
        done = 0
        ex = ThreadPoolExecutor(max_workers=max(1, int(parallel_requests)))
        futs = {ex.submit(self._one, client, p, i, st, refs, int(seed), log): i for i in todo}
        try:
            for fut in as_completed(futs):
                i = futs[fut]
                try:
                    r = fut.result()
                    if r:
                        r["model"] = st["model"]
                        r["img"].save(os.path.join(folder, f"scene_{i + 1:03d}.jpg"), "JPEG", quality=95)
                        results[i] = r
                except RunwareError as e:
                    if e.auth:
                        raise
                    errors[i] = e.message
                    log(f"Scene {i + 1} failed: {e.message}")
                except Exception as e:  # keep the rest of the batch going
                    errors[i] = str(e)
                    log(f"Scene {i + 1} failed: {e}")
                done += 1
                if pbar:
                    pbar.update_absolute(done)
                if done % 5 == 0 or done == len(todo):
                    log(f"Images: {done} of {len(todo)} done, {money(client.total_cost)} spent.")
                if interrupted():
                    st["cancel"].set()
                    check_interrupt()
        finally:
            st["cancel"].set()
            ex.shutdown(wait=True, cancel_futures=True)

        # ---------- files for editing: manifest.json, scenes.csv, project.json ----------
        rows = []
        for i in range(n):
            r = results[i] or {}
            f = f"scene_{i + 1:03d}.jpg"
            prev = old.get(i + 1) or {}
            # A reused image keeps the prompt it was made with, so a later run knows whether it is stale.
            prompt = (prev.get("prompt") or "") if r.get("reused") else p["prompts"][i]
            rows.append({"n": i + 1, "file": f if os.path.isfile(os.path.join(folder, f)) and results[i] else "", "narration": p["scenes"][i],
                         "prompt": prompt, "score": r.get("score"), "pass": r.get("pass"), "issues": r.get("issues") or [],
                         "tries": r.get("tries"), "model": r.get("model") or (old.get(i + 1) or {}).get("model"), "error": errors.get(i, "")})
        img_cost = client.cost["images"]
        text_cost = sum(v for v in (p.get("cost") or {}).values() if isinstance(v, (int, float))) + client.cost["text"]
        write_json(manifest_path, {"title": p.get("title"), "aspect": p["aspect"], "image_model": st["model"], "text_model": p.get("text_model_used") or p["text_model"],
                   "created": time.strftime("%Y-%m-%d %H:%M:%S"), "cost": {"images_this_run": img_cost, "text_total": text_cost},
                   "characters": {k: v["file"] for k, v in refs.items()}, "scenes": rows})
        with open(os.path.join(folder, "scenes.csv"), "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["scene", "file", "narration", "photo_check_score", "passed", "issues", "prompt"])
            for r in rows:
                w.writerow([r["n"], r["file"], r["narration"], "" if r["score"] is None else r["score"], "" if r["pass"] is None else r["pass"], "; ".join(r["issues"]), r["prompt"]])
        safe = {k: v for k, v in p.items() if k != "api_key"}
        write_json(os.path.join(folder, "project.json"), safe)

        # ---------- outputs ----------
        got = [r for r in results if r]
        if not got:
            raise RunwareError("No images were generated. " + (next(iter(errors.values()), "") if errors else "Check only_scenes."))
        tw, th = got[0]["img"].size
        batch = []
        for r in results:
            im = r["img"] if r else Image.new("RGB", (tw, th), (24, 24, 24))
            if im.size != (tw, th):
                im = ImageOps.fit(im, (tw, th), Image.LANCZOS)
            batch.append(np.asarray(im, dtype=np.float32) / 255.0)
        tensor = torch.from_numpy(np.stack(batch))

        checked = [r for r in got if r.get("score") is not None and not r.get("reused")]
        passed = sum(1 for r in checked if r.get("pass"))
        redone = sum(1 for r in checked if (r.get("tries") or 1) > 1)
        report = (f"{len(got)} of {n} images in output/{sub.replace(os.sep, '/')} ({tw}×{th}). "
                  f"Images this run {money(img_cost)}, text/checks {money(text_cost)}. "
                  + (f"Photo check: {passed} of {len(checked)} passed, {redone} regenerated. " if checked else "")
                  + (f"Failed: {', '.join(str(i + 1) for i in sorted(errors))} (put them in only_scenes to retry). " if errors else "")
                  + "Files: scene_###.jpg, scenes.csv, manifest.json, project.json.")
        log(report)
        low = [f"{r['n']}: {r['score']:g}/10 {'; '.join(r['issues'][:2])}" for r in rows if r["score"] is not None and not r["pass"]]
        detail = report + ("\n\nBelow the pass score (kept the best attempt):\n" + "\n".join(low) if low else "")
        ui_images = [{"filename": f"scene_{i + 1:03d}.jpg", "subfolder": sub.replace(os.sep, "/"), "type": "output"} for i in range(n) if results[i]]
        return {"ui": {"images": ui_images, "text": [detail]}, "result": (tensor, detail)}


NODE_CLASS_MAPPINGS = {
    "RunwareSD_APIKey": RunwareSD_APIKey,
    "RunwareSD_ScriptToScenes": RunwareSD_ScriptToScenes,
    "RunwareSD_CharacterBible": RunwareSD_CharacterBible,
    "RunwareSD_VisualPlan": RunwareSD_VisualPlan,
    "RunwareSD_PromptWriter": RunwareSD_PromptWriter,
    "RunwareSD_GenerateImages": RunwareSD_GenerateImages,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RunwareSD_APIKey": "Runware API Key",
    "RunwareSD_ScriptToScenes": "1 · Script → Scenes (Runware)",
    "RunwareSD_CharacterBible": "2 · Character & Style Bible (Runware)",
    "RunwareSD_VisualPlan": "3 · Visual Director Plan (Runware)",
    "RunwareSD_PromptWriter": "4 · Photoreal Prompt Writer (Runware)",
    "RunwareSD_GenerateImages": "5 · Generate Images + Photo Check (Runware)",
}
