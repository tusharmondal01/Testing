// Relay: the browser sends image/prompt tasks here, the server adds the secret
// Runware key and forwards them. The key never reaches anyone's browser.
import { openStore, json, fail, safeEqual, readSettings, readUsage, activeKey, RUNWARE_URL, VERSION, textModel, textBackup, textModels, textList, cleanMessage, MODEL_ID } from "../lib/shared.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Errors that mean "try the next text model": outages, and a model ID Runware doesn't accept.
const OUTAGE = /unavailable|bad gateway|gateway|timed? ?out|overloaded|temporar|internal server|capacity|502|503|504|invalid value for 'model'|valid text model|model not found|unknown model/i;
const isOutage = (status, data) =>
  status >= 500 || (Array.isArray(data && data.errors) && data.errors.some((e) => OUTAGE.test(String(e.message || "") + " " + String(e.code || ""))));

async function forward(apiKey, tasks) {
  try {
    const res = await fetch(RUNWARE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ taskType: "authentication", apiKey }, ...tasks]),
    });
    let data;
    try { data = await res.json(); } catch { data = { errors: [{ message: "Runware answered with HTTP " + res.status }] }; }
    return { status: res.status, data };
  } catch {
    return { status: 502, data: { errors: [{ message: "Couldn't reach Runware. Try again in a moment." }] } };
  }
}

const ALLOWED = new Set(["imageInference", "promptEnhance", "textInference", "modelSearch"]);
const SEARCH_KEYS = ["search", "tags", "category", "type", "architecture", "conditioning", "featured", "limit", "offset", "taskUUID"];
const MAX_TASKS = 12;

export default async (req) => {
  const store = openStore();
  const settings = await readSettings(store);
  const apiKey = activeKey(settings);
  const code = settings.teamCode || "";

  // GET: tells the page whether a team code is needed and whether a key is set.
  if (req.method === "GET") return json({ configured: !!apiKey, codeRequired: !!code, version: VERSION, textModel: textModel(settings), textModels: textList(settings) });
  if (req.method !== "POST") return fail("Method not allowed", 405);

  if (code && !safeEqual(req.headers.get("x-team-code") || "", code))
    return fail("Wrong team access code. Ask your admin for the current code.", 401);
  if (!apiKey) return fail("The admin hasn't added a Runware API key yet. Open /admin to add it.", 503);

  let tasks;
  try { tasks = await req.json(); } catch { return fail("Invalid request", 400); }
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > MAX_TASKS)
    return fail(`Send between 1 and ${MAX_TASKS} tasks per request.`, 400);
  if (tasks.some((t) => !t || typeof t !== "object" || !ALLOWED.has(t.taskType)))
    return fail("Only image generation, prompt, script-splitting and model search tasks are allowed.", 400);
  const clean = tasks.map(({ apiKey: _ignored, ...t }) => {
    if (t.taskType === "modelSearch") {
      // Read-only catalogue search: public models only, small pages.
      const q = { taskType: "modelSearch", visibility: "public" };
      for (const k of SEARCH_KEYS) if (t[k] !== undefined) q[k] = t[k];
      q.limit = Math.max(1, Math.min(50, Number(q.limit) || 24));
      q.offset = Math.max(0, Number(q.offset) || 0);
      return q;
    }
    if (t.taskType !== "textInference") return t;
    // Text tasks always use the model chosen in /admin, answer in one reply, and can't call tools.
    const { tools: _t, toolChoice: _c, webhookURL: _w, ...rest } = t;
    const s = rest.settings && typeof rest.settings === "object" ? { ...rest.settings } : {};
    s.maxTokens = Math.min(Number(s.maxTokens) || 4000, 8000);
    // The team may pick any model the admin approved; anything else falls back to the default.
    // The team may pick any Runware text model ID (Claude, GPT, Gemini...); it runs on the same Runware key.
    // If Runware rejects it, the loop below falls back to the models approved in /admin.
    const model = MODEL_ID.test(String(rest.model || "")) ? rest.model : textModel(settings);
    return { ...rest, model, deliveryMethod: "sync", settings: s };
  });

  let result, usedModel = null;
  if (clean.every((t) => t.taskType === "textInference")) {
    // Text: if the main model has an outage, retry once, then switch to the backup model.
    const started = Date.now(), tried = [];
    const chosen = clean[0].model, list = textModels(settings);
    const order = [chosen, ...list.filter((m) => m !== chosen)];
    outer: for (const [mi, model] of order.entries()) {
      for (let attempt = 0; attempt < (mi === 0 ? 2 : 1); attempt++) {
        if (tried.length && Date.now() - started > 22000) break outer;
        if (attempt) await sleep(1200);
        const tasksForModel = clean.map((t) => ({
          ...t, model, taskUUID: tried.length ? crypto.randomUUID() : t.taskUUID,
          settings: { ...t.settings, maxTokens: mi ? 8000 : t.settings.maxTokens },
        }));
        result = await forward(apiKey, tasksForModel);
        usedModel = model; tried.push(model);
        if (!isOutage(result.status, result.data)) break outer;
        const msg = JSON.stringify((result.data && result.data.errors) || "");
        if (/invalid value for 'model'|valid text model|model not found|unknown model/i.test(msg)) break; // no point retrying a rejected ID
      }
    }
    if (isOutage(result.status, result.data)) {
      const names = [...new Set(tried)];
      const last = cleanMessage(((result.data || {}).errors || [{}])[0].message);
      result.data = { errors: [{ message: `No text model worked (${names.join(", ")}). Runware said: ${last || "unavailable"}. Try again later, or add another text model in /admin.` }] };
      result.status = 503;
    }
  } else {
    result = await forward(apiKey, clean);
  }
  const upstream = { status: result.status };
  const data = result.data || {};
  if (usedModel) data.model = usedModel;
  // Drop the authentication result (with or without a taskType) before it reaches the browser.
  if (Array.isArray(data.data)) data.data = data.data.filter((d) => d && d.taskType !== "authentication" && !("connectionSessionUUID" in d));
  if (Array.isArray(data.errors)) data.errors = data.errors.map(({ apiKey: _k, ...e }) => ({ ...e, message: cleanMessage(e.message) }));

  // Usage totals for the admin page (best effort, never blocks the reply).
  try {
    const items = Array.isArray(data.data) ? data.data : [];
    const images = items.filter((d) => d.taskType === "imageInference" && (d.imageBase64Data || d.imageURL)).length;
    const prompts = items.filter((d) => d.taskType === "promptEnhance" || d.taskType === "textInference").length;
    const cost = items.reduce((s, d) => s + (typeof d.cost === "number" ? d.cost : 0), 0);
    if (images || prompts || cost) {
      const usage = await readUsage(store);
      usage.images += images; usage.prompts += prompts; usage.cost += cost;
      usage.last = new Date().toISOString();
      await store.setJSON("usage", usage);
    }
  } catch { /* ignore */ }

  return json(data, upstream.status);
};

export const config = { path: "/api/runware" };
