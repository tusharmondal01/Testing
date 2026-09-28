# Runware Script Director for ComfyUI

Turns a **whole script** into **60–70 photorealistic images** in one ComfyUI workflow. It runs the Visual Director pipeline
from the "Runware Bulk Image Generation" plan, using **only a Runware API key**: no local GPU and no model downloads.

```
Runware API Key → 1 Script → Scenes → 2 Character & Style Bible → 3 Visual Director Plan → 4 Photoreal Prompt Writer → 5 Generate Images + Photo Check
```

| Step | What it does | Model (on Runware) |
|---|---|---|
| 1 Script → Scenes | Splits where a new meaningful visual idea starts (one idea = one image), aiming softly for 60–70. The original words are never changed. | Claude Opus 5.5 |
| 2 Character & Style Bible | Casts 1–5 recurring people with fixed looks and clothing, plus the topic and setting | Claude Opus 5.5 |
| 3 Visual Director Plan | Plans every scene as structured data: concept, subject, action, place, emotion, shot, camera and composition. Shots vary and continuity carries across the video. | Claude Opus 5.5 |
| 4 Photoreal Prompt Writer | Turns each scene into a detailed prompt, then adds the permanent photoreal style layer and the "avoid" list (no cartoon, CGI, text…) | Claude Opus 5.5 |
| 5 Generate Images + Photo Check | Makes each image, has Claude look at it (realism, subject, action, place, text, faces and hands) and regenerates failures with a corrected prompt | FLUX.2 [max] for images, Claude Opus 5.5 for the check |

## Models

- **Text and photo check: Claude Opus 5.5** (`anthropic:claude@opus-5.5`), Anthropic's most capable model on Runware.
  If Runware refuses that id on your account, the nodes switch to **Claude Sonnet 5** (`anthropic:claude@sonnet-5`),
  then Claude Opus 4.8. The console says which model was used.
- **Images: FLUX.2 [max]** (`bfl:7@1`), the top photorealism tier in Runware's catalog. It renders true 9:16 at 1088×1920.
  The dropdown also has **GPT-Image-2.5 Sunburst** (`openai:gpt-image@2.5-sunburst`) and **GPT Image 2** (`openai:gpt-image@2`).
  If a model refuses a size, 1024×1536 is used and the image is centre-cropped to your frame.
- Each node has a *custom model* box for any other Runware model id (`creator:family@version`).

## Install on ComfyUI Desktop

1. Close ComfyUI Desktop.
2. Copy the whole `ComfyUI-Runware-ScriptDirector` folder into ComfyUI's `custom_nodes` folder. It is inside the folder you
   chose when you installed ComfyUI Desktop (by default `Documents\ComfyUI\custom_nodes` on Windows, `~/Documents/ComfyUI/custom_nodes` on Mac).
3. **Add your Runware key** (choose one):
   - **Safest:** create a file named `runware_api_key.txt` in the `ComfyUI-Runware-ScriptDirector` folder and paste the key into it.
   - Or paste it into the *Runware API Key* node. The key is then saved inside the workflow file, so don't share that file.
4. Start ComfyUI Desktop. Nothing needs to be installed: the nodes use only what ComfyUI already has.
5. Drag `workflows/Runware_Script_to_Images.json` onto the ComfyUI canvas.

## Use

1. Paste the whole script into node **1** and fill in the video title. Set the frame (9:16 by default) and the image range (60–70 by default).
2. **Review before paying for images (recommended):** click node **5** and press **Ctrl+B** to bypass it, then press **Run**.
   Each node shows its result: the scenes, the character bible, the scene plan and every prompt.
3. Press **Ctrl+B** on node 5 again and press **Run**. Only the images are made; the text steps come from ComfyUI's cache.
4. The images are saved to `ComfyUI/output/<output_folder>/`:
   - `scene_001.jpg`, `scene_002.jpg`, … in script order;
   - `scenes.csv`: narration, photo-check score and prompt for each image (opens in Excel);
   - `manifest.json` and `project.json`: the full plan. The API key is never written to these files.

### Fixing things

- **Redo some images:** type them in node 5 → `only_scenes`, e.g. `4, 9-11`. Only those are regenerated.
- **Change a prompt:** in node 4 → `prompt_overrides`, one per line, e.g. `12: Create a photorealistic cinematic image of …`.
- **Fix a character's look:** copy the text shown on node 2 into `bible_override`, edit it, and run again.
- **Get a fresh plan or fresh prompts:** change the `seed` on node 3 or node 4.
- **Resume after a stop or crash:** keep `skip_existing` on. Images whose prompt hasn't changed are reused, so you are never charged twice.
- **Stronger face consistency:** turn on `character_references` in node 5. It makes one reference portrait per recurring
  character (`cast_<id>.jpg`) and passes it with every scene that character appears in. If the image model doesn't accept
  reference images, generation continues without them and the console says so.

### Cost

Every node reports what it spent (Runware returns the cost of each request). For a 70-image video, the text steps plus
the photo checks with Claude Opus 5.5 come to roughly $1–3 (Sonnet 5 costs less). Images depend on the model and size: for
FLUX.2 [max] at 1088×1920 (2.1 megapixels), Runware lists $0.07 for the first megapixel plus $0.03 for each additional one,
so about $0.10–0.13 per image. Each regeneration by the photo check costs one more image.
To spend less, lower `max_retries`, turn off `quality_check`, or pick the *Standard* resolution.

## Notes

- Scripts can be in Hindi, Hinglish or English. People and places default to contemporary India unless the script says otherwise.
- Node 5 also outputs the images as an `IMAGE` batch (plus a `report` string), so you can connect it to video nodes.
  A 70-image batch at 1088×1920 uses about 1.8 GB of RAM.
- The prompts, the style layer and the photo check are the same as the Craftush website's Visual Director
  (`public/visuals/director.js`), so both tools produce the same look.
