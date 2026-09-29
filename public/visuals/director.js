/* ---------- VISUAL DIRECTOR PIPELINE ----------
   Loaded after the main page script and uses its helpers (relay, state, pool, setStatus, runware, ...).

   FULL SCRIPT (split by scene in step 1)
   → 1. Casting: topic, setting and a character bible (one profile per recurring person)
   → 2. Visual plan: one structured scene per line (concept, subject, action, environment, emotion,
        shot, camera, composition), with shot variation and continuity driven by the narration
   → 3. Prompt engineering: Claude fills the line-specific parts of one fixed prompt template
        (assemblePrompt) and near-duplicate prompts are rewritten
   → 4. Quality control after each image: Claude looks at the image; failures are regenerated
        with a corrected prompt.

   All steps use TEXT_MODEL (Claude Sonnet 5 on Runware); images use IMAGE_MODEL (GPT Image 2). */

const SHOTS = ['wide shot', 'medium shot', 'close-up', 'over-the-shoulder', 'top-down', 'side angle', 'low angle', 'environment shot', 'object close-up', 'screen + person', 'group shot', 'action shot'];
const PLAN_CHUNK = 12;   // lines per visual-plan request (sequential, so continuity carries over)
const PROMPT_BATCH = 3;  // scenes per prompt-writing request (parallel)

/* ---------- small helpers ---------- */
async function askClaude(content, { maxTokens = 4000, temperature = 0.4, images } = {}){
  const task = { taskType: 'textInference', taskUUID: uuid(), model: TEXT_MODEL, strictModel: true, includeCost: true,
    messages: [{ role: 'user', content }], settings: { maxTokens, temperature } };
  if (images && images.length) task.inputs = { images };
  const json = await relay([task]);
  if (json.errors && json.errors.length){ const e = new Error(cleanMsg(json.errors[0].message) || 'Runware returned an error'); e.runware = true; throw e; }
  const t = (json.data || []).find(d => d.taskType === 'textInference');
  if (t && typeof t.cost === 'number') state.cost.prompts += t.cost;
  if (!t || !t.text) throw new Error('Claude returned an empty answer');
  return t.text;
}
function parseJSONLoose(text){
  const t = String(text || '').replace(/```json|```/g, '').trim();
  const a = t.indexOf('['), o = t.indexOf('{');
  const start = a >= 0 && (o < 0 || a < o) ? a : o;
  const end = start === a ? t.lastIndexOf(']') : t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude’s answer wasn’t in the expected format');
  return JSON.parse(t.slice(start, end + 1));
}
const videoTitle = () => ($('#videoTitle').value || '').trim();
const scriptText = () => $('#script').value.trim().slice(0, 7000);
const creatorNotes = () => { const n = ($('#notes').value || '').trim(); return n ? `\nEXTRA DIRECTION FROM THE CREATOR (follow it): ${n}\n` : ''; };

/* ---------- 1. Character & style bible ----------
   Stored as editable lines in #bible:  "setting: ..."  and  "employee_01: Indian man, 28, ..." */
function parseBible(){
  const out = { setting: '', topic: '', chars: {} };
  ($('#bible').value || '').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/); if (!m) return;
    const k = m[1].toLowerCase();
    if (k === 'setting') out.setting = m[2].trim();
    else if (k === 'topic') out.topic = m[2].trim();
    else out.chars[m[1]] = m[2].trim();
  });
  return out;
}
const bibleText = b => [b.topic && 'topic: ' + b.topic, b.setting && 'setting: ' + b.setting, ...Object.entries(b.chars).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n');

async function buildBible(){
  const txt = await askClaude(`You are the script analyst and casting director for a short video. Read the video title and the WHOLE script, then plan who and where the video shows.
${videoTitle() ? `\nVIDEO TITLE: "${videoTitle()}"\n` : ''}
SCRIPT (may be Hindi, Hinglish or English):
"""${scriptText()}"""
${creatorNotes()}

Return ONLY JSON:
{"topic": "the video's topic in one short English sentence",
 "audience": "who the video is for",
 "setting": "one line: country, city or town type, era, and the kinds of real places the video shows",
 "characters": [{"character_id": "short_snake_case_id", "gender": "", "age": "", "appearance": "ethnicity, build, face, skin tone", "hair": "", "clothing": "specific garments with colours and fabric", "role": "their role in the story"}]}

Rules:
- 0 to 3 recurring characters. Cast someone ONLY if the script follows a specific person or clearly talks about the same person across several lines (a named person, "a student who...", a story). Scripts about facts, products, money, places, history, science, tips or processes usually need NO characters: return "characters": [] for them.
- Do not invent a "viewer", "user" or presenter character just to have a person in the video.
- Contemporary India, real Indian people and places, unless the title or script clearly says otherwise.
- Ordinary believable people, not models or celebrities. No real, named public figures.
- Clothing must be specific and stay the same across the video.`, { maxTokens: 1500, temperature: 0.3 });
  const j = parseJSONLoose(txt);
  const chars = {};
  (j.characters || []).forEach(c => {
    if (!c || !c.character_id) return;
    chars[String(c.character_id).replace(/[^A-Za-z0-9_-]/g, '_')] =
      [c.appearance, c.gender, c.age && `about ${c.age} years old`, c.hair, c.clothing && `wearing ${c.clothing}`].filter(Boolean).join(', ') + (c.role ? ` (${c.role})` : '');
  });
  $('#bible').value = bibleText({ topic: j.topic || '', setting: j.setting || '', chars });
}

/* ---------- 2. Visual plan: structured scene per line ---------- */
function planPrompt(lines, offset, prev){
  const b = parseBible();
  return `You are the Visual Director of a video. The narration below is shown one photograph at a time. For every numbered line, plan ONE photorealistic scene as structured data.
${videoTitle() ? `\nVIDEO TITLE: "${videoTitle()}"` : ''}
TOPIC: ${b.topic || 'work it out from the script'}
SETTING: ${b.setting || 'contemporary India'}
CHARACTER BIBLE (use these ids ONLY in lines where that person really appears; do not invent new looks for them):
${Object.entries(b.chars).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- none: this video has no recurring people'}

FULL SCRIPT (context only):
"""${scriptText()}"""
${creatorNotes()}${prev.length ? `\nPREVIOUS SCENES (continue from these; do not repeat their shot type back to back):\n${prev.map(p => `- line ${p.n}: ${p.shot}; ${p.visual_concept}; ${p.environment}`).join('\n')}\n` : ''}
LINES TO PLAN:
${lines.map((l, k) => `${offset + k + 1}. ${l}`).join('\n')}

HOW TO PLAN EACH LINE
1. Understand the line in its place in the story (read the lines before it). Ask: is it directly visual? Does it add a new visual idea? Does it continue the previous scene?
2. One meaningful visual idea = one image. Show the idea as a REAL moment a photographer could capture:
   - literal lines: show exactly what the line names: the object, place, product, food, animal, vehicle, document or action. If the line is about a thing or a place, the thing or place is the subject, with NO person;
   - analytical or conceptual lines (numbers, problems, reasons, advice): show the most direct real thing that demonstrates it: an object, a place, a detail, or, only when the line is about what someone does or feels, a person. Never symbols (lightbulbs, gears, brains, arrows, floating icons, charts in the air).
3. PEOPLE ARE OPTIONAL. Set "people" to "none" unless the line is about a person: what someone does, says, feels or decides, or an interaction between people. Money, prices, products, places, buildings, nature, food, tools, documents, processes and statistics are usually shown WITHOUT people (close-ups of the object, the place, the result). Never add a person just to fill the frame or to "make it relatable". When people is "none", character_ids is [] and main_subject is the object or place.
4. Continuity: if the line continues the previous situation, keep the same place and time (and the same characters if they were in it), set "same_scene_as_previous": true, and change the shot or angle. Use character ids from the bible only in lines where that person appears; describe one-off extras inside main_subject.
5. Shot variation driven by the narration, chosen from: ${SHOTS.join(', ')}. Emotional beats suit close-ups, context and transitions suit wide or environment shots, actions suit action or over-the-shoulder shots, details suit object close-ups. Never the same shot type twice in a row, and do not let every scene show a person: alternate people shots with object close-ups, places and details, and vary environments (office, home, street, café, meeting room, metro, campus, shop...), props and activities.
6. Screens, documents and signs are angled away or softly blurred. text_in_image is always false.

Return ONLY a JSON array with exactly ${lines.length} objects, in order, each shaped like:
{"line": ${offset + 1}, "scene_type": "user_experience | workplace | education | business | product | lifestyle | nature | ...", "visual_concept": "one sentence", "people": "none | one | two | group", "character_ids": [], "main_subject": "who or what, concrete", "action": "what is happening right now", "environment": "specific real place with 3 to 5 real details", "time_of_day": "", "lighting": "real light source and direction", "emotion": "", "shot": "one of the shot types", "camera": "lens, distance and angle, e.g. 35mm medium close-up at eye level", "composition": "where the subject sits in the ${frameWords()}", "key_props": ["..."], "same_scene_as_previous": false, "text_in_image": false}`;
}

async function planScenes(onProgress){
  const items = state.items; let prev = [], planned = 0, failed = 0;
  for (let start = 0; start < items.length; start += PLAN_CHUNK){
    if (state.cancel) break;
    const lines = items.slice(start, start + PLAN_CHUNK).map(it => it.text);
    let scenes = null;
    for (let attempt = 0; attempt < 2 && !scenes; attempt++){
      try {
        const arr = parseJSONLoose(await askClaude(planPrompt(lines, start, prev), { maxTokens: Math.min(8000, 400 + lines.length * 320), temperature: 0.5 }));
        if (Array.isArray(arr) && arr.length) scenes = arr;
      } catch (e){ if (e.auth) throw e; console.warn('Visual plan failed', e); }
    }
    lines.forEach((_, k) => {
      const sc = scenes && (scenes.find(s => +s.line === start + k + 1) || scenes[k]);
      if (sc && typeof sc === 'object'){
        sc.text_in_image = false;
        sc.people = /^(one|two|group)$/i.test(String(sc.people || '')) ? String(sc.people).toLowerCase() : 'none';
        if (sc.people === 'none') sc.character_ids = [];
        items[start + k].scene = sc; planned++;
      }
      else { items[start + k].scene = null; failed++; }
    });
    prev = items.slice(Math.max(0, start + lines.length - 3), start + lines.length)
      .map((it, k) => it.scene ? { n: start + lines.length - Math.min(3, lines.length) + k + 1, ...it.scene } : null).filter(Boolean);
    onProgress(Math.min(start + PLAN_CHUNK, items.length));
    renderPrompts();
  }
  return { planned, failed };
}

/* ---------- 3. Prompt engineering: STRICT FORMAT ----------
   Claude only fills the line-specific parts; the page assembles every prompt in one fixed order:
   "Photorealistic cinematic scene of <subject> <action>, <emotion>, <environment>, <details>, subtle expression,
    natural skin texture, <authentic Indian ... setting>, <shot>, shallow depth of field, professional commercial
    photography, <lens>, <lighting>, realistic shadows, <orientation> composition, <position> with negative space
    for video editing, no visible text, no logos, no cartoon, no illustration, no CGI, no 3D render." */
const STRICT_START = 'Photorealistic cinematic scene of';
const NO_PEOPLE = 'no people, no person, no human figures, no hands';
const STRICT_END = 'no visible text, no logos, no cartoon, no illustration, no CGI, no 3D render.';
const orientation = () => { const [w, h] = imgSize(); return w > h * 1.1 ? 'horizontal' : h > w * 1.1 ? 'vertical' : 'square'; };
const clean = v => String(v || '').replace(/\s+/g, ' ').replace(/^[\s,.;]+|[\s,.;]+$/g, '').replace(/^(photorealistic cinematic scene of|a photo of|an image of)\s+/i, '');

function assemblePrompt(f, scene){
  // A person appears only when the writer says so, and never when the planned scene has no people.
  const person = f.has_person === true && !(scene && scene.people === 'none');
  const parts = [
    `${STRICT_START} ${clean(f.subject)}${f.action ? ' ' + clean(f.action) : ''}`,
    clean(f.emotion), clean(f.environment), clean(f.details),
    person ? 'subtle expression, natural skin texture' : 'natural material textures',
    clean(f.setting) || 'authentic Indian setting',
    clean(f.shot), 'shallow depth of field', 'professional commercial photography',
    clean(f.lens) || '35mm lens', clean(f.lighting) || 'natural window lighting', 'realistic shadows',
    `${orientation()} composition`,
    `${clean(f.position) || 'subject positioned slightly to the side'} with negative space for video editing`,
    person ? '' : NO_PEOPLE,
    STRICT_END
  ];
  return parts.filter(Boolean).join(', ');
}

function strictWriterPrompt(batch, avoidLike){
  const b = parseBible(), all = state.items.map(it => it.text);
  const usedChars = new Set(batch.flatMap(({ it }) => (it.scene && it.scene.people !== 'none' && it.scene.character_ids) || []));
  return `You write image prompts for a photorealistic image model, one per narration line of a video. You fill in the line-specific parts of a FIXED prompt template; the page assembles the final prompt.
${videoTitle() ? `\nVIDEO TITLE: "${videoTitle()}"` : ''}
TOPIC: ${b.topic || 'work it out from the script'}
SETTING: ${b.setting || 'contemporary India'}
${usedChars.size ? `CHARACTER PROFILES (copy these words exactly into "subject" whenever the character appears):\n${[...usedChars].map(id => `- ${id}: ${b.chars[id] || 'describe from the scene'}`).join('\n')}\n` : ''}${creatorNotes()}
FULL SCRIPT (context only):
"""${scriptText()}"""

THE TEMPLATE (fixed; you fill the <fields>):
Photorealistic cinematic scene of <subject> <action>, <emotion>, <environment>, <details>, subtle expression, natural skin texture, <setting>, <shot>, shallow depth of field, professional commercial photography, <lens>, <lighting>, realistic shadows, ${orientation()} composition, <position> with negative space for video editing, no visible text, no logos, no cartoon, no illustration, no CGI, no 3D render.

EXAMPLE
Narration: "Agar signup ke baad pachaas percent log dusre step pe hi ruk jate hain."
{"subject": "a young Indian professional", "action": "using a modern smartphone signup interface", "emotion": "looking slightly frustrated after getting stuck on a registration step", "environment": "realistic coworking environment", "details": "", "setting": "authentic Indian office setting", "shot": "medium close-up", "lens": "35mm lens", "lighting": "natural window lighting", "position": "subject positioned slightly to the side", "has_person": true}
-> Photorealistic cinematic scene of a young Indian professional using a modern smartphone signup interface, looking slightly frustrated after getting stuck on a registration step, realistic coworking environment, subtle expression, natural skin texture, authentic Indian office setting, medium close-up, shallow depth of field, professional commercial photography, 35mm lens, natural window lighting, realistic shadows, ${orientation()} composition, subject positioned slightly to the side with negative space for video editing, no visible text, no logos, no cartoon, no illustration, no CGI, no 3D render.

EXAMPLE WITHOUT PEOPLE
Narration: "Sona pichhle saal se 30 percent mehenga ho gaya hai."
{"subject": "a neat stack of gleaming 24-karat gold bars and a few gold coins", "action": "resting on a dark velvet jeweller's tray", "emotion": "rich, valuable, quietly dramatic mood", "environment": "polished glass counter of a traditional jewellery shop", "details": "a small brass weighing scale and soft reflections in the glass", "setting": "authentic Indian jewellery shop setting", "shot": "object close-up", "lens": "85mm lens", "lighting": "warm spotlight from above", "position": "subject positioned on the right third", "has_person": false}

PEOPLE ARE OPTIONAL (most important rule)
- has_person is true ONLY when the line is about what a person does, says, feels or decides, or the planned scene has people. Otherwise has_person is false and the subject is the object, place, food, vehicle, animal, product or detail the line is about.
- Never add a person just to fill the frame, to hold an object, or to "make it relatable". A line about money shows money, a line about a city shows the city, a line about a phone feature shows the phone.
- When the planned scene says "people": "none", has_person MUST be false and no field may mention a person, face, hand or body.

FIELD RULES (make every field MORE detailed than the examples, and specific to its own line):
- subject: for object or place shots, the exact object or place and its condition (material, colour, size, wear). For people shots, who exactly (age, gender, look, hair, clothing with colour and fabric); recurring characters use the profile words exactly.
- action: what is happening right now that SHOWS this line's meaning (a concrete, visible action, never a symbol).
- emotion: with a person, a precise believable expression or body language; without a person, the mood of the scene.
- environment: a specific real place with 2 to 4 believable details.
- details: 1 to 3 concrete props or background details unique to this scene (may be "" only if truly nothing fits).
- setting: always "authentic Indian <kind> setting" (office, home, street, café, campus, clinic, shop, metro, factory...), unless the script is clearly set elsewhere.
- shot: shot type and angle (wide shot, medium shot, medium close-up, close-up, over-the-shoulder, top-down, side angle, low angle, object close-up, screen and person, group shot, action shot).
- lens: a real lens that suits the shot (24mm, 35mm, 50mm or 85mm lens).
- lighting: the real light source and direction (natural window lighting from the left, soft overcast daylight, warm desk lamp light, harsh midday sun, fluorescent office lighting...).
- position: where the subject sits ("subject positioned on the left third", "subject positioned slightly to the right"...).
- has_person: true only when a person is visible (see PEOPLE ARE OPTIONAL).
- Screens and papers never show readable words: say "screen facing away" or "softly blurred screen" when needed.

EVERY PROMPT MUST BE CLEARLY DIFFERENT
- Neighbouring lines never repeat the same combination of environment, action, shot and lens. Change at least three of: place, action, props, shot, lens, lighting, position.
- Do not let every scene show a person: many lines are better as an object close-up, a place or a detail. Vary places (office, home, street, café, meeting room, metro, campus, shop, outdoors) and activities, driven by what the line says.
- Continuing scenes keep the same people and place but change the shot, angle, lens and moment.
${avoidLike ? `\nTHESE PROMPTS ALREADY EXIST; YOURS MUST LOOK CLEARLY DIFFERENT FROM THEM:\n${avoidLike.map(x => '- ' + x.slice(34, 260)).join('\n')}\n` : ''}
LINES
${batch.map(({ it, i }) => `${i + 1}. Narration: "${it.text}"
   Two lines before: "${all[i - 2] || 'start of video'}" / "${all[i - 1] || 'start of video'}"${it.scene ? `\n   Planned scene: ${JSON.stringify({ visual_concept: it.scene.visual_concept, people: it.scene.people, character_ids: it.scene.character_ids, main_subject: it.scene.main_subject, action: it.scene.action, environment: it.scene.environment, emotion: it.scene.emotion, shot: it.scene.shot, camera: it.scene.camera, composition: it.scene.composition, key_props: it.scene.key_props, lighting: it.scene.lighting })}` : ''}`).join('\n')}

Return ONLY a JSON array of ${batch.length} objects with exactly these keys, in the same order:
[{"subject": "", "action": "", "emotion": "", "environment": "", "details": "", "setting": "", "shot": "", "lens": "", "lighting": "", "position": "", "has_person": false}]`;
}

async function strictBatch(batch, avoidLike){
  const arr = parseJSONLoose(await askClaude(strictWriterPrompt(batch, avoidLike), { maxTokens: 500 + batch.length * 450, temperature: 0.7 }));
  if (!Array.isArray(arr)) throw new Error('Unexpected format');
  return batch.map(({ it }, k) => arr[k] && arr[k].subject ? assemblePrompt(arr[k], it.scene) : '');
}

/* Word-overlap similarity of the line-specific part of two prompts (0..1). */
function similarity(a, b){
  const cut = p => { const s = String(p), m = s.search(/subtle expression|natural material textures/); return s.slice(STRICT_START.length, m > 0 ? m : 300); };
  const words = p => new Set(cut(p).toLowerCase().match(/[a-z]{4,}/g) || []);
  const A = words(a), B = words(b); if (!A.size || !B.size) return 0;
  let same = 0; A.forEach(w => { if (B.has(w)) same++; });
  return same / Math.min(A.size, B.size);
}

/* Writes strict-format prompts for the given item indexes, then rewrites any that look like another prompt. */
async function writeStrictPrompts(indexes, onProgress){
  const items = state.items;
  const list = indexes.map(i => ({ it: items[i], i }));
  const batches = []; for (let k = 0; k < list.length; k += PROMPT_BATCH) batches.push(list.slice(k, k + PROMPT_BATCH));
  let done = 0, failed = 0;
  await pool(batches, 3, async batch => {
    if (state.cancel) return;
    let out = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++){
      try { out = await strictBatch(batch); } catch (e){ if (e.auth) throw e; console.warn('Prompt batch failed', e); }
    }
    batch.forEach(({ it }, k) => { if (out && out[k]) it.prompt = out[k]; else failed++; });
    done += batch.length; onProgress(done, list.length); renderPrompts();
  });
  // Uniqueness pass: any prompt too close to one of the 6 before it is rewritten once.
  const dupes = [];
  items.forEach((it, i) => {
    if (!it.prompt || !indexes.includes(i)) return;
    const near = items.slice(Math.max(0, i - 6), i).map(x => x.prompt).filter(Boolean);
    if (near.some(p => similarity(p, it.prompt) > 0.6)) dupes.push(i);
  });
  for (let k = 0; k < dupes.length && !state.cancel; k += PROMPT_BATCH){
    const batch = dupes.slice(k, k + PROMPT_BATCH).map(i => ({ it: items[i], i }));
    const avoidLike = [...new Set(batch.flatMap(({ i }) => items.slice(Math.max(0, i - 6), i).map(x => x.prompt).filter(Boolean)))].slice(0, 12);
    try {
      const out = await strictBatch(batch, avoidLike);
      batch.forEach(({ it }, j) => { if (out[j]) it.prompt = out[j]; });
    } catch (e){ if (e.auth) throw e; console.warn('Uniqueness rewrite failed', e); }
  }
  renderPrompts();
  return { failed, rewritten: dupes.length };
}

async function writeScenePrompts(onProgress){
  return writeStrictPrompts(state.items.map((_, i) => i), onProgress);
}

/* "Direct" writer: same strict format, without the scene-planning step. */
async function runDirect(){
  const items = state.items; if (!items.length) return;
  if (needCode('#s2')) return;
  const c0 = state.cost.prompts;
  $('#promptBtn').disabled = true; state.cancel = false;
  try {
    items.forEach(it => { it.scene = null; });
    const res = await writeStrictPrompts(items.map((_, i) => i), (d, n) => setStatus('#s2', `Writing detailed prompts… ${d} of ${n}`));
    items.forEach(it => { if (!it.prompt) it.prompt = fallbackPrompt(it.text); });
    renderPrompts();
    const cost = state.cost.prompts > c0 ? ` for ${money(state.cost.prompts - c0)}` : '';
    setStatus('#s2', res.failed ? `${items.length - res.failed} prompts written${cost}; ${res.failed} came from a template, review them.` : `All ${items.length} prompts written by Claude Sonnet 5${cost}${res.rewritten ? `, ${res.rewritten} rewritten to be more different` : ''}.`, res.failed ? 'err' : 'ok');
  } catch (e){
    setStatus('#s2', e.auth ? e.message + ' Then press Write prompts again.' : 'Prompt writing stopped: ' + cleanMsg(e.message), 'err');
  } finally { $('#promptBtn').disabled = false; updateCost(); updateButtons(); }
}

/* ---------- The whole pipeline, run by "Write prompts" when the writer is the Visual Director ---------- */
async function runDirector(){
  const items = state.items; if (!items.length) return;
  if (needCode('#s2')) return;
  const c0 = state.cost.prompts;
  $('#promptBtn').disabled = true; state.cancel = false;
  try {
    if (!$('#bible').value.trim()){
      setStatus('#s2', 'Step 1 of 3 · Reading the whole script and casting the characters…');
      try { await buildBible(); } catch (e){ if (e.auth) throw e; console.warn('Bible failed', e); }
    }
    setStatus('#s2', `Step 2 of 3 · Planning scenes, shots and continuity… 0 of ${items.length}`);
    const plan = await planScenes(n => setStatus('#s2', `Step 2 of 3 · Planning scenes, shots and continuity… ${n} of ${items.length}`));
    setStatus('#s2', `Step 3 of 3 · Writing detailed photorealistic prompts… 0 of ${plan.planned}`);
    const res = await writeScenePrompts((d, n) => setStatus('#s2', `Step 3 of 3 · Writing detailed photorealistic prompts… ${d} of ${n}`));
    items.forEach(it => { if (!it.prompt) it.prompt = fallbackPrompt(it.text); });
    renderPrompts();
    const cost = state.cost.prompts > c0 ? ` for ${money(state.cost.prompts - c0)}` : '';
    if (res.failed || plan.failed)
      setStatus('#s2', `Prompts ready${cost}. ${plan.failed ? plan.failed + ' line(s) couldn’t be planned and were written directly. ' : ''}${res.failed ? res.failed + ' prompt(s) came from a template; review them. ' : ''}`, 'err');
    else setStatus('#s2', `All ${items.length} scenes planned and prompts written by Claude Sonnet 5${cost}${res.rewritten ? ` (${res.rewritten} rewritten to be more different)` : ''}. Check the character bible and edit any prompt before generating.`, 'ok');
  } catch (e){
    setStatus('#s2', (e.auth ? e.message + ' Then press Write prompts again.' : 'The Visual Director stopped: ' + cleanMsg(e.message)), 'err');
  } finally {
    $('#promptBtn').disabled = false; updateCost(); updateButtons();
  }
}

/* Scene chips shown under each line in step 2. */
function sceneSummary(sc){
  const bits = [sc.shot, sc.emotion, sc.environment, ...(sc.character_ids || [])].filter(Boolean).map(b => `<span class="chip-s">${esc(String(b).slice(0, 60))}</span>`);
  return `<p class="scene-plan" title="${esc(sc.visual_concept || '')}">${bits.join('')}</p>`;
}

/* ---------- 4. Quality control: Claude looks at each generated image ---------- */
const qc = { disabled: false };
const qcOn = () => $('#qcOn') && $('#qcOn').checked && !qc.disabled;

function shrinkForCheck(b64){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 640 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve('data:image/jpeg;base64,' + b64);
    img.src = 'data:image/jpeg;base64,' + b64;
  });
}

const noPeople = it => (it.scene && it.scene.people === 'none') || /no people, no person/.test(it.prompt || '');

async function checkImage(it, b64){
  const sc = it.scene || {};
  const txt = await askClaude(`You are a strict photo editor checking one generated image for a video. Look at the attached image and compare it with what was intended.

NARRATION: "${it.text}"
PEOPLE EXPECTED: ${noPeople(it) ? 'NO - the image must not show any person, face, hand or body' : 'yes, as described'}
INTENDED SCENE: ${it.scene ? JSON.stringify({ visual_concept: sc.visual_concept, people: sc.people, main_subject: sc.main_subject, action: sc.action, environment: sc.environment, shot: sc.shot, composition: sc.composition }) : it.prompt.slice(0, 900)}

Check: is it a believable real photograph (not cartoon, illustration, anime, 3D or CGI, no plastic skin)? Correct subject, action and environment? Any readable or garbled text, captions, logos or watermarks? Any distorted face, hands, fingers or body? Correct composition? Consistent professional photo style?

Return ONLY JSON: {"photorealistic": true, "cartoon_or_cgi": false, "unexpected_person": false, "subject_ok": true, "action_ok": true, "environment_ok": true, "unwanted_text": false, "distortion": false, "composition_ok": true, "score": 0-10, "issues": ["short issue"], "fix": "one or two sentences to add to the prompt that would fix the issues"}`,
    { maxTokens: 500, temperature: 0, images: [await shrinkForCheck(b64)] });
  const r = parseJSONLoose(txt);
  const min = parseFloat($('#qcMin').value) || 7;
  if (!noPeople(it)) r.unexpected_person = false;
  r.pass = !!r.photorealistic && !r.cartoon_or_cgi && !r.unexpected_person && !r.unwanted_text && !r.distortion && (+r.score || 0) >= min;
  return r;
}

/* Called by generateOne() after each image. Returns the image to keep. */
async function qcAfterGenerate(i, first){
  const it = state.items[i];
  if (!qcOn() || !it) return first;
  let best = { ...first, score: -1 }, current = first;
  const tries = parseInt($('#qcRetries').value, 10) || 0;
  for (let attempt = 0; attempt <= tries; attempt++){
    let r;
    try { r = await checkImage(it, current.b64); }
    catch (e){
      if (e.auth) throw e;
      // The model or account can't check images: keep going without checks, and say so once.
      if (e.runware && !qc.disabled){ qc.disabled = true; setStatus('#s3', 'Image checking isn’t available on this Runware account (' + cleanMsg(e.message) + '). Images are generated without checks.', 'err'); }
      it.qc = null; return current;
    }
    it.qc = { score: +r.score || 0, pass: r.pass, issues: r.issues || [], redone: attempt };
    if ((+r.score || 0) > best.score) best = { ...current, score: +r.score || 0, qc: it.qc };
    if (r.pass || attempt === tries || state.cancel) break;
    // Regenerate with a corrected prompt.
    it.status = 'loading'; it.err = `Check failed (${(r.issues || []).slice(0, 2).join('; ') || 'low score'}), regenerating…`; updateCell(i);
    const fix = [r.fix, r.cartoon_or_cgi || !r.photorealistic ? 'This must be an unedited real photograph of real people and places, with natural skin and real materials.' : '',
      r.unexpected_person ? 'Show no people at all: no person, face, hands or body anywhere in the frame; only the objects and the place.' : '',
      r.unwanted_text ? 'Remove every letter and word: screens, papers and signs are angled away or blurred.' : '',
      r.distortion ? 'Keep hands simple and relaxed with five natural fingers, and faces naturally proportioned.' : ''].filter(Boolean).join(' ');
    const next = await runware(`${it.prompt.replace(/\s+$/, '')} Corrections: ${fix}`.slice(0, 3800));
    if (next.cost !== null){ state.cost.images += next.cost; }
    current = next;
  }
  it.qc = best.qc || it.qc;
  return best.score >= 0 ? best : current;
}

function qcBadge(it){
  if (!it.qc || it.status !== 'done') return '';
  const cls = it.qc.pass ? 'qc-ok' : 'qc-warn';
  const tip = it.qc.issues && it.qc.issues.length ? it.qc.issues.join('; ') : 'Passed the photo check';
  return `<span class="qc ${cls}" title="${esc(tip)}">${it.qc.pass ? '✓' : '!'} ${it.qc.score}/10${it.qc.redone ? ` · redone ${it.qc.redone}×` : ''}</span>`;
}
