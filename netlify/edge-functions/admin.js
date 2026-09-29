// Admin API for craftush.netlify.app/admin. Every request must carry the admin
// password, which lives only in the ADMIN_PASSWORD environment variable on Netlify.
import {
  openStore, json, fail, safeEqual, env, readSettings, readUsage, activeKey, checkKey,
  VERSION, DEFAULT_CARDS, dashboardView, analyzeWorkflow, RUNWARE_URL, DEFAULT_TEXT_MODEL, textModel, DEFAULT_TEXT_BACKUP, textBackup, cleanMessage, textList, MODEL_ID,
} from "../lib/shared.js";

const MAX_UPLOAD = 8 * 1024 * 1024; // 8 MB

const view = (settings, usage, comfyMeta) => {
  const key = activeKey(settings);
  return {
    key: {
      set: !!key,
      last4: key ? key.slice(-4) : "",
      source: settings.runwareKey ? "admin" : key ? "environment" : "none",
      updated: settings.keyUpdated || null,
    },
    teamCode: settings.teamCode || "",
    textModel: textModel(settings),
    textModelDefault: DEFAULT_TEXT_MODEL,
    textBackup: textBackup(settings),
    textBackupDefault: DEFAULT_TEXT_BACKUP,
    textList: textList(settings),
    usage,
    dashboard: dashboardView(settings),
    comfy: comfyMeta || null,
    version: VERSION,
  };
};

const INVALID_MODEL = /invalid value for 'model'|valid text model|model not found|unknown model/i;
const IMAGE_CATEGORY = /^(lora|lycoris|checkpoint|controlnet|vae|embeddings?|upscaler|ipadapter|image|video|audio)$/i;
const IMAGE_ARCH = /sd|sdxl|flux|pony|illustrious|hidream|wan|hunyuan|ltx|kolors|auraflow|qwen.?image|seedream|imagen|gpt.?image/i;

export default async (req) => {
  if (req.method !== "POST") return fail("Method not allowed", 405);
  const password = env("ADMIN_PASSWORD");
  if (!password)
    return fail("ADMIN_PASSWORD isn't set yet. Add it in your host’s environment variables (Netlify: Project configuration → Environment variables; Vercel: Settings → Environment Variables), then redeploy.", 500);
  if (!safeEqual(req.headers.get("x-admin-password") || "", password)) {
    await new Promise((r) => setTimeout(r, 900)); // slows down password guessing
    return fail("Wrong password", 401);
  }

  const body = await req.json().catch(() => ({}));
  const store = openStore();
  const settings = await readSettings(store);
  let usage = await readUsage(store);
  let comfyMeta = await store.get("comfy-meta", { type: "json" });
  const dash = () => (settings.dashboard = settings.dashboard || {});
  const reply = () => json(view(settings, usage, comfyMeta));

  switch (body.action) {
    case "get":
      return reply();

    case "saveKey": {
      const key = String(body.key || "").trim();
      if (!key) return fail("Paste a Runware key first.", 400);
      const check = await checkKey(key);
      if (!check.ok) return fail("Runware didn't accept that key: " + check.message, 400);
      settings.runwareKey = key;
      settings.keyUpdated = new Date().toISOString();
      await store.setJSON("settings", settings);
      return reply();
    }

    case "removeKey":
      delete settings.runwareKey;
      delete settings.keyUpdated;
      await store.setJSON("settings", settings);
      return reply();

    case "testKey": {
      const key = activeKey(settings);
      if (!key) return fail("No key saved yet.", 400);
      const check = await checkKey(key);
      return check.ok ? json({ ok: true }) : fail(check.message, 400);
    }

    case "saveCode":
      settings.teamCode = String(body.code || "").trim().slice(0, 64);
      await store.setJSON("settings", settings);
      return reply();

    case "saveTextModel": {
      const ID = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
      const m = String(body.model || "").trim(), b = String(body.backup || "").trim();
      for (const v of [m, b]) if (v && !ID.test(v)) return fail("A Runware model ID looks like provider:model@version, for example deepseek:v4@flash", 400);
      if (m) settings.textModel = m; else delete settings.textModel;
      if (b) settings.textBackup = b; else delete settings.textBackup;
      await store.setJSON("settings", settings);
      return reply();
    }

    case "saveTextList": {
      const list = (Array.isArray(body.list) ? body.list : [])
        .map((m) => ({ id: String((m && m.id) || "").trim(), name: String((m && m.name) || "").trim().slice(0, 60) }))
        .filter((m) => m.id);
      const bad = list.find((m) => !MODEL_ID.test(m.id));
      if (bad) return fail(`"${bad.id}" isn't a Runware model ID. They look like provider:model@version.`, 400);
      if (!list.length) return fail("Keep at least one text model in the list.", 400);
      const seen = new Set();
      settings.textList = list.filter((m) => !seen.has(m.id) && seen.add(m.id)).slice(0, 20);
      settings.textModel = settings.textList[0].id;
      delete settings.textBackup;
      await store.setJSON("settings", settings);
      return reply();
    }

    case "searchModels": {
      // Browse Runware's public model catalogue (read-only).
      const key = activeKey(settings);
      if (!key) return fail("Save a Runware key first.", 400);
      const q = { taskType: "modelSearch", taskUUID: crypto.randomUUID(), visibility: "public", limit: Math.max(1, Math.min(50, Number(body.limit) || 30)), offset: Math.max(0, Number(body.offset) || 0) };
      for (const k of ["search", "category", "type", "architecture", "featured"]) if (body[k] !== undefined && body[k] !== "") q[k] = body[k];
      try {
        const res = await fetch(RUNWARE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ taskType: "authentication", apiKey: key }, q]) });
        const data = await res.json().catch(() => ({}));
        if (data.errors && data.errors.length) return fail(cleanMessage(data.errors[0].message) || "Runware couldn't search models.", 400);
        const hit = (data.data || []).find((d) => d.taskType === "modelSearch") || {};
        const all = hit.results || [];
        // Text models only: LoRAs, checkpoints, ControlNets and other image models can't write text.
        const results = body.textOnly ? all.filter((m) => !IMAGE_CATEGORY.test(String(m.category || "")) && !IMAGE_ARCH.test(String(m.architecture || ""))) : all;
        return json({ results, total: body.textOnly ? results.length : hit.totalResults ?? all.length, hidden: all.length - results.length });
      } catch { return fail("Couldn't reach Runware from the server.", 502); }
    }

    case "testTextModel": {
      const key = activeKey(settings);
      if (!key) return fail("Save a Runware key first.", 400);
      const wanted = String(body.model || "").trim() || textModel(settings);
      if (!MODEL_ID.test(wanted)) return fail(`"${wanted}" isn't a Runware model ID. Text model IDs look like provider:model@version, for example anthropic:claude@sonnet-5.`, 400);
      // Runware spells versions either way (sonnet-5.5 / sonnet-5-5), so a rejected ID is retried with the other spelling.
      const at = wanted.indexOf("@"), ver = wanted.slice(at + 1);
      const alts = [wanted, wanted.slice(0, at + 1) + ver.replace(/(\d)\.(\d)/g, "$1-$2"), wanted.slice(0, at + 1) + ver.replace(/(\d)-(\d)/g, "$1.$2")];
      const tries = [...new Set(alts)];
      let lastMsg = "", model = wanted;
      try {
        for (model of tries) {
          const res = await fetch(RUNWARE_URL, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify([{ taskType: "authentication", apiKey: key }, {
              taskType: "textInference", taskUUID: crypto.randomUUID(), model, deliveryMethod: "sync", includeCost: true,
              messages: [{ role: "user", content: "Reply with the single word OK." }], settings: { maxTokens: 20 },
            }]),
          });
          const data = await res.json().catch(() => ({}));
          if (data.errors && data.errors.length) {
            lastMsg = cleanMessage(data.errors[0].message || "error");
            if (INVALID_MODEL.test(lastMsg)) continue;
            return fail(model + ": " + lastMsg, 400);
          }
          const t = (data.data || []).find((d) => d.taskType === "textInference");
          if (!t) return fail(model + ": Runware returned HTTP " + res.status + " without a text reply.", 400);
          return json({ ok: true, model, reply: String(t.text || "").slice(0, 80), cost: t.cost ?? null });
        }
      } catch { return fail("Couldn't reach Runware from the server.", 502); }
      return fail(`Runware doesn't offer "${wanted}" as a text model (${lastMsg}). Image models and LoRAs (civitai:…, runware:… image IDs) can't write text. Copy the exact text model ID from its page on runware.ai/models, for example anthropic:claude@sonnet-5.`, 400);
    }

    case "resetUsage":
      usage = { images: 0, prompts: 0, cost: 0, since: new Date().toISOString() };
      await store.setJSON("usage", usage);
      return reply();

    // ----- dashboard cards -----
    case "saveCard": {
      const id = String(body.id || "");
      if (!DEFAULT_CARDS[id]) return fail("Unknown card.", 400);
      const cards = (dash().cards = dash().cards || {});
      cards[id] = {
        title: String(body.title || "").trim().slice(0, 60) || DEFAULT_CARDS[id].title,
        desc: String(body.desc || "").trim().slice(0, 220) || DEFAULT_CARDS[id].desc,
        enabled: body.enabled !== false,
      };
      await store.setJSON("settings", settings);
      return reply();
    }

    case "uploadThumb": {
      const html = String(body.html || "");
      if (!html.trim()) return fail("That file is empty.", 400);
      if (html.length > MAX_UPLOAD) return fail("That file is larger than 8 MB.", 400);
      if (!/<html|<body|<script|<div|<!doctype/i.test(html)) return fail("That doesn't look like an HTML file.", 400);
      await store.set("tool-thumbnail", html);
      dash().thumb = { fileName: String(body.name || "thumbnail.html").slice(0, 120), size: html.length, updated: new Date().toISOString() };
      await store.setJSON("settings", settings);
      return reply();
    }

    case "removeThumb":
      await store.set("tool-thumbnail", "");
      delete dash().thumb;
      await store.setJSON("settings", settings);
      return reply();

    // ----- ComfyUI workflow -----
    case "uploadWorkflow": {
      const text = String(body.json || "");
      if (text.length > MAX_UPLOAD) return fail("That file is larger than 8 MB.", 400);
      let wf;
      try { wf = JSON.parse(text); } catch { return fail("That file isn't valid JSON.", 400); }
      let info;
      try { info = analyzeWorkflow(wf); } catch (e) { return fail(e.message, 400); }
      await store.setJSON("comfy-workflow", wf);
      const keep = comfyMeta || {};
      const known = new Set(info.fields.map((f) => f.key));
      comfyMeta = {
        fields: info.fields,
        nodeCount: info.nodeCount,
        promptKey: known.has(keep.promptKey) ? keep.promptKey : info.promptKey,
        negKey: known.has(keep.negKey) ? keep.negKey : info.negKey,
        exposed: (keep.exposed || []).filter((e) => known.has(e.key)),
        server: keep.server || "http://127.0.0.1:8000",
        randomSeed: keep.randomSeed !== false,
      };
      await store.setJSON("comfy-meta", comfyMeta);
      dash().comfyFile = { fileName: String(body.name || "workflow.json").slice(0, 120), size: text.length, nodes: info.nodeCount, updated: new Date().toISOString() };
      await store.setJSON("settings", settings);
      return reply();
    }

    case "saveComfy": {
      if (!comfyMeta) return fail("Upload a workflow first.", 400);
      const known = new Set(comfyMeta.fields.map((f) => f.key));
      const promptKey = String(body.promptKey || "");
      if (!known.has(promptKey)) return fail("Choose which text box receives the idea.", 400);
      const server = String(body.server || "").trim().replace(/\/+$/, "");
      if (server && !/^https?:\/\/[^\s]+$/i.test(server)) return fail("The ComfyUI address should start with http:// or https://", 400);
      comfyMeta.promptKey = promptKey;
      comfyMeta.negKey = known.has(body.negKey) ? String(body.negKey) : "";
      comfyMeta.exposed = (Array.isArray(body.exposed) ? body.exposed : [])
        .filter((e) => e && known.has(e.key) && e.key !== promptKey)
        .slice(0, 12)
        .map((e) => ({ key: String(e.key), label: String(e.label || "").slice(0, 60) }));
      comfyMeta.server = server || "http://127.0.0.1:8000";
      comfyMeta.randomSeed = body.randomSeed !== false;
      await store.setJSON("comfy-meta", comfyMeta);
      return reply();
    }

    case "removeWorkflow":
      await store.setJSON("comfy-workflow", null);
      await store.setJSON("comfy-meta", null);
      comfyMeta = null;
      delete dash().comfyFile;
      await store.setJSON("settings", settings);
      return reply();

    default:
      return fail("Unknown action", 400);
  }
};

export const config = { path: "/api/admin" };
