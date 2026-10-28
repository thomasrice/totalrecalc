// Keyboard: Excel's movement keys, plus Total Recalc's own shortcuts.

import type { App } from "./main";
import { $ } from "./dom";
import { closeOverlays, showHelp } from "./overlays";
import { openPalette } from "./palette";

export function handleKey(app: App, e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  if (target.closest("input, textarea")) {
    if (e.key === "Escape") closeOverlays(app);
    return;
  }
  // Overlays take their own keys; buttons keep Enter, Space and Tab.
  if ($("#overlay").classList.contains("on")) {
    if (e.key === "Escape") closeOverlays(app);
    return;
  }
  if (target.closest("button") && ["Enter", " ", "Tab"].includes(e.key)) return;
  if (document.body.classList.contains("empty")) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void app.pick();
    }
    if (e.key === "t") app.toggleTheme();
    if (e.key === "?") showHelp(app);
    return;
  }
  const s = app.grid.sel;
  const ctrl = e.ctrlKey || e.metaKey;
  const move = (dr: number, dc: number) => {
    e.preventDefault();
    app.grid.select((e.shiftKey ? s.row2 : s.row) + dr, (e.shiftKey ? s.col2 : s.col) + dc, e.shiftKey);
  };
  const edge = (dr: number, dc: number) => {
    e.preventDefault();
    const [r, c] = edgeOfData(app, e.shiftKey ? s.row2 : s.row, e.shiftKey ? s.col2 : s.col, dr, dc);
    app.grid.select(r, c, e.shiftKey);
  };
  const k = e.key;
  if (ctrl && k.toLowerCase() === "k") return void (e.preventDefault(), openPalette(app));
  if (ctrl && k.toLowerCase() === "g") return void (e.preventDefault(), openPalette(app, "go"));
  if (ctrl && k.toLowerCase() === "f") return void (e.preventDefault(), openPalette(app, "find"));
  if (ctrl && k.toLowerCase() === "o") return void (e.preventDefault(), app.pick());
  if (ctrl && k.toLowerCase() === "c") return void (e.preventDefault(), app.copy(e.shiftKey));
  if (ctrl && (k === "=" || k === "+")) return void (e.preventDefault(), app.zoomBy(1.1));
  if (ctrl && k === "-") return void (e.preventDefault(), app.zoomBy(1 / 1.1));
  if (ctrl && k === "0") return void (e.preventDefault(), app.zoomBy(0));
  if (ctrl && k === "PageDown") return void (e.preventDefault(), app.switchSheet(app.nextVisibleSheet(1)));
  if (ctrl && k === "PageUp") return void (e.preventDefault(), app.switchSheet(app.nextVisibleSheet(-1)));
  if (e.altKey && k === "ArrowLeft") return void (e.preventDefault(), app.back());
  switch (k) {
    case "ArrowUp":
      return ctrl ? edge(-1, 0) : move(-1, 0);
    case "ArrowDown":
      return ctrl ? edge(1, 0) : move(1, 0);
    case "ArrowLeft":
      return ctrl ? edge(0, -1) : move(0, -1);
    case "ArrowRight":
      return ctrl ? edge(0, 1) : move(0, 1);
    case "k":
      return move(-1, 0);
    case "j":
      return move(1, 0);
    case "h":
      return move(0, -1);
    case "l":
      return move(0, 1);
    case "PageDown":
      return move(app.grid.pageRows, 0);
    case "PageUp":
      return move(-app.grid.pageRows, 0);
    case "Home":
      e.preventDefault();
      return app.grid.select(ctrl ? 0 : s.row, 0, e.shiftKey);
    case "End":
      e.preventDefault();
      return app.grid.select(ctrl ? app.grid.rowCount - 1 : s.row, app.grid.colCount - 1, e.shiftKey);
    case "g":
      return app.grid.select(0, s.col);
    case "G":
      return app.grid.select(app.grid.rowCount - 1, s.col);
    case "Tab":
      return move(0, e.shiftKey ? -1 : 1);
    case "n":
      return void app.stepChange(1);
    case "N":
      return void app.stepChange(-1);
    case " ":
      e.preventDefault();
      return app.togglePause();
    case "F5":
      e.preventDefault();
      return app.setBaseline();
    case "F2":
    case "i":
      e.preventDefault();
      return app.togglePanel("inspector");
    case "d":
      return app.togglePanel("changes");
    case "Enter":
      e.preventDefault();
      return void app.followFirstInput();
    case "Backspace":
      e.preventDefault();
      return void app.back();
    case "[":
      return app.setLevel(true);
    case "]":
      return app.setLevel(false);
    case "t":
      return app.toggleTheme();
    case "?":
      return showHelp(app);
    case "Escape":
      if (closeOverlays(app)) return;
      if (s.row !== s.row2 || s.col !== s.col2) return app.grid.select(s.row, s.col);
      if (app.panel) return app.togglePanel(app.panel);
  }
}

function edgeOfData(app: App, row: number, col: number, dr: number, dc: number): [number, number] {
  const d = app.data!;
  const filled = (ri: number, ci: number) => {
    const vc = app.grid.colOf(ci);
    const r = app.grid.rowOf(ri);
    return vc?.kind === "sheet" && !!d.cell(r, vc.col)?.text;
  };
  let r = row;
  let c = col;
  const inside = (ri: number, ci: number) => ri >= 0 && ci >= 0 && ri < app.grid.rowCount && ci < app.grid.colCount;
  const startFilled = filled(r, c) && inside(r + dr, c + dc) && filled(r + dr, c + dc);
  while (inside(r + dr, c + dc)) {
    if (startFilled ? !filled(r + dr, c + dc) : filled(r + dr, c + dc)) {
      if (!startFilled) {
        r += dr;
        c += dc;
      }
      break;
    }
    r += dr;
    c += dc;
  }
  return [r, c];
}
