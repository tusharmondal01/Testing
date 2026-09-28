# Craftush

Script-to-Premiere image tool with a private backend.

- `public/index.html` – dashboard with the three tool cards (craftush.netlify.app)
- `public/visuals/index.html` – Stunning Visuals (craftush.netlify.app/visuals)
- `public/comfy/index.html` – Idea to Video, the ComfyUI front end (craftush.netlify.app/comfy)
- `public/admin/index.html` – admin page (craftush.netlify.app/admin)
- `netlify/edge-functions/runware.js` – relay that adds the secret Runware key
- `netlify/edge-functions/admin.js` – admin API (password protected)
- `netlify/edge-functions/tools.js` – dashboard settings and the ComfyUI workflow for the team
- `netlify/edge-functions/thumbnail.js` – serves the thumbnail generator uploaded in /admin (craftush.netlify.app/thumbnail)
- `comfyui/Script_to_Images_Runware.json` – drag-and-drop ComfyUI workflow (no folders to copy): Claude Fable 5 plans all scenes and writes the prompts once, FLUX.2 [max] makes one 9:16 image per scene. Uses Runware's official ComfyUI nodes, which ComfyUI installs itself; the key goes in Settings → Runware API key. How to use is in the workflow's READ ME note.
- `comfyui/ComfyUI-Runware-ScriptDirector/` – ComfyUI Desktop nodes + workflow: the same Visual Director pipeline (script → 60–70 photoreal images) running inside ComfyUI with only a Runware key. See its README.

## One-time setup

1. **Set the admin password.** In Netlify, open the craftush project, go to
   **Project configuration → Environment variables → Add a variable**.
   Key: `ADMIN_PASSWORD`, value: a long password only you know.
2. **Put these files on GitHub.** Create a free account at github.com, then
   **New repository** (choose *Private*). Click **uploading an existing file** and
   drag in everything from this folder (the `public` and `netlify` folders,
   `netlify.toml`, `package.json` and this README). Commit.
3. **Connect Netlify to GitHub.** In Netlify, go to **Project configuration →
   Build & deploy → Link repository**, choose GitHub and your new repository.
   Leave the build command empty; the publish directory comes from `netlify.toml`.
   Deploy.
4. **Add the Runware key.** Open **craftush.netlify.app/admin**, sign in with
   `ADMIN_PASSWORD`, paste the Runware key and press **Save key**.
5. **(Recommended) Set a team access code** on the same page and share it with
   your creators. Without a code, anyone who finds the link can use your credits.

## Updating later

Upload the changed files to the GitHub repository (replace the old ones).
Netlify publishes the new version automatically within about a minute.
Drag-and-drop deploys no longer work for this project, because they don't include the backend.

## Changing things

- New admin password: edit `ADMIN_PASSWORD` in Netlify, then redeploy.
- New team code or Runware key: change it on the /admin page. It takes effect immediately.

## Dashboard tools

- **Thumbnail generator:** upload a single HTML file in /admin → Dashboard. It opens at /thumbnail.
- **Idea to Video:** in ComfyUI choose Workflow → Export (API), upload that JSON in /admin, pick which text box receives the idea,
  tick the settings the team may change, and set the default ComfyUI address.
  Each ComfyUI (Desktop or server) must have CORS enabled for https://craftush.netlify.app and the workflow's models installed.

## Image prompt quality (Stunning Visuals)

Every line of the script becomes its own image prompt in step 2. The goal is images that are **relevant** to the line and look like **real, unedited photographs**.

**Relevance**
- The Claude prompt writer (`claudeSystem()` in `public/visuals/index.html`) first works out the meaning of the Hindi/Hinglish line, then picks the scene in this order: a literal scene, then a relatable real-life moment, then a plain real object or place. Glowing lightbulbs, brains, gears, arrows and other stock symbols are banned. A forest or mountain is allowed only when the line is about nature or a journey.
- Each line is sent with the lines before and after it (context only) and the full script, so the image fits its place in the story. Recurring characters are described with identical words (fill in **Characters & look** in step 2).
- Default setting is contemporary India: real faces, clothing, streets, classrooms and homes.

**Realism**
- The old glossy look (volumetric rays, golden light, saturated colour, HDR) was removed. `MASTER_LOOK` is now an unedited, candid, true-to-life photograph with real imperfections. `NATURE_LIGHT` (soft sunlight and light haze) is added only when a line is about the outdoors (`OUTDOOR_RE`).
- **Visual style** defaults to *Real photograph*. *Everyday phone photo* is the most casual and believable option.
- `NEGATIVE_PROMPT` targets the AI look (plastic skin, glow, neon, HDR, staged poses). It is sent to models that honour it (SD/SDXL style checkpoints). FLUX ignores negative prompts, so the same rules are in the positive prompt.
- FLUX Dev defaults: 32 steps and a low guidance option (*Raw natural*, 2.2) for the least AI-looking result.

**No garbled text**
- Certificates, documents, signs and screens are shown small, from behind, or blurred. Every prompt ends with a no-text sentence (`NO_TEXT_TAIL`), added automatically to edited or older prompts at generation time.

**Stunning photoreal look (default)**
- *Visual style → Stunning photoreal* gives the polished premium-stock / National Geographic look: golden-hour light, god rays through mist, rich lush greens, crisp micro-detail, deep atmospheric layers, cosy warm-lamp interiors. The other styles keep the muted "unedited" look.
- With this style the Claude brief allows golden light, volumetric rays and rich colour, the negative prompt stops blocking glow and HDR, and **Look** switches to *Vivid (3.5)*, which gives FLUX its richest colour.

**Models (fixed)**
- Script splitting and prompt writing use only **Claude Sonnet 5** on Runware (`anthropic:claude@sonnet-5`, `TEXT_MODEL`). These requests are sent with `strictModel`, so the relay never switches to another text model; if Runware rejects it, the error is shown.
- Images use only **GPT Image 2** (`openai:gpt-image@2`, `IMAGE_MODEL`).
- Only the Runware key saved in /admin is needed.

**Visual Director pipeline (default prompt writer)** – `public/visuals/director.js`
Built from the "Runware Bulk Image Generation" plan: the pipeline adds a visual-planning layer instead of turning each line straight into a prompt.
1. **Scene segmentation** (step 1, *By scene*): Claude splits where a new meaningful visual idea starts, aiming softly for the image range (default 60 to 70) without forcing it.
2. **Casting**: Claude reads the title and whole script and writes the **Character & style bible** (topic, setting, one profile per recurring person). It is editable; every prompt copies these profiles word for word so people stay consistent. Empty it to recast.
3. **Visual plan**: for every line Claude returns a structured scene (`scene_type`, `visual_concept`, `character_ids`, `main_subject`, `action`, `environment`, `time_of_day`, `lighting`, `emotion`, `shot`, `camera`, `composition`, `key_props`, `same_scene_as_previous`, `text_in_image: false`). Planned 12 lines at a time in order, so shot variety and continuity carry across the video. Shot, emotion, place and characters show as chips under each line.
4. **Prompt engineering**: each structured scene becomes a detailed photorealistic prompt, then the permanent `GLOBAL_STYLE` and `AVOID` layers are appended.
5. **Quality control** (step 3): after each image, Claude looks at it (Runware `inputs.images`) and checks realism, subject, action, place, text, faces and hands, and composition. Images under the pass score are regenerated with a corrected prompt (up to 1 or 2 times); the best attempt is kept and each card shows its score. If the account can't check images, generation continues without checks and says so.
*Direct: one prompt per line* keeps the earlier behaviour.

**How a script becomes prompts**
1. Enter the **Video title** and paste the script (step 1). Claude reads the title and the whole script first.
2. **Split by scene** (default): a new image starts where a line ends or a new situation begins (new place, person, time, action, feeling or idea).
3. Each prompt is written from the title, the full script, the two lines before and the next line, so the images follow the story.
4. Prompts are **Very detailed** (200 to 250 words) by default.

**Hyper-real prompt writing**
- The default prompt writer is now the *Runware AI photographer*. It sends the full photographer brief (`claudeSystem()`) to the text model approved in /admin, so no Anthropic key is needed. *Runware Prompt Enhance* is still there as the fast, short option.
- Every prompt is built as a ten-layer shot description: shot and framing, subject, wardrobe, action and micro-expression, hands and props, setting in three depth layers (foreground, midground, background), time, weather and air, light physics (source, direction, hard or soft, colour temperature, shadows, catchlight, bounce), camera and optics (lens, aperture, distance, focus), and real-photo texture.
- Prompts are composed for the chosen **Frame shape** (16:9, 9:16, 1:1 or 4:3) instead of always assuming vertical.
- "Hyper-real" means more physical facts, not hype words. Words like *8k* or *hyper-realistic* are still banned because they make FLUX images look fake.

**Prompt strength** (step 2): Standard (70 to 100 words), Rich (110 to 150), Maximum (160 to 210, default) or Ultra hyper-real (200 to 250).

**Strengthen before generating** (step 3, on by default): right before images are generated, any weak prompt (empty, template, under about 90 words, or missing light, lens and texture details) is rebuilt by the AI photographer. It keeps the prompt's idea. If the AI isn't available, `boostPrompt()` adds the `REALISM_LAYERS` (composition, skin, materials, light, lens) when the prompt is sent, so a thin prompt never reaches the image model.

To change the look for the whole team, edit `MASTER_LOOK`, `STYLES`, `STYLE_TAGS`, `REALISM_LAYERS` and `claudeSystem()` at the top of the "STEP 2: prompts" section.
