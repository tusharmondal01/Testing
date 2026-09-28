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

**Prompt strength** (step 2): Standard (70 to 100 words), Rich (110 to 150, default) or Maximum (160 to 210).

To change the look for the whole team, edit `MASTER_LOOK`, `STYLES`, `STYLE_TAGS` and `claudeSystem()` at the top of the "STEP 2: prompts" section.
