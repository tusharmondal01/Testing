"""Visual Director pipeline, following the "Runware Bulk Image Generation" plan:

FULL SCRIPT -> scene segmentation -> casting (character & style bible) -> structured visual plan
-> detailed photorealistic prompts (+ permanent style layer) -> Runware images -> quality check -> regenerate.

Same prompts and rules as public/visuals/director.js on the Craftush website.
"""
import json
import re
from concurrent.futures import ThreadPoolExecutor

# Permanent style layer, so the text model never reinvents the look per image.
GLOBAL_STYLE = (
    "Photorealistic commercial photography of real human beings: natural skin texture, realistic facial anatomy, "
    "natural body proportions, authentic clothing, real-world environment, physically accurate lighting with natural "
    "shadows, cinematic but realistic, subtle depth of field, high-quality professional camera capture, modern Indian "
    "environment when appropriate. The image must look like a real photograph."
)
AVOID = (
    "No illustration, no cartoon, no anime, no comic style, no 3D render, no CGI, no plastic skin, no doll-like faces, "
    "no exaggerated expressions, no fantasy lighting, no surreal elements, no oversaturated colours, no fake-looking "
    "background, no readable text, no captions, no watermark, no logo."
)
SHOTS = ["wide shot", "medium shot", "close-up", "over-the-shoulder", "top-down", "side angle", "low angle",
         "environment shot", "object close-up", "screen + person", "group shot", "action shot"]
PROMPT_DETAIL = {
    "Rich (110-150 words)": "110 to 150",
    "Maximum (160-210 words)": "160 to 210",
    "Ultra (200-250 words)": "200 to 250",
}
FRAME_WORDS = {
    "9:16 vertical": "vertical 9:16 portrait frame",
    "16:9 horizontal": "horizontal 16:9 landscape frame",
    "1:1 square": "square 1:1 frame",
    "4:5 portrait": "4:5 portrait frame",
}
MAX_PROMPT_CHARS = 2900
PLAN_CHUNK = 12    # lines per visual-plan request (sequential, so continuity carries over)
PROMPT_BATCH = 3   # scenes per prompt-writing request (run in parallel)

WORD_RE = re.compile(r"[^\s\"'“”‘’.,!?;:()\[\]{}…|/\\—–।॥-]+")
SENTENCE_RE = re.compile(r"(?<=[.!?।॥])\s+|\n+")
JOINERS = {"and", "but", "which", "while", "because", "so", "then", "when", "aur", "lekin", "par", "kyunki",
           "toh", "to", "jab", "phir", "ya", "magar", "isliye", "jisse", "ki"}


def words(s):
    return WORD_RE.findall(s or "")


def parse_json_loose(text):
    t = re.sub(r"```(?:json)?", "", str(text or ""), flags=re.I).strip()
    a, o = t.find("["), t.find("{")
    start = a if a >= 0 and (o < 0 or a < o) else o
    end = t.rfind("]") if start == a else t.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("The AI answer wasn't in the expected JSON format")
    return json.loads(t[start:end + 1])


# =====================================================================
# 1. Scene segmentation
# =====================================================================
def split_sentences(text):
    parts = [p.strip() for p in SENTENCE_RE.split(text or "")]
    return [" ".join(p.split()) for p in parts if p and words(p)]


def _split_near_middle(seg):
    toks = seg.split()
    n = len(toks)
    if n < 6:
        return None
    cands = [p for p in range(2, n - 1) if re.search(r"[,;:—–-]$", toks[p - 1]) or toks[p].lower().strip(",") in JOINERS]
    if cands:
        p = min(cands, key=lambda p: abs(p - n / 2))
    elif n >= 8:
        p = n // 2
    else:
        return None
    return [" ".join(toks[:p]), " ".join(toks[p:])]


def fit_count(segs, lo, hi):
    """Soft target: merges the shortest neighbours when there are too many scenes,
    splits the longest scenes at a natural pause when there are too few."""
    segs = list(segs)
    while len(segs) > hi and len(segs) > 1:
        i = min(range(len(segs) - 1), key=lambda k: len(words(segs[k])) + len(words(segs[k + 1])))
        segs[i:i + 2] = [segs[i] + " " + segs[i + 1]]
    guard = 0
    while len(segs) < lo and guard < 500:
        guard += 1
        order = sorted(range(len(segs)), key=lambda k: -len(words(segs[k])))
        for i in order:
            parts = _split_near_middle(segs[i])
            if parts:
                segs[i:i + 1] = parts
                break
        else:
            break
    return segs


def script_chunks(text, max_words=1200):
    out, cur, n = [], [], 0
    for para in [p.strip() for p in re.split(r"\n+", text) if p.strip()]:
        pieces = split_sentences(para) if len(words(para)) > max_words else [para]
        for piece in pieces:
            w = len(words(piece))
            if cur and n + w > max_words:
                out.append("\n".join(cur))
                cur, n = [], 0
            cur.append(piece)
            n += w
    if cur:
        out.append("\n".join(cur))
    return out


def align_beats(text, beats):
    """Maps the AI's beats back onto the ORIGINAL script, so the exact words never change."""
    toks = [(m.group(0).lower(), m.start()) for m in WORD_RE.finditer(text)]
    bw = [x for x in ([w.lower() for w in words(b)] for b in beats) if x]
    if not toks or not bw:
        return None, 0.0
    starts, s, exact = [0], 0, 0
    for b in range(1, len(bw)):
        prev_len, first = len(bw[b - 1]), bw[b]
        lo = s + max(1, prev_len // 2)
        hi = min(len(toks) - 1, s + prev_len * 2 + 10)
        found = -1
        for need in (3, 2, 1):
            k = min(need, len(first))
            for j in range(lo, hi + 1):
                if all(j + q < len(toks) and toks[j + q][0] == first[q] for q in range(k)):
                    found = j
                    break
            if found >= 0:
                if need >= 2 or len(first) == 1:
                    exact += 1
                break
        if found < 0:
            found = min(len(toks) - 1, s + prev_len)
        if found <= s:
            continue
        starts.append(found)
        s = found
    segs = []
    for k, st in enumerate(starts):
        a = 0 if k == 0 else toks[st][1]
        b = toks[starts[k + 1]][1] if k + 1 < len(starts) else len(text)
        seg = " ".join(text[a:b].split())
        if seg:
            segs.append(seg)
    return segs, (exact / (len(bw) - 1) if len(bw) > 1 else 1.0)


def split_prompt(chunk, title, lo, hi, part, parts):
    return f"""You are a video editor preparing a voiceover script for a video that shows one image on screen at a time.
{f'{chr(10)}VIDEO TITLE: "{title}"{chr(10)}' if title else ''}
First read the video title and the WHOLE text and understand the topic, the story and how it flows from one situation to the next. Then split it into "visual beats". A beat is one meaningful visual idea: one complete moment that makes sense on its own and can be shown as ONE image.

Rules:
- One meaningful visual idea = one beat. Start a new beat where a new situation, place, person, time, action, feeling or idea begins.
- Split this text into between {lo} and {hi} beats. Treat that as a soft target: never cut an idea in half just to hit the number.
- Each beat is a complete phrase or thought. Never cut in the middle of an idea, a name, a number or words that belong together.
- If one sentence holds two or more different visual ideas, split it at the natural boundary (a comma, "and", "but", "which", "while" and so on).
- If short sentences next to each other describe the same image, join them into one beat.
- Copy the words EXACTLY as written, in the original language and order. Do not translate, rewrite, correct, add or remove anything. Every word must appear in exactly one beat.
{f'{chr(10)}This is part {part} of {parts} of a longer script.{chr(10)}' if parts > 1 else ''}
Return ONLY JSON in this form, with no commentary: {{"beats": ["first beat", "second beat"]}}

TEXT:
\"\"\"
{chunk}
\"\"\""""


def smart_split(ai, text, title, lo, hi, log):
    chunks = script_chunks(text)
    total = max(1, len(words(text)))
    beats = []
    for i, chunk in enumerate(chunks):
        share = len(words(chunk)) / total
        c_lo, c_hi = max(1, round(lo * share)), max(1, round(hi * share))
        log(f"Splitting the script by scene… part {i + 1} of {len(chunks)}")
        reply = ai(split_prompt(chunk, title, c_lo, c_hi, i + 1, len(chunks)), max_tokens=8000, temperature=0.2)
        data = parse_json_loose(reply)
        lst = data if isinstance(data, list) else data.get("beats") if isinstance(data, dict) else None
        if not lst:
            raise ValueError("The AI reply had no beats")
        beats += [x if isinstance(x, str) else (x.get("text") or x.get("beat") or "") for x in lst]
    segs, matched = align_beats(text, [b for b in beats if str(b).strip()])
    if not segs:
        raise ValueError("The AI split couldn't be matched to the script")
    if matched < 0.6:
        raise ValueError("The AI changed too many words while splitting")
    return segs


# =====================================================================
# 2. Casting: character & style bible
# =====================================================================
def casting_prompt(script, title, notes):
    return f"""You are the script analyst and casting director for a short video. Read the video title and the WHOLE script, then plan who and where the video shows.
{f'{chr(10)}VIDEO TITLE: "{title}"{chr(10)}' if title else ''}
SCRIPT (may be Hindi, Hinglish or English):
\"\"\"{script}\"\"\"
{notes_block(notes)}
Return ONLY JSON:
{{"topic": "the video's topic in one short English sentence",
 "audience": "who the video is for",
 "setting": "one line: country, city or town type, era, and the kinds of real places the video shows",
 "characters": [{{"character_id": "short_snake_case_id", "gender": "", "age": "", "appearance": "ethnicity, build, face, skin tone", "hair": "", "clothing": "specific garments with colours and fabric", "role": "their role in the story"}}]}}

Rules:
- 1 to 5 recurring characters the story really needs (the viewer, a user, an employee, a manager, a customer, a student...). Only people who appear in several scenes.
- Contemporary India, real Indian people and places, unless the title or script clearly says otherwise.
- Ordinary believable people, not models or celebrities. No real, named public figures.
- Clothing must be specific and stay the same across the video."""


def notes_block(notes):
    notes = (notes or "").strip()
    return f"\nEXTRA DIRECTION FROM THE CREATOR (follow it): {notes}\n" if notes else ""


def bible_from_json(j):
    chars = {}
    for c in j.get("characters") or []:
        if not isinstance(c, dict) or not c.get("character_id"):
            continue
        cid = re.sub(r"[^A-Za-z0-9_-]", "_", str(c["character_id"]))
        desc = ", ".join(x for x in [
            c.get("appearance"), c.get("gender"), c.get("age") and f"about {c['age']} years old",
            c.get("hair"), c.get("clothing") and f"wearing {c['clothing']}",
        ] if x)
        chars[cid] = desc + (f" ({c['role']})" if c.get("role") else "")
    return {"topic": j.get("topic") or "", "audience": j.get("audience") or "", "setting": j.get("setting") or "", "characters": chars}


def parse_bible_text(text):
    """Editable form, one entry per line:  topic: ...  /  setting: ...  /  employee_01: Indian man, 28, ..."""
    out = {"topic": "", "audience": "", "setting": "", "characters": {}}
    for line in (text or "").splitlines():
        m = re.match(r"^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$", line)
        if not m:
            continue
        k = m.group(1).lower()
        if k in ("topic", "setting", "audience"):
            out[k] = m.group(2).strip()
        else:
            out["characters"][m.group(1)] = m.group(2).strip()
    return out


def bible_text(b):
    lines = [f"{k}: {b[k]}" for k in ("topic", "audience", "setting") if b.get(k)]
    lines += [f"{k}: {v}" for k, v in (b.get("characters") or {}).items()]
    return "\n".join(lines)


# =====================================================================
# 3. Visual plan: one structured scene per line
# =====================================================================
def plan_prompt(p, lines, offset, prev):
    b = p["bible"]
    chars = "\n".join(f"- {k}: {v}" for k, v in b["characters"].items()) or "- none: describe people inside main_subject"
    prev_txt = ""
    if prev:
        prev_txt = "\nPREVIOUS SCENES (continue from these; do not repeat their shot type back to back):\n" + "\n".join(
            f"- line {x['n']}: {x.get('shot', '')}; {x.get('visual_concept', '')}; {x.get('environment', '')}" for x in prev) + "\n"
    numbered = "\n".join(f"{offset + k + 1}. {l}" for k, l in enumerate(lines))
    frame = FRAME_WORDS.get(p["aspect"], "vertical 9:16 portrait frame")
    return f"""You are the Visual Director of a video. The narration below is shown one photograph at a time. For every numbered line, plan ONE photorealistic scene as structured data.
{f'{chr(10)}VIDEO TITLE: "{p["title"]}"' if p.get("title") else ''}
TOPIC: {b.get('topic') or 'work it out from the script'}
SETTING: {b.get('setting') or 'contemporary India'}
CHARACTER BIBLE (use these ids whenever these people appear; do not invent new looks for them):
{chars}

FULL SCRIPT (context only):
\"\"\"{p['script'][:12000]}\"\"\"
{notes_block(p.get('notes'))}{prev_txt}
LINES TO PLAN:
{numbered}

HOW TO PLAN EACH LINE
1. Understand the line in its place in the story (read the lines before it). Ask: is it directly visual? Does it add a new visual idea? Does it continue the previous scene?
2. One meaningful visual idea = one image. Show the idea as a REAL moment a photographer could capture:
   - literal lines: show exactly that (a person, place, object or action);
   - analytical or conceptual lines (numbers, problems, reasons, advice): show a relatable real situation that demonstrates it, e.g. "50% users drop at step two" -> a young professional at an office desk pausing, mildly frustrated, at an unfinished signup form. Never symbols (lightbulbs, gears, brains, arrows, floating icons, charts in the air).
3. Continuity: if the line continues the previous situation, keep the same characters, place and time, set "same_scene_as_previous": true, and change the shot or angle. Use character ids from the bible for recurring people; describe one-off extras inside main_subject.
4. Shot variation driven by the narration, chosen from: {', '.join(SHOTS)}. Emotional beats suit close-ups, context and transitions suit wide or environment shots, actions suit action or over-the-shoulder shots, details suit object close-ups. Never the same shot type twice in a row, and do not let every scene be a person at a laptop: vary environments (office, home, street, café, meeting room, metro, campus, shop...), props and activities.
5. Screens, documents and signs are angled away or softly blurred. text_in_image is always false.

Return ONLY a JSON array with exactly {len(lines)} objects, in order, each shaped like:
{{"line": {offset + 1}, "scene_type": "user_experience | workplace | education | business | product | lifestyle | nature | ...", "visual_concept": "one sentence", "character_ids": ["employee_01"], "main_subject": "who or what, concrete", "action": "what is happening right now", "environment": "specific real place with 3 to 5 real details", "time_of_day": "", "lighting": "real light source and direction", "emotion": "", "shot": "one of the shot types", "camera": "lens, distance and angle, e.g. 35mm medium close-up at eye level", "composition": "where the subject sits in the {frame}", "key_props": ["..."], "same_scene_as_previous": false, "text_in_image": false}}"""


def plan_scenes(ai, p, log, cancelled=lambda: False):
    lines = p["scenes"]
    plan = [None] * len(lines)
    prev = []
    for start in range(0, len(lines), PLAN_CHUNK):
        if cancelled():
            break
        chunk = lines[start:start + PLAN_CHUNK]
        log(f"Planning scenes, shots and continuity… {start} of {len(lines)}")
        scenes = None
        for _attempt in range(2):
            try:
                arr = parse_json_loose(ai(plan_prompt(p, chunk, start, prev), max_tokens=min(12000, 600 + len(chunk) * 400), temperature=0.5))
                if isinstance(arr, list) and arr:
                    scenes = arr
                    break
            except ValueError as e:
                log(f"Visual plan answer couldn't be read ({e}); retrying")
        for k in range(len(chunk)):
            sc = None
            if scenes:
                sc = next((s for s in scenes if isinstance(s, dict) and str(s.get("line")) == str(start + k + 1)), None)
                if sc is None and k < len(scenes) and isinstance(scenes[k], dict):
                    sc = scenes[k]
            if isinstance(sc, dict):
                sc["text_in_image"] = False
                plan[start + k] = sc
        prev = [dict(n=start + k + 1, **plan[start + k]) for k in range(max(0, len(chunk) - 3), len(chunk)) if plan[start + k]]
    return plan


def plan_text(p):
    out = []
    for i, (line, sc) in enumerate(zip(p["scenes"], p["plan"])):
        if sc:
            chips = " · ".join(str(x) for x in [sc.get("shot"), sc.get("emotion"), sc.get("environment"), ", ".join(sc.get("character_ids") or [])] if x)
            out.append(f"{i + 1}. {line}\n   → {sc.get('visual_concept', '')}\n   [{chips}]")
        else:
            out.append(f"{i + 1}. {line}\n   → (not planned; will be written directly)")
    return "\n".join(out)


# =====================================================================
# 4. Prompt engineering: structured scene -> detailed photorealistic prompt
# =====================================================================
EXAMPLE = """EXAMPLE
Narration: "Agar signup ke baad pachaas percent log dusre step pe hi ruk jate hain, toh problem sirf conversion ki nahi hai."
Prompt: "Create a photorealistic cinematic image of a young Indian professional sitting at a modern office desk and attempting to complete a digital signup process on a computer. The person has reached an intermediate signup step and appears mildly confused and frustrated because the process is not progressing. Show a realistic modern Indian workplace environment with believable office furniture, natural human proportions, authentic skin texture, realistic clothing and subtle facial expression. Use professional commercial photography aesthetics, natural window light, realistic shadows, physically accurate lighting, 35mm camera lens, shallow but realistic depth of field. Medium close-up composition. Keep the subject on the right side of the frame and leave clean visual space on the left. The image must look like a real photograph captured with a professional camera.\""""


def engineer_prompt(p, batch, detail):
    b = p["bible"]
    lines = p["scenes"]
    frame = FRAME_WORDS.get(p["aspect"], "vertical 9:16 portrait frame")
    used = []
    for i in batch:
        sc = p["plan"][i] or {}
        for cid in sc.get("character_ids") or []:
            if cid not in used:
                used.append(cid)
    profiles = "\n".join(f"- {cid}: {b['characters'].get(cid, 'not in the bible, describe from the scene')}" for cid in used) or "- none"
    scenes = []
    for i in batch:
        sc = p["plan"][i]
        story = f'"{lines[i - 2] if i >= 2 else ""}" / "{lines[i - 1] if i >= 1 else "start of video"}"'
        scenes.append(f'{i + 1}. Narration: "{lines[i]}"\n   Story so far: {story}\n   Scene: {json.dumps(sc, ensure_ascii=False) if sc else "not planned: plan it yourself from the narration"}')
    return f"""You are a prompt engineer for a photorealistic image model. Convert each structured scene below into ONE detailed image prompt.
{f'{chr(10)}VIDEO TITLE: "{p["title"]}"' if p.get("title") else ''}
TOPIC: {b.get('topic', '')}
SETTING: {b.get('setting') or 'contemporary India'}
CHARACTER PROFILES (copy these descriptions word for word whenever the character appears):
{profiles}
{notes_block(p.get('notes'))}
WRITE EACH PROMPT AS ONE PARAGRAPH OF {PROMPT_DETAIL.get(detail, '160 to 210')} WORDS that:
- starts with "Create a photorealistic cinematic image of";
- describes the main subject concretely (use the character profile words exactly), what they are doing right now, and a subtle, believable facial expression for the emotion;
- describes the real environment with 3 to 5 believable details and the time of day;
- names the real light source and its direction, realistic shadows and physically accurate lighting;
- names the camera: the shot type, a real lens (e.g. 35mm or 50mm) and shallow but realistic depth of field;
- states the composition for a {frame} (where the subject sits, where the clean space is);
- adds realism cues: natural human proportions, authentic skin texture, realistic clothing, a real modern Indian place when appropriate;
- keeps any screen, paper or sign angled away or softly blurred so no words are visible;
- ends with "The image must look like a real photograph captured with a professional camera."
Do NOT add style lists or "no cartoon" lists; they are appended automatically. Never use the words hyper-realistic, 8k, render or masterpiece. Never name real public figures or brands.

{EXAMPLE}

SCENES
{chr(10).join(scenes)}

Return ONLY a JSON array of {len(batch)} strings, one prompt per scene, in the same order."""


def finish_prompt(p):
    tail = f" {GLOBAL_STYLE} {AVOID}"
    main = re.sub(r"[.\s]+$", "", str(p).strip())
    room = MAX_PROMPT_CHARS - len(tail) - 1
    if len(main) > room:
        main = main[:room].rsplit(" ", 1)[0]
    return f"{main}.{tail}"


def strip_tail(prompt):
    """The prompt without the permanent style and avoid layers (they are added back by finish_prompt)."""
    tail = f" {GLOBAL_STYLE} {AVOID}"
    return prompt[:-len(tail)] if prompt.endswith(tail) else prompt


def template_prompt(line, sc):
    """Last resort when the AI couldn't write a prompt for a scene."""
    if sc:
        return (f"Create a photorealistic cinematic image of {sc.get('main_subject', 'a person')} {sc.get('action', '')}, "
                f"in {sc.get('environment', 'a real modern Indian place')}, {sc.get('time_of_day', '')}. "
                f"{sc.get('emotion', '')} expression. {sc.get('lighting', 'Natural window light')}. {sc.get('camera', '35mm lens, eye level')}, "
                f"{sc.get('shot', 'medium shot')}. {sc.get('composition', '')}. The image must look like a real photograph captured with a professional camera.")
    return (f"Create a photorealistic cinematic image of a real, everyday moment in contemporary India that shows this narration: \"{line}\". "
            "Real people with natural expressions in a real place, natural light, 35mm lens, shallow but realistic depth of field. "
            "The image must look like a real photograph captured with a professional camera.")


def write_prompts(ai, p, detail, log, cancelled=lambda: False, workers=3):
    n = len(p["scenes"])
    prompts = [None] * n
    batches = [list(range(k, min(n, k + PROMPT_BATCH))) for k in range(0, n, PROMPT_BATCH)]
    done = [0]

    def run(batch):
        if cancelled():
            return
        for _attempt in range(2):
            try:
                arr = parse_json_loose(ai(engineer_prompt(p, batch, detail), max_tokens=900 + len(batch) * 900, temperature=0.6))
                if isinstance(arr, list):
                    for k, i in enumerate(batch):
                        if k < len(arr) and str(arr[k]).strip():
                            prompts[i] = str(arr[k]).strip()
                    break
            except ValueError as e:
                log(f"Prompt answer couldn't be read ({e}); retrying")
        done[0] += len(batch)
        log(f"Writing detailed photorealistic prompts… {min(done[0], n)} of {n}")

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(run, batches))
    templated = 0
    for i in range(n):
        if not prompts[i]:
            prompts[i] = template_prompt(p["scenes"][i], p["plan"][i])
            templated += 1
    return [finish_prompt(x) for x in prompts], templated


def apply_overrides(prompts, text):
    """Lines like '12: my own prompt' replace prompt 12."""
    out = list(prompts)
    changed = []
    for line in (text or "").splitlines():
        m = re.match(r"^\s*(\d+)\s*[:.)-]\s*(.+)$", line)
        if m and 1 <= int(m.group(1)) <= len(out):
            out[int(m.group(1)) - 1] = finish_prompt(m.group(2))
            changed.append(int(m.group(1)))
    return out, changed


def parse_indices(text, n):
    """'3, 7, 12-15' -> {2, 6, 11, 12, 13, 14} (0-based)."""
    out = set()
    for part in re.split(r"[,\s]+", text or ""):
        m = re.match(r"^(\d+)(?:-(\d+))?$", part.strip())
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(2) or m.group(1))
        for k in range(min(a, b), max(a, b) + 1):
            if 1 <= k <= n:
                out.add(k - 1)
    return out


# =====================================================================
# 5. Quality control: the text model looks at each generated image
# =====================================================================
def qc_prompt(line, sc, prompt):
    intended = json.dumps({k: sc.get(k) for k in ("visual_concept", "main_subject", "action", "environment", "shot", "composition")}, ensure_ascii=False) if sc else prompt[:900]
    return f"""You are a strict photo editor checking one generated image for a video. Look at the attached image and compare it with what was intended.

NARRATION: "{line}"
INTENDED SCENE: {intended}

Check: is it a believable real photograph (not cartoon, illustration, anime, 3D or CGI, no plastic skin)? Correct subject, action and environment? Any readable or garbled text, captions, logos or watermarks? Any distorted face, hands, fingers or body? Correct composition? Consistent professional photo style?

Return ONLY JSON: {{"photorealistic": true, "cartoon_or_cgi": false, "subject_ok": true, "action_ok": true, "environment_ok": true, "unwanted_text": false, "distortion": false, "composition_ok": true, "score": 0-10, "issues": ["short issue"], "fix": "one or two sentences to add to the prompt that would fix the issues"}}"""


def qc_verdict(r, min_score):
    try:
        score = float(r.get("score") or 0)
    except (TypeError, ValueError):
        score = 0.0
    ok = bool(r.get("photorealistic")) and not r.get("cartoon_or_cgi") and not r.get("unwanted_text") and not r.get("distortion") and score >= min_score
    return ok, score


def qc_fix(prompt, r):
    fix = " ".join(x for x in [
        r.get("fix") or "",
        "This must be an unedited real photograph of real people and places, with natural skin and real materials." if r.get("cartoon_or_cgi") or not r.get("photorealistic") else "",
        "Remove every letter and word: screens, papers and signs are angled away or blurred." if r.get("unwanted_text") else "",
        "Keep hands simple and relaxed with five natural fingers, and faces naturally proportioned." if r.get("distortion") else "",
    ] if x)
    tail = f" {GLOBAL_STYLE} {AVOID}"
    main = re.sub(r"[.\s]+$", "", strip_tail(prompt))
    extra = f". Corrections: {fix[:600]}"
    room = MAX_PROMPT_CHARS - len(tail) - len(extra) - 1
    if len(main) > room:
        main = main[:room].rsplit(" ", 1)[0]
    return finish_prompt(main + extra)
