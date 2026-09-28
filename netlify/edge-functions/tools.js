// Public dashboard info, and the ComfyUI workflow for the Idea to Video page.
import { openStore, json, fail, readSettings, dashboardView, teamCodeOk } from "../lib/shared.js";

export default async (req) => {
  if (req.method !== "GET") return fail("Method not allowed", 405);
  const view = new URL(req.url).searchParams.get("view");
  const store = openStore();
  const settings = await readSettings(store);

  if (view === "dashboard") {
    const d = dashboardView(settings);
    return json({ cards: d.cards, available: d.available });
  }

  if (view === "comfy") {
    if (!(await teamCodeOk(req, settings))) return fail("Wrong team access code. Ask your admin for the current code.", 401);
    const d = dashboardView(settings);
    if (!d.cards.comfy.enabled) return fail("Idea to Video is turned off by the admin.", 403);
    const workflow = await store.get("comfy-workflow", { type: "json" });
    const meta = await store.get("comfy-meta", { type: "json" });
    if (!workflow || !meta) return fail("The admin hasn't uploaded a ComfyUI workflow yet.", 404);
    const byKey = Object.fromEntries((meta.fields || []).map((f) => [f.key, f]));
    const exposed = (meta.exposed || []).filter((e) => byKey[e.key]).map((e) => ({ ...byKey[e.key], label: e.label || "" }));
    return json({
      workflow, exposed,
      promptKey: meta.promptKey || "", negKey: meta.negKey || "",
      server: meta.server || "http://127.0.0.1:8000",
      randomSeed: meta.randomSeed !== false,
      title: d.cards.comfy.title,
    });
  }

  return fail("Unknown view", 400);
};

export const config = { path: "/api/tools" };
