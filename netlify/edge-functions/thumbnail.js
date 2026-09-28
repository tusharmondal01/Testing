// Serves the thumbnail generator HTML that the admin uploaded at /admin.
import { openStore, readSettings, dashboardView } from "../lib/shared.js";

const page = (title, body) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html{background:#040804;color:#EEF5EC;font-family:system-ui,sans-serif}body{min-height:100vh;display:grid;place-items:center;margin:0;
background:radial-gradient(900px 520px at 50% -10%,#1d6e17,#0c2f0c 40%,transparent 72%)}main{text-align:center;max-width:460px;padding:24px}
h1{font-weight:400;font-size:2.2rem;letter-spacing:-.03em;margin:0 0 10px}p{color:#8E9E8B}a{display:inline-block;margin-top:18px;padding:11px 20px;border-radius:999px;background:#F1F6EE;color:#08120A;text-decoration:none;font-weight:600}</style>
</head><body><main>${body}</main></body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

const BACK = `<a href="/" style="position:fixed;left:16px;bottom:16px;z-index:2147483647;display:inline-flex;align-items:center;gap:8px;padding:9px 16px 9px 12px;border-radius:999px;background:rgba(14,22,14,.72);color:#EEF5EC;border:1px solid rgba(255,255,255,.14);font:500 13px/1 system-ui,sans-serif;text-decoration:none;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)" aria-label="Back to the Craftush dashboard"><span style="width:7px;height:7px;border-radius:50%;background:#7CFF2E;box-shadow:0 0 10px #7CFF2E"></span>Dashboard</a>`;

export default async () => {
  const store = openStore();
  const d = dashboardView(await readSettings(store));
  if (!d.cards.thumbnail.enabled) return page("Turned off", `<h1>Turned off</h1><p>The admin has turned the thumbnail generator off.</p><a href="/">Back to dashboard</a>`);
  const html = d.thumb ? await store.get("tool-thumbnail", { type: "text" }) : null;
  if (!html) return page("Not set up yet", `<h1>Not set up yet</h1><p>The admin hasn't uploaded the thumbnail generator yet.</p><a href="/">Back to dashboard</a>`);
  const withBack = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, BACK + "</body>") : html + BACK;
  return new Response(withBack, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/thumbnail" };
