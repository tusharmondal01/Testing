// Shows each Script Director node's text result (scenes, bible, plan, prompts, report) in a read-only box on the node.
import { app } from "../../scripts/app.js";

const NAME = "sd_result";

function showText(node, text) {
  let w = node.widgets && node.widgets.find((x) => x.name === NAME);
  if (!w) {
    const el = document.createElement("textarea");
    el.readOnly = true;
    el.spellcheck = false;
    el.style.cssText = "width:100%;height:100%;box-sizing:border-box;resize:none;font:12px/1.45 monospace;" +
      "background:rgba(0,0,0,.25);color:var(--input-text,#ddd);border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:6px;";
    w = node.addDOMWidget(NAME, "customtext", el, { serialize: false, hideOnZoom: false, getValue: () => el.value, setValue: (v) => { el.value = v; } });
    w.serialize = false;
    w.element = el;
    const need = node.computeSize()[1] + 160;
    if (node.size[1] < need || node.size[0] < 380) node.setSize([Math.max(node.size[0], 380), Math.max(node.size[1], need)]);
  }
  (w.element || w.inputEl).value = text;
  app.graph && app.graph.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "runware.scriptdirector.showtext",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || !String(nodeData.name || "").startsWith("RunwareSD_")) return;
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      if (onExecuted) onExecuted.apply(this, arguments);
      const t = message && message.text;
      if (!t) return;
      try { showText(this, Array.isArray(t) ? t.join("\n") : String(t)); } catch (e) { console.warn("Script Director text box:", e); }
    };
  },
});
