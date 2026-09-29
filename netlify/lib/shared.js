// Shared helpers for the Craftush edge functions.
import { getStore } from "@netlify/blobs";

// Shown on the admin page so you can confirm which backend version is live.
export const VERSION = "8";

// Text model used for smart script splitting (confirmed in Runware's official SDK examples).
export const DEFAULT_TEXT_MODEL = "deepseek:v4@flash";
export const textModel = (settings) => settings.textModel || DEFAULT_TEXT_MODEL;
// Text models the team may choose, in order. The first is the default; the rest are tried if one fails.
export const DEFAULT_TEXT_BACKUP = "";
export const textBackup = (settings) => settings.textBackup || "";
export const MODEL_ID = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
export function textList(settings) {
  const list = Array.isArray(settings.textList) && settings.textList.length
    ? settings.textList
    : [{ id: textModel(settings), name: "" }, ...(textBackup(settings) ? [{ id: textBackup(settings), name: "" }] : [])];
  const seen = new Set();
  return list.filter((m) => m && MODEL_ID.test(m.id) && !seen.has(m.id) && seen.add(m.id)).map((m) => ({ id: m.id, name: String(m.name || "").slice(0, 60) }));
}
export const textModels = (settings) => textList(settings).map((m) => m.id);
// Error text from Runware can contain a raw HTML error page; keep only readable words.
export const cleanMessage = (m) => String(m || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);

export const RUNWARE_URL = "https://api.runware.ai/v1";

// One private store holds the settings (Runware key, team code) and usage totals.
// On Netlify it is Netlify Blobs. On Vercel (or anywhere else) it is Upstash Redis over its REST API,
// used when UPSTASH_REDIS_REST_URL/TOKEN (or Vercel's KV_REST_API_URL/TOKEN) are set.
export const openStore = () => {
  const url = env("UPSTASH_REDIS_REST_URL") || env("KV_REST_API_URL");
  const token = env("UPSTASH_REDIS_REST_TOKEN") || env("KV_REST_API_TOKEN");
  if (url && token) return redisStore(url.replace(/\/+$/, ""), token);
  return getStore({ name: "craftush", consistency: "strong" });
};

// Minimal Netlify-Blobs-compatible store on Upstash Redis. Large values (the thumbnail HTML,
// ComfyUI workflows) are split into chunks so they stay under Redis request limits.
const CHUNK = 700 * 1024;
function redisStore(url, token) {
  const call = async (cmd) => {
    const res = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(cmd) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error("Storage error: " + (data.error || res.status));
    return data.result;
  };
  const key = (k) => "craftush:" + k;
  async function getText(k) {
    const v = await call(["GET", key(k)]);
    if (v === null || v === undefined) return null;
    const m = /^__chunks__:(\d+)$/.exec(v);
    if (!m) return v;
    const parts = await call(["MGET", ...Array.from({ length: +m[1] }, (_, i) => key(k) + ":" + i)]);
    return parts.join("");
  }
  async function setText(k, text) {
    text = String(text ?? "");
    if (text.length <= CHUNK) return call(["SET", key(k), text]);
    const n = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < n; i++) await call(["SET", key(k) + ":" + i, text.slice(i * CHUNK, (i + 1) * CHUNK)]);
    return call(["SET", key(k), "__chunks__:" + n]);
  }
  return {
    async get(k, opts = {}) {
      const t = await getText(k);
      if (t === null) return null;
      if (opts.type === "json") { try { return JSON.parse(t); } catch { return null; } }
      return t;
    },
    set: (k, v) => setText(k, v),
    setJSON: (k, v) => setText(k, JSON.stringify(v)),
  };
}

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const fail = (message, status) => json({ errors: [{ message }] }, status);

// Constant-time comparison so passwords/codes can't be guessed by timing.
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export const env = (name) => {
  try { if (typeof Netlify !== "undefined") return Netlify.env.get(name) || ""; } catch { /* not on Netlify */ }
  try { return (typeof process !== "undefined" && process.env && process.env[name]) || ""; } catch { return ""; }
};

export async function readSettings(store) {
  return (await store.get("settings", { type: "json" })) || {};
}

export async function readUsage(store) {
  return (await store.get("usage", { type: "json" })) ||
    { images: 0, prompts: 0, cost: 0, since: new Date().toISOString() };
}

// The key saved in /admin wins; a RUNWARE_API_KEY environment variable is the fallback.
export const activeKey = (settings) => settings.runwareKey || env("RUNWARE_API_KEY");

// Checks a Runware key with an authentication-only request (free, generates nothing).
export async function checkKey(apiKey) {
  try {
    const res = await fetch(RUNWARE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ taskType: "authentication", apiKey }]),
    });
    const data = await res.json().catch(() => ({}));
    // Runware reports a bad key as an error; a successful reply without errors means the key works.
    if (data.errors && data.errors.length) return { ok: false, message: data.errors[0].message || "Runware rejected the key" };
    if (data.error) return { ok: false, message: String(data.error.message || data.error) };
    return res.ok ? { ok: true } : { ok: false, message: "Runware returned HTTP " + res.status };
  } catch {
    return { ok: false, message: "Couldn't reach Runware from the server" };
  }
}

// ---------- Dashboard ----------
export const DEFAULT_CARDS = {
  thumbnail: { title: "Thumbnail Generator", desc: "Design scroll-stopping thumbnails for every video.", enabled: true },
  visuals: { title: "Stunning Visuals", desc: "Turn a script into one hyper-realistic image per sentence, timed on a Premiere Pro timeline.", enabled: true },
  comfy: { title: "Idea to Video", desc: "Describe an idea and your ComfyUI workflow turns it into a video.", enabled: true },
};

export function dashboardView(settings) {
  const d = settings.dashboard || {};
  const cards = {};
  for (const id of Object.keys(DEFAULT_CARDS)) cards[id] = { ...DEFAULT_CARDS[id], ...((d.cards || {})[id] || {}) };
  return {
    cards,
    available: { thumbnail: !!d.thumb, visuals: true, comfy: !!d.comfyFile },
    thumb: d.thumb || null,
    comfyFile: d.comfyFile || null,
  };
}

// Reads a ComfyUI workflow saved with "Export (API)" and lists the values the team could change.
export function analyzeWorkflow(wf) {
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) throw new Error("That file isn't a ComfyUI workflow.");
  if (Array.isArray(wf.nodes) && Array.isArray(wf.links))
    throw new Error("This is the regular workflow format. In ComfyUI, use Workflow → Export (API) and upload that file instead.");
  const nodes = Object.entries(wf).filter(([, n]) => n && typeof n === "object" && typeof n.class_type === "string" && n.inputs && typeof n.inputs === "object");
  if (!nodes.length) throw new Error("No ComfyUI nodes found. Export the workflow with Workflow → Export (API).");
  const fields = [];
  for (const [id, n] of nodes) {
    for (const [input, value] of Object.entries(n.inputs)) {
      if (Array.isArray(value)) continue; // a connection to another node
      const type = typeof value === "string" ? "text" : typeof value === "number" ? "number" : typeof value === "boolean" ? "bool" : null;
      if (!type) continue;
      fields.push({ key: id + "." + input, node: id, input, type, value, title: (n._meta && n._meta.title) || n.class_type, cls: n.class_type });
    }
  }
  const texts = fields.filter((f) => f.type === "text");
  const promptish = (f) => /text|prompt/i.test(f.input);
  const guessPrompt =
    texts.find((f) => promptish(f) && /positive|prompt|idea/i.test(f.title) && !/negative/i.test(f.title)) ||
    texts.filter((f) => promptish(f) && !/negative/i.test(f.title)).sort((a, b) => String(b.value).length - String(a.value).length)[0] ||
    texts[0];
  const guessNeg = texts.find((f) => /negative/i.test(f.title) && promptish(f));
  return { fields, nodeCount: nodes.length, promptKey: guessPrompt ? guessPrompt.key : "", negKey: guessNeg ? guessNeg.key : "" };
}

export async function teamCodeOk(req, settings) {
  const code = settings.teamCode || "";
  return !code || safeEqual(req.headers.get("x-team-code") || "", code);
}
