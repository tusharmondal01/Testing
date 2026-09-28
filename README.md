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

**Only a Runware key is needed**
Everything (prompt writing and image generation) runs on the Runware key saved in /admin. No Anthropic, OpenAI or Google key is needed.

**Prompt writer model** (step 2): pick which Runware text model writes the prompts: Claude Opus 4.8, GPT-5.5 / 5.4 / Pro / Mini / Nano, Gemini 3.1 Pro / Flash Lite, DeepSeek V4 Flash, any model approved in /admin, or paste any Runware text model ID from runware.ai/models. If Runware rejects an ID, the prompts are written by the /admin text model instead and the status line says so. The choice is remembered in the browser.

**Image model** (step 3): besides FLUX.1 Dev, FLUX.1 Schnell and GPT Image 1, the list is filled live from Runware with every featured image model (grouped by architecture), so each ID is real and current. *Browse all image models* still searches the whole library, and *Paste a model ID* takes any ID.

**Hyper-real prompt writing**
- The default prompt writer is now the *Runware AI photographer*. It sends the full photographer brief (`claudeSystem()`) to the text model approved in /admin, so no Anthropic key is needed. *Runware Prompt Enhance* is still there as the fast, short option.
- Every prompt is built as a ten-layer shot description: shot and framing, subject, wardrobe, action and micro-expression, hands and props, setting in three depth layers (foreground, midground, background), time, weather and air, light physics (source, direction, hard or soft, colour temperature, shadows, catchlight, bounce), camera and optics (lens, aperture, distance, focus), and real-photo texture.
- Prompts are composed for the chosen **Frame shape** (16:9, 9:16, 1:1 or 4:3) instead of always assuming vertical.
- "Hyper-real" means more physical facts, not hype words. Words like *8k* or *hyper-realistic* are still banned because they make FLUX images look fake.

**Prompt strength** (step 2): Standard (70 to 100 words), Rich (110 to 150), Maximum (160 to 210, default) or Ultra hyper-real (200 to 250).

**Strengthen before generating** (step 3, on by default): right before images are generated, any weak prompt (empty, template, under about 90 words, or missing light, lens and texture details) is rebuilt by the AI photographer. It keeps the prompt's idea. If the AI isn't available, `boostPrompt()` adds the `REALISM_LAYERS` (composition, skin, materials, light, lens) when the prompt is sent, so a thin prompt never reaches the image model.

To change the look for the whole team, edit `MASTER_LOOK`, `STYLES`, `STYLE_TAGS`, `REALISM_LAYERS` and `claudeSystem()` at the top of the "STEP 2: prompts" section.
