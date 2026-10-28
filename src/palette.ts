// The command palette (Ctrl+K), go-to (Ctrl+G) and find (Ctrl+F).

import type { App } from "./main";
import type { SheetSummary } from "./types";
import { address } from "./sheet";
import { esc } from "./format";
import { $ } from "./dom";
import { closeOverlays, showHelp } from "./overlays";

interface PaletteItem {
  kind: string;
  title: string;
  hint?: string;
  run: () => void;
}

export function openPalette(app: App, mode: "all" | "go" | "find" = "all") {
  const o = $("#overlay");
  o.className = "on modal-host";
  const placeholder = mode === "go" ? "Go to a cell (B12) or a row label…" : mode === "find" ? "Find on this sheet…" : "Type a command, sheet or row label…";
  o.innerHTML = `<div class="modal palette"><input id="pal-in" placeholder="${placeholder}" autocomplete="off" spellcheck="false" /><div id="pal-list"></div></div>`;
  const input = $<HTMLInputElement>("#pal-in");
  const list = $("#pal-list");
  let items: PaletteItem[] = [];
  let active = 0;
  const draw = () => {
    items = paletteItems(app, input.value, mode);
    active = Math.min(active, Math.max(0, items.length - 1));
    list.innerHTML = items
      .slice(0, 60)
      .map((it, i) => `<button class="pal-item ${i === active ? "on" : ""}" data-i="${i}"><span class="pk">${it.kind}</span><span class="pt">${esc(it.title)}</span>${it.hint ? `<span class="ph">${esc(it.hint)}</span>` : ""}</button>`)
      .join("") ||
      `<div class="muted small pad">${
        input.value.trim()
          ? "No matches"
          : mode === "go"
            ? "Type a cell address such as B12, or a row label such as Revenue."
            : mode === "find"
              ? "Type to search the values and labels on this sheet."
              : ""
      }</div>`;
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  };
  input.oninput = () => {
    active = 0;
    draw();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") (active = Math.min(items.length - 1, active + 1)), draw(), e.preventDefault();
    if (e.key === "ArrowUp") (active = Math.max(0, active - 1)), draw(), e.preventDefault();
    if (e.key === "Enter" && items[active]) {
      e.preventDefault();
      const it = items[active];
      closeOverlays(app);
      it.run();
    }
  };
  list.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    closeOverlays(app);
    it.run();
  };
  o.onclick = (e) => {
    if (e.target === o) closeOverlays(app);
  };
  draw();
  input.focus();
}

function paletteItems(app: App, q: string, mode: "all" | "go" | "find"): PaletteItem[] {
  const query = q.trim().toLowerCase();
  const out: PaletteItem[] = [];
  const d = app.data;
  const m = /^([a-z]{1,3})(\d+)$/i.exec(q.trim());
  if (m && d) {
    const c = m[1].toUpperCase().split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
    const r = Number(m[2]);
    out.push({ kind: "Go", title: `${m[1].toUpperCase()}${r}`, hint: d.rowLabel(r), run: () => void app.jumpTo(app.sheetIndex, r, c) });
  }
  if (mode === "all") {
    const actions: PaletteItem[] = [
      { kind: "Action", title: "Open a workbook…", hint: "Ctrl O", run: () => void app.pick() },
      { kind: "Action", title: app.paused ? "Resume live updates" : "Pause live updates", hint: "Space", run: () => app.togglePause() },
      { kind: "Action", title: "Set baseline to this version", hint: "F5", run: () => app.setBaseline() },
      { kind: "Action", title: "Compare with the baseline", run: () => app.setCompare("baseline") },
      { kind: "Action", title: "Compare with the previous version", run: () => app.setCompare("latest") },
      { kind: "Action", title: "Next change", hint: "N", run: () => void app.stepChange(1) },
      { kind: "Action", title: "Show changes", hint: "D", run: () => app.togglePanel("changes") },
      { kind: "Action", title: "Inspect the selected cell", hint: "I", run: () => app.togglePanel("inspector") },
      { kind: "Action", title: "Copy with context", hint: "Ctrl Shift C", run: () => void app.copy(true) },
      { kind: "Action", title: "Copy change report", run: () => void app.copyChangeReport() },
      { kind: "Action", title: "Collapse to years", hint: "[", run: () => app.setLevel(true) },
      { kind: "Action", title: "Expand quarters", hint: "]", run: () => app.setLevel(false) },
      { kind: "Action", title: app.theme === "light" ? "Dark theme" : "Light theme", hint: "T", run: () => app.toggleTheme() },
      { kind: "Action", title: "Keyboard shortcuts", hint: "?", run: () => showHelp(app) },
    ];
    out.push(...actions.filter((a) => !query || a.title.toLowerCase().includes(query)));
    app.info?.sheets.forEach((s: SheetSummary, i) => {
      if (!query || s.name.toLowerCase().includes(query)) out.push({ kind: "Sheet", title: s.name, hint: s.edits ? `${s.edits} edits` : "", run: () => void app.switchSheet(i) });
    });
  }
  if (d && query) {
    const seen = new Set<number>();
    for (let r = 1; r <= d.meta.maxRow && out.length < 80; r++) {
      const label = d.rowLabel(r);
      if (label && label.toLowerCase().includes(query) && !seen.has(r)) {
        seen.add(r);
        out.push({ kind: "Row", title: label, hint: `row ${r}`, run: () => void app.jumpTo(app.sheetIndex, r, app.currentCol() ?? d.meta.labelCols + 1) });
      }
    }
    if (mode === "find") {
      for (const cell of d.allCells()) {
        if (out.length >= 120) break;
        if (cell.c > d.meta.labelCols && cell.text.toLowerCase().includes(query)) {
          out.push({ kind: "Cell", title: cell.text, hint: `${address(cell.r, cell.c)} · ${d.rowLabel(cell.r)}`, run: () => void app.jumpTo(app.sheetIndex, cell.r, cell.c) });
        }
      }
    }
  }
  return out;
}
