/* ---------- VISUAL DIRECTOR PIPELINE ----------
   Loaded after the main page script and uses its helpers (relay, state, pool, setStatus, runware, ...).

   FULL SCRIPT (split by scene in step 1)
   → 1. Casting: topic, setting and a character bible (one profile per recurring person)
   → 2. Visual plan: one structured scene per line (concept, subject, action, environment, emotion,
        shot, camera, composition), with shot variation and continuity driven by the narration
   → 3. Prompt engineering: each structured scene becomes a detailed photorealistic prompt,
        then the permanent GLOBAL_STYLE and AVOID layers are appended
   → 4. Quality control after each image: Claude looks at the image; failures are regenerated
        with a corrected prompt.

   All steps use TEXT_MODEL (Claude Sonnet 5 on Runware); images use IMAGE_MODEL (GPT Image 2). */

/* Permanent style layer, so the text model never reinvents the look per image. */
const GLOBAL_STYLE = 'Photorealistic commercial photography of real human beings: natural skin texture, realistic facial anatomy, natural body proportions, authentic clothing, real-world environment, physically accurate lighting with natural shadows, cinematic but realistic, subtle depth of field, high-quality professional camera capture, modern Indian environment when appropriate. The image must look like a real photograph.';
const AVOID = 'No illustration, no cartoon, no anime, no comic style, no 3D render, no CGI, no plastic skin, no doll-like faces, no exaggerated expressions, no fantasy lighting, no surreal elements, no oversaturated colours, no fake-looking background, no readable text, no captions, no watermark, no logo.';

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
- 1 to 5 recurring characters the story really needs (the viewer, a user, an employee, a manager, a customer, a student...). Only people who appear in several scenes.
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
CHARACTER BIBLE (use these ids whenever these people appear; do not invent new looks for them):
${Object.entries(b.chars).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- none yet: describe people inside main_subject'}

FULL SCRIPT (context only):
"""${scriptText()}"""
${creatorNotes()}${prev.length ? `\nPREVIOUS SCENES (continue from these; do not repeat their shot type back to back):\n${prev.map(p => `- line ${p.n}: ${p.shot}; ${p.visual_concept}; ${p.environment}`).join('\n')}\n` : ''}
LINES TO PLAN:
${lines.map((l, k) => `${offset + k + 1}. ${l}`).join('\n')}

HOW TO PLAN EACH LINE
1. Understand the line in its place in the story (read the lines before it). Ask: is it directly visual? Does it add a new visual idea? Does it continue the previous scene?
2. One meaningful visual idea = one image. Show the idea as a REAL moment a photographer could capture:
   - literal lines: show exactly that (a person, place, object or action);
   - analytical or conceptual lines (numbers, problems, reasons, advice): show a relatable real situation that demonstrates it, e.g. "50% users drop at step two" -> a young professional at an office desk pausing, mildly frustrated, at an unfinished signup form. Never symbols (lightbulbs, gears, brains, arrows, floating icons, charts in the air).
3. Continuity: if the line continues the previous situation, keep the same characters, place and time, set "same_scene_as_previous": true, and change the shot or angle. Use character ids from the bible for recurring people; describe one-off extras inside main_subject.
4. Shot variation driven by the narration, chosen from: ${SHOTS.join(', ')}. Emotional beats suit close-ups, context and transitions suit wide or environment shots, actions suit action or over-the-shoulder shots, details suit object close-ups. Never the same shot type twice in a row, and do not let every scene be a person at a laptop: vary environments (office, home, street, café, meeting room, metro, campus, shop...), props and activities.
5. Screens, documents and signs are angled away or softly blurred. text_in_image is always false.

Return ONLY a JSON array with exactly ${lines.length} objects, in order, each shaped like:
{"line": ${offset + 1}, "scene_type": "user_experience | workplace | education | business | product | lifestyle | nature | ...", "visual_concept": "one sentence", "character_ids": ["employee_01"], "main_subject": "who or what, concrete", "action": "what is happening right now", "environment": "specific real place with 3 to 5 real details", "time_of_day": "", "lighting": "real light source and direction", "emotion": "", "shot": "one of the shot types", "camera": "lens, distance and angle, e.g. 35mm medium close-up at eye level", "composition": "where the subject sits in the ${frameWords()}", "key_props": ["..."], "same_scene_as_previous": false, "text_in_image": false}`;
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
      if (sc && typeof sc === 'object'){ sc.text_in_image = false; items[start + k].scene = sc; planned++; }
      else { items[start + k].scene = null; failed++; }
    });
    prev = items.slice(Math.max(0, start + lines.length - 3), start + lines.length)
      .map((it, k) => it.scene ? { n: start + lines.length - Math.min(3, lines.length) + k + 1, ...it.scene } : null).filter(Boolean);
    onProgress(Math.min(start + PLAN_CHUNK, items.length));
    renderPrompts();
  }
  return { planned, failed };
}

/* ---------- 3. Prompt engineering: structured scene -> detailed photorealistic prompt ---------- */
function promptEngineerPrompt(batch){
  const b = parseBible(), st = strength();
  const all = state.items.map(it => it.text);
  const usedChars = new Set(batch.flatMap(({ it }) => (it.scene && it.scene.character_ids) || []));
  return `You are a prompt engineer for a photorealistic image model. Convert each structured scene below into ONE detailed image prompt.
${videoTitle() ? `\nVIDEO TITLE: "${videoTitle()}"` : ''}
TOPIC: ${b.topic || ''}
CHARACTER PROFILES (copy these descriptions word for word whenever the character appears):
${[...usedChars].map(id => `- ${id}: ${b.chars[id] || 'not in the bible, describe from the scene'}`).join('\n') || '- none'}

WRITE EACH PROMPT AS ONE PARAGRAPH OF ${st.words} WORDS that:
- starts with "Create a photorealistic cinematic image of";
- describes the main subject concretely (use the character profile words exactly), what they are doing right now, and a subtle, believable facial expression for the emotion;
- describes the real environment with 3 to 5 believable details and the time of day;
- names the real light source and its direction, realistic shadows and physically accurate lighting;
- names the camera: the shot type, a real lens (e.g. 35mm or 50mm) and shallow but realistic depth of field;
- states the composition for a ${frameWords()} (where the subject sits, where the clean space is);
- adds realism cues: natural human proportions, authentic skin texture, realistic clothing, a real modern Indian place when appropriate;
- keeps any screen, paper or sign angled away or softly blurred so no words are visible;
- ends with "The image must look like a real photograph captured with a professional camera."
Do NOT add style lists or "no cartoon" lists; they are appended automatically. Never use the words hyper-realistic, 8k, render or masterpiece.

EXAMPLE
Narration: "Agar signup ke baad pachaas percent log dusre step pe hi ruk jate hain, toh problem sirf conversion ki nahi hai."
Prompt: "Create a photorealistic cinematic image of a young Indian professional sitting at a modern office desk and attempting to complete a digital signup process on a computer. The person has reached an intermediate signup step and appears mildly confused and frustrated because the process is not progressing. Show a realistic modern Indian workplace environment with believable office furniture, natural human proportions, authentic skin texture, realistic clothing and subtle facial expression. Use professional commercial photography aesthetics, natural window light, realistic shadows, physically accurate lighting, 35mm camera lens, shallow but realistic depth of field. Medium close-up composition. Keep the subject on the right side of the frame and leave clean visual space on the left. The image must look like a real photograph captured with a professional camera."

SCENES
${batch.map(({ it, i }) => `${i + 1}. Narration: "${it.text}"
   Story so far: "${all[i - 2] || ''}" / "${all[i - 1] || 'start of video'}"
   Scene: ${JSON.stringify(it.scene)}`).join('\n')}

Return ONLY a JSON array of ${batch.length} strings, one prompt per scene, in the same order.`;
}
const finishPrompt = p => `${String(p).trim().replace(/[.\s]+$/, '')}. ${GLOBAL_STYLE} ${AVOID}`;

async function writeScenePrompts(onProgress){
  const items = state.items;
  const withScene = items.map((it, i) => ({ it, i })).filter(x => x.it.scene);
  const batches = []; for (let k = 0; k < withScene.length; k += PROMPT_BATCH) batches.push(withScene.slice(k, k + PROMPT_BATCH));
  let done = 0, failed = 0;
  await pool(batches, 3, async batch => {
    if (state.cancel) return;
    let arr = null;
    for (let attempt = 0; attempt < 2 && !arr; attempt++){
      try { const a = parseJSONLoose(await askClaude(promptEngineerPrompt(batch), { maxTokens: 700 + batch.length * 700, temperature: 0.6 })); if (Array.isArray(a)) arr = a; }
      catch (e){ if (e.auth) throw e; console.warn('Prompt batch failed', e); }
    }
    batch.forEach(({ it }, k) => { const p = arr && arr[k] && String(arr[k]).trim(); if (p) it.prompt = finishPrompt(p); else failed++; });
    done += batch.length; onProgress(done, withScene.length); renderPrompts();
  });
  // Lines the planner could not plan fall back to the direct Claude writer.
  const loose = items.map((it, i) => ({ it, i })).filter(x => !x.it.scene || !x.it.prompt);
  for (let k = 0; k < loose.length && !state.cancel; k += 2){
    const run = loose.slice(k, k + 2);
    try {
      const out = await runwareLLMBatch(run.map(x => x.it.text), run[0].i);
      run.forEach((x, j) => { if (out[j]) x.it.prompt = out[j]; else failed++; });
    } catch (e){ if (e.auth) throw e; failed += run.length; }
  }
  return { failed };
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
    else setStatus('#s2', `All ${items.length} scenes planned and prompts written by Claude Sonnet 5${cost}. Check the character bible and edit any prompt before generating.`, 'ok');
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

async function checkImage(it, b64){
  const sc = it.scene || {};
  const txt = await askClaude(`You are a strict photo editor checking one generated image for a video. Look at the attached image and compare it with what was intended.

NARRATION: "${it.text}"
INTENDED SCENE: ${it.scene ? JSON.stringify({ visual_concept: sc.visual_concept, main_subject: sc.main_subject, action: sc.action, environment: sc.environment, shot: sc.shot, composition: sc.composition }) : it.prompt.slice(0, 900)}

Check: is it a believable real photograph (not cartoon, illustration, anime, 3D or CGI, no plastic skin)? Correct subject, action and environment? Any readable or garbled text, captions, logos or watermarks? Any distorted face, hands, fingers or body? Correct composition? Consistent professional photo style?

Return ONLY JSON: {"photorealistic": true, "cartoon_or_cgi": false, "subject_ok": true, "action_ok": true, "environment_ok": true, "unwanted_text": false, "distortion": false, "composition_ok": true, "score": 0-10, "issues": ["short issue"], "fix": "one or two sentences to add to the prompt that would fix the issues"}`,
    { maxTokens: 500, temperature: 0, images: [await shrinkForCheck(b64)] });
  const r = parseJSONLoose(txt);
  const min = parseFloat($('#qcMin').value) || 7;
  r.pass = !!r.photorealistic && !r.cartoon_or_cgi && !r.unwanted_text && !r.distortion && (+r.score || 0) >= min;
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
