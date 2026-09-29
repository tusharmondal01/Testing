/* ---------- VISUAL DIRECTOR PIPELINE ----------
   Loaded after the main page script and uses its helpers (relay, state, pool, setStatus, runware, ...).

   FULL SCRIPT (split by scene in step 1)
   → 1. Casting: topic, setting and a character bible (one profile per recurring person)
   → 2. Visual plan: one structured scene per line (concept, subject, action, environment, emotion,
        shot, camera, composition), with shot variation and continuity driven by the narration
   → 3. Prompt engineering: Claude writes each prompt in its own words, in story order, seeing the video
        concept, the full script and the prompts already written; repeated prompts are rewritten
   → 4. Quality control after each image: Claude looks at the image; failures are regenerated
        with a corrected prompt.

   All steps use TEXT_MODEL (Claude Sonnet 5 on Runware); images use IMAGE_MODEL (GPT Image 2). */

const SHOTS = ['wide shot', 'medium shot', 'close-up', 'over-the-shoulder', 'top-down', 'side angle', 'low angle', 'environment shot', 'object close-up', 'screen + person', 'group shot', 'action shot'];
const PLAN_CHUNK = 12;   // lines per visual-plan request (sequential, so continuity carries over)

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
const creatorNotes = () => { const n = ($('#notes').value || '').trim(); return n ? `\nEXTRA DIRECTION FROM THE CREATOR (follow it; any people described here appear ONLY in lines that are about them, never in every image): ${n}\n` : ''; };

/* ---------- 1. Character & style bible ----------
   Stored as editable lines in #bible:  "setting: ..."  and  "employee_01: Indian man, 28, ..." */
function parseBible(){
  const out = { setting: '', topic: '', concept: '', audience: '', chars: {} };
  ($('#bible').value || '').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/); if (!m) return;
    const k = m[1].toLowerCase();
    if (k === 'setting') out.setting = m[2].trim();
    else if (k === 'topic') out.topic = m[2].trim();
    else if (k === 'concept') out.concept = m[2].trim();
    else if (k === 'audience') out.audience = m[2].trim();
    else out.chars[m[1]] = m[2].trim();
  });
  return out;
}
const bibleText = b => [b.topic && 'topic: ' + b.topic, b.concept && 'concept: ' + b.concept, b.audience && 'audience: ' + b.audience, b.setting && 'setting: ' + b.setting, ...Object.entries(b.chars).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n');

async function buildBible(){
  const txt = await askClaude(`You are the script analyst and casting director for a short video. Read the video title and the WHOLE script, then plan who and where the video shows.
${videoTitle() ? `\nVIDEO TITLE: "${videoTitle()}"\n` : ''}
SCRIPT (may be Hindi, Hinglish or English):
"""${scriptText()}"""
${creatorNotes()}

Return ONLY JSON:
{"topic": "the video's topic in one short English sentence",
 "concept": "2 to 3 sentences: what the video is really about, its message, and how the story moves from start to end (hook, problem, explanation, advice, ending)",
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
  $('#bible').value = bibleText({ topic: j.topic || '', concept: j.concept || '', audience: j.audience || '', setting: j.setting || '', chars });
}

/* ---------- 2. Visual plan: structured scene per line ---------- */
function planPrompt(lines, offset, prev){
  const b = parseBible();
  return `You are the Visual Director of a video. The narration below is shown one photograph at a time. For every numbered line, plan ONE photorealistic scene as structured data.
${videoTitle() ? `\nVIDEO TITLE: "${videoTitle()}"` : ''}
TOPIC: ${b.topic || 'work it out from the script'}
${b.concept ? `VIDEO CONCEPT: ${b.concept}\n` : ''}SETTING: ${b.setting || 'contemporary India'}
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

/* ---------- 3. Prompt engineering: free-form, in story order ----------
   Claude writes every prompt in its own words (no fixed opening line). Lines are written IN ORDER, a few at a
   time, and each request carries the video concept, the full script, the planned scene and the prompts already
   written for the previous lines, so every image is checked against the whole video, not just its own line.
   The page only appends one short technical tail (PROMPT_TAIL) so no text or cartoon look sneaks in. */
const PROMPT_TAIL = 'Real photograph, no visible text, no logos, no watermark, no cartoon, no illustration, no CGI.';
const NO_PEOPLE = 'No people anywhere in the frame.';
const PROMPT_BATCH = 4;   // lines per prompt-writing request (sequential, so each batch sees the prompts before it)
const PREV_PROMPTS = 6;   // how many earlier prompts each request sees
const orientation = () => { const [w, h] = imgSize(); return w > h * 1.1 ? 'horizontal' : h > w * 1.1 ? 'vertical' : 'square'; };
const BANNED_OPENERS = /^(photorealistic|a photorealistic|cinematic|a cinematic|hyper-?realistic|ultra-?realistic|realistic|a realistic|a photo of|a photograph of|an image of|image of|photo of|scene of|a scene of|a shot of|shot of)\b[\s,:-]*/i;

function finishPrompt(text, scene, hasPerson){
  let p = String(text || '').replace(/\s+/g, ' ').trim().replace(/^["'“]+|["'”]+$/g, '');
  for (let k = 0; k < 3 && BANNED_OPENERS.test(p); k++) p = p.replace(BANNED_OPENERS, '');
  if (!p) return '';
  p = p.charAt(0).toUpperCase() + p.slice(1);
  p = p.replace(/[\s.,;]+$/, '') + '.';
  const noPeople = (scene && scene.people === 'none') || hasPerson === false;
  return `${p}${noPeople && !/no people/i.test(p) ? ' ' + NO_PEOPLE : ''} ${PROMPT_TAIL}`;
}
const promptBody = p => String(p || '').replace(PROMPT_TAIL, '').replace(NO_PEOPLE, '').trim();

function writerPrompt(batch, avoidLike){
  const b = parseBible(), items = state.items, all = items.map(it => it.text);
  const first = batch[0].i;
  const prev = items.slice(Math.max(0, first - PREV_PROMPTS), first).map((it, k) => ({ n: Math.max(0, first - PREV_PROMPTS) + k + 1, text: it.text, prompt: promptBody(it.prompt) })).filter(x => x.prompt);
  const usedChars = new Set(batch.flatMap(({ it }) => (it.scene && it.scene.people !== 'none' && it.scene.character_ids) || []));
  return `You are the Visual Director and prompt writer for one video. The narration is shown one photograph at a time. Write the image prompt for each numbered line below.

STEP 1: UNDERSTAND THE WHOLE VIDEO FIRST
${videoTitle() ? `VIDEO TITLE: "${videoTitle()}"\n` : ''}TOPIC: ${b.topic || 'work it out from the full script'}
${b.concept ? `VIDEO CONCEPT: ${b.concept}\n` : ''}${b.audience ? `AUDIENCE: ${b.audience}\n` : ''}SETTING: ${b.setting || 'contemporary India, unless the script says otherwise'}
${usedChars.size ? `RECURRING PEOPLE IN THESE LINES (describe them with these exact words, and ONLY in the lines listed as showing them):\n${[...usedChars].map(id => `- ${id}: ${b.chars[id] || 'describe from the scene'}`).join('\n')}\n` : ''}${creatorNotes()}
FULL SCRIPT (read all of it; it may be Hindi, Hinglish or English):
"""${scriptText()}"""

STEP 2: KNOW WHAT CAME BEFORE
${prev.length ? `PROMPTS ALREADY WRITTEN FOR THE PREVIOUS LINES (the images the viewer has just seen):\n${prev.map(x => `- line ${x.n} "${x.text}": ${x.prompt.slice(0, 420)}`).join('\n')}` : 'This is the start of the video: the first image must hook the viewer and establish the topic.'}
${avoidLike ? `\nTHESE PROMPTS ARE TOO SIMILAR TO YOURS; WRITE CLEARLY DIFFERENT IMAGES:\n${avoidLike.map(x => '- ' + promptBody(x).slice(0, 260)).join('\n')}\n` : ''}
STEP 3: WRITE ONE PROMPT PER LINE
${batch.map(({ it, i }) => `${i + 1}. "${it.text}"
   next line: "${all[i + 1] || 'end of video'}"${it.scene ? `\n   planned scene: ${JSON.stringify({ visual_concept: it.scene.visual_concept, people: it.scene.people, character_ids: it.scene.character_ids, main_subject: it.scene.main_subject, action: it.scene.action, environment: it.scene.environment, shot: it.scene.shot, camera: it.scene.camera, same_scene_as_previous: it.scene.same_scene_as_previous })}` : ''}`).join('\n')}

HOW TO WRITE EACH PROMPT
1. Relevance: the image must show what THIS line means INSIDE this video. Ask: what is the video about, where are we in its story, what did the viewer just see, and what does this line add? A line like "yahi sabse badi galti hai" means nothing alone: use the lines before it to show WHICH mistake.
2. Continuity: if the line continues the previous situation, keep the same place, time and objects (and the same person only if that person was in it) but change the angle or moment. If the story moves on, move the image on. Never jump to an unrelated generic scene.
3. People are optional. Show a person ONLY when the line is about what someone does, says, feels or decides. Money, prices, products, places, food, nature, documents, tools, processes and statistics are shown as the thing itself. Never add a person just to fill the frame, and never give every line the same character.${usedChars.size ? '' : ' No recurring character is planned for these lines.'}
4. No symbols: no lightbulbs, gears, brains, arrows, floating icons or charts in the air. Show a real moment a photographer could capture.
5. Write each prompt in your own words, 70 to 120 words, as one flowing description. START WITH THE SUBJECT ITSELF (e.g. "A steel tiffin box half-open on...", "Rain-soaked Mumbai street at dusk...", "A 45-year-old farmer kneeling..."). NEVER start with "Photorealistic", "Cinematic", "A photo of", "Scene of", "Image of" or any phrase you used to start another prompt. No two prompts may share the same opening words.
6. Include: the exact subject with materials, colours and condition; the action or state; the specific real place with 2 to 3 details; the light source and direction; the shot type and a real lens (24, 35, 50 or 85mm); where the subject sits in the ${orientation()} frame. Vary shot, lens, light and place from the previous prompts.
7. Screens, papers and signs are turned away or softly blurred, never readable. Do not write "no text" or style tags: the page adds them.

Return ONLY a JSON array of ${batch.length} objects, in order:
[{"line": ${first + 1}, "link": "one short sentence: how this image connects to the video's topic and to the previous image", "has_person": false, "prompt": "..."}]`;
}

async function writeBatch(batch, avoidLike){
  const arr = parseJSONLoose(await askClaude(writerPrompt(batch, avoidLike), { maxTokens: 600 + batch.length * 500, temperature: 0.7 }));
  if (!Array.isArray(arr)) throw new Error('Unexpected format');
  return batch.map(({ it, i }, k) => {
    const o = arr.find(x => x && +x.line === i + 1) || arr[k];
    return o && o.prompt ? finishPrompt(o.prompt, it.scene, o.has_person) : '';
  });
}

/* Word-overlap similarity of two prompts (0..1), ignoring the fixed tail. */
function similarity(a, b){
  const words = p => new Set(promptBody(p).toLowerCase().match(/[a-z]{4,}/g) || []);
  const A = words(a), B = words(b); if (!A.size || !B.size) return 0;
  let same = 0; A.forEach(w => { if (B.has(w)) same++; });
  return same / Math.min(A.size, B.size);
}
const opener = p => (promptBody(p).toLowerCase().match(/[a-z0-9'-]+/g) || []).slice(0, 3).join(' ');

/* Writes prompts for the given item indexes in story order, then rewrites any that repeat an earlier one. */
async function writeStrictPrompts(indexes, onProgress){
  const items = state.items;
  const list = [...indexes].sort((x, y) => x - y).map(i => ({ it: items[i], i }));
  // Batches are consecutive lines, written one after another so each batch sees the prompts before it.
  const batches = [];
  list.forEach(entry => {
    const last = batches[batches.length - 1];
    if (last && last.length < PROMPT_BATCH && last[last.length - 1].i === entry.i - 1) last.push(entry); else batches.push([entry]);
  });
  let done = 0, failed = 0;
  for (const batch of batches){
    if (state.cancel) break;
    let out = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++){
      try { out = await writeBatch(batch); } catch (e){ if (e.auth) throw e; console.warn('Prompt batch failed', e); }
    }
    batch.forEach(({ it }, k) => { if (out && out[k]) it.prompt = out[k]; else failed++; });
    done += batch.length; onProgress(done, list.length); renderPrompts();
  }
  // Repetition pass: a prompt too close to one of the 6 before it, or opening with the same words, is rewritten once.
  const dupes = [];
  items.forEach((it, i) => {
    if (!it.prompt || !indexes.includes(i)) return;
    const near = items.slice(Math.max(0, i - 6), i).map(x => x.prompt).filter(Boolean);
    if (near.some(p => similarity(p, it.prompt) > 0.6 || opener(p) === opener(it.prompt))) dupes.push(i);
  });
  for (const i of dupes){
    if (state.cancel) break;
    const avoidLike = items.slice(Math.max(0, i - 6), i).map(x => x.prompt).filter(Boolean);
    try { const [p] = await writeBatch([{ it: items[i], i }], avoidLike); if (p) items[i].prompt = p; }
    catch (e){ if (e.auth) throw e; console.warn('Repetition rewrite failed', e); }
  }
  renderPrompts();
  return { failed, rewritten: dupes.length };
}

async function writeScenePrompts(onProgress){
  return writeStrictPrompts(state.items.map((_, i) => i), onProgress);
}

/* "Direct" writer: same writer, without the scene-planning step (the video concept is still read first). */
async function runDirect(){
  const items = state.items; if (!items.length) return;
  if (needCode('#s2')) return;
  const c0 = state.cost.prompts;
  $('#promptBtn').disabled = true; state.cancel = false;
  try {
    items.forEach(it => { it.scene = null; });
    if (!$('#bible').value.trim()){
      setStatus('#s2', 'Reading the whole script to understand the video…');
      try { await buildBible(); } catch (e){ if (e.auth) throw e; console.warn('Concept failed', e); }
    }
    const res = await writeStrictPrompts(items.map((_, i) => i), (d, n) => setStatus('#s2', `Writing prompts in story order… ${d} of ${n}`));
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
    setStatus('#s2', `Step 3 of 3 · Writing prompts in story order… 0 of ${plan.planned}`);
    const res = await writeScenePrompts((d, n) => setStatus('#s2', `Step 3 of 3 · Writing prompts in story order… ${d} of ${n}`));
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

const noPeople = it => (it.scene && it.scene.people === 'none') || /No people anywhere in the frame/.test(it.prompt || '');

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
