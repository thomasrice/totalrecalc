// Toasts, the keyboard help, and the right-click menu.

import type { App } from "./main";
import { esc } from "./format";
import { icon } from "./icons";
import { $ } from "./dom";

export function toast(text: string, kind: "info" | "update", action?: { label: string; run: () => void }) {
  const host = $("#toasts");
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.innerHTML = `${kind === "update" ? `<i class="wake-dot"></i>` : ""}<span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  if (action) t.querySelector("button")!.onclick = () => (action.run(), t.remove());
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => {
    t.classList.remove("in");
    setTimeout(() => t.remove(), 300);
  }, action ? 6000 : 3200);
}

export function closeOverlays(app: App): boolean {
  const o = $("#overlay");
  const was = o.classList.contains("on");
  o.className = "";
  o.innerHTML = "";
  if (was) app.grid.focus();
  return was;
}

export function showHelp(app: App) {
  const o = $("#overlay");
  o.className = "on modal-host";
  const rows: [string, string][] = [
    ["Arrows · Ctrl+Arrows · PgUp/PgDn", "Move · jump to edge · page"],
    ["Shift + movement", "Extend the selection"],
    ["Ctrl+PgUp / Ctrl+PgDn", "Previous / next sheet"],
    ["N / Shift+N", "Next / previous change"],
    ["Space", "Pause or resume live updates"],
    ["F5", "Set baseline"],
    ["D · I (or F2)", "Changes · Inspector"],
    ["Enter / Backspace", "Follow first input / go back"],
    ["[ / ]", "Collapse to years / expand quarters"],
    ["Ctrl+C · Ctrl+Shift+C", "Copy · copy with context for your agent"],
    ["Ctrl+K · Ctrl+G · Ctrl+F", "Commands · go to · find"],
    ["Ctrl + scroll · Ctrl 0", "Zoom · reset zoom"],
    ["T", "Light or dark"],
  ];
  o.innerHTML = `<div class="modal help"><h2>Keyboard</h2>${rows.map(([k, v]) => `<div class="kv"><kbd>${k}</kbd><span>${v}</span></div>`).join("")}<p class="muted small">Vim keys (h j k l, g, G) work too.</p></div>`;
  o.onclick = (e) => {
    if (e.target === o) closeOverlays(app);
  };
}

export function showContextMenu(app: App, x: number, y: number) {
  const o = $("#overlay");
  o.className = "on menu-host";
  o.innerHTML = `<div class="menu" style="left:${Math.min(x, innerWidth - 240)}px;top:${Math.min(y, innerHeight - 200)}px">
    <button data-m="copy">${icon("copy")} Copy<kbd>Ctrl C</kbd></button>
    <button data-m="ctx">${icon("sparkle")} Copy with context<kbd>Ctrl Shift C</kbd></button>
    <hr/>
    <button data-m="inspect">${icon("inspect")} Inspect<kbd>I</kbd></button>
    <button data-m="baseline">${icon("flag")} Set baseline<kbd>F5</kbd></button>
  </div>`;
  o.onclick = (e) => {
    const m = (e.target as HTMLElement).closest<HTMLElement>("[data-m]")?.dataset.m;
    closeOverlays(app);
    if (m === "copy") void app.copy(false);
    if (m === "ctx") void app.copy(true);
    if (m === "inspect") {
      app.panel = null;
      app.togglePanel("inspector");
    }
    if (m === "baseline") app.setBaseline();
  };
}
