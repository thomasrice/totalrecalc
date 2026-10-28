import "@fontsource-variable/inter";
import "./styles.css";
import { type Api, createApi } from "./api";
import type { BookInfo, CellChange, Inspection, SheetSummary, WatchState } from "./types";
import { SheetData, address, colLetters } from "./sheet";
import { Grid, type Selection } from "./grid";
import { buildViewCols, yearGroups, type YearGroup } from "./periods";
import type { Theme } from "./theme";
import { ago, clock, delta, esc, shortValue } from "./format";
import { icon } from "./icons";

type CompareMode = "baseline" | "latest";
type Panel = "changes" | "inspector" | null;

interface FileMemory {
  sheet?: string;
  collapsed?: Record<string, number[]>;
  panel?: Panel;
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;

class App {
  api!: Api;
  info: BookInfo | null = null;
  path: string | null = null;
  displayed: number | null = null;
  latest: number | null = null;
  baseline: number | null = null;
  previousBaseline: number | null = null;
  compareMode: CompareMode = "baseline";
  paused = false;
  pendingWhilePaused = 0;
  sheetIndex = 0;
  data: SheetData | null = null;
  groups: YearGroup[] = [];
  collapsed = new Map<string, Set<number>>();
  panel: Panel = null;
  theme: Theme = "light";
  watch: WatchState = { state: "loading" };
  inspection: Inspection | null = null;
  history: { sheet: number; row: number; col: number }[] = [];
  grid: Grid;
  private loadToken = 0;

  constructor() {
    this.grid = new Grid({
      select: (s) => this.onSelect(s),
      toggleGroup: (y) => this.toggleYear(y),
      setLevel: (years) => this.setLevel(years),
      contextMenu: (x, y) => this.showContextMenu(x, y),
      hoverCell: (r, c, x, y) => this.hover(r, c, x, y),
    });
  }

  // ------------------------------------------------------------- startup

  async start() {
    this.theme = (localStorage.getItem("cellwake.theme") as Theme) || "light";
    this.renderShell();
    this.applyTheme();
    this.api = await createApi();
    this.api.onVersion((id, calculated) => this.onVersion(id, calculated));
    this.api.onWatch((w) => {
      this.watch = w;
      this.renderTopBar();
    });
    this.api.onDrop(
      (p) => this.open(p),
      (over) => document.body.classList.toggle("drop-over", over),
    );
    document.addEventListener("keydown", (e) => this.onKey(e));
    window.setInterval(() => this.renderTopBar(), 15000);
    const initial = await this.api.initialPath();
    if (initial) await this.open(initial);
    else this.showStart();
  }

  showStart() {
    document.body.classList.add("empty");
    $("#start").innerHTML = `
      <div class="start-card">
        <img class="start-mark" src="/cellwake-mark.svg" alt="" />
        <h1>Cellwake</h1>
        <p>Watch a spreadsheet while an AI agent edits it.</p>
        <button class="primary" id="open-btn">${icon("open")} Open a workbook…</button>
        <div class="drop-hint">or drop an <b>.xlsx</b> file anywhere</div>
        <div class="start-foot">Read-only. Cellwake never locks or writes your file.</div>
      </div>`;
    $("#open-btn").onclick = () => this.pick();
  }

  async pick() {
    const p = await this.api.pickFile();
    if (p) await this.open(p);
  }

  async open(path: string) {
    document.body.classList.remove("empty");
    this.path = path;
    this.info = null;
    this.displayed = this.latest = this.baseline = this.previousBaseline = null;
    this.paused = false;
    this.pendingWhilePaused = 0;
    this.data = null;
    this.watch = { state: "loading" };
    const mem = this.memory();
    this.collapsed = new Map(Object.entries(mem.collapsed ?? {}).map(([k, v]) => [k, new Set(v)]));
    this.panel = mem.panel ?? null;
    this.renderTopBar();
    $("#loading").classList.add("on");
    await this.api.openFile(path);
  }

  memory(): FileMemory {
    try {
      return JSON.parse(localStorage.getItem(`cellwake.file:${this.path}`) ?? "{}");
    } catch {
      return {};
    }
  }

  remember() {
    if (!this.path) return;
    const mem: FileMemory = {
      sheet: this.info?.sheets[this.sheetIndex]?.name,
      collapsed: Object.fromEntries([...this.collapsed].map(([k, v]) => [k, [...v]])),
      panel: this.panel,
    };
    try {
      localStorage.setItem(`cellwake.file:${this.path}`, JSON.stringify(mem));
    } catch {
      /* storage unavailable */
    }
  }

  // ------------------------------------------------------------ versions

  onVersion(id: number, calculated: boolean) {
    const isNew = this.latest === null || id > this.latest;
    this.latest = Math.max(this.latest ?? 0, id);
    if (this.baseline === null) this.baseline = id;
    if (this.paused && this.displayed !== null && id !== this.displayed) {
      if (isNew) this.pendingWhilePaused++;
      this.renderTopBar();
      return;
    }
    void this.display(id, { announce: isNew && this.displayed !== null && this.displayed !== id, recalculated: calculated && !isNew });
  }

  compareRef(version: number): number | undefined {
    if (this.compareMode === "baseline") return this.baseline ?? undefined;
    const vs = this.info?.versions.map((v) => v.id) ?? [];
    const prev = vs.filter((v) => v < version).pop();
    return prev;
  }

  async display(id: number, opts: { announce?: boolean; recalculated?: boolean } = {}) {
    const token = ++this.loadToken;
    const prevDisplayed = this.displayed;
    const anchor = this.anchor();
    let info = await this.api.bookInfo(id, undefined);
    // The comparison depends on the version list, so ask again once we know it.
    this.info = info;
    const ref = this.compareRef(id);
    if (ref !== undefined && ref !== id) info = await this.api.bookInfo(id, ref);
    if (token !== this.loadToken) return;
    this.info = info;
    this.displayed = id;
    if (prevDisplayed === null) {
      const remembered = this.memory().sheet;
      const idx = info.sheets.findIndex((s) => s.name === remembered);
      this.sheetIndex = idx >= 0 ? idx : Math.max(0, info.sheets.findIndex((s) => !s.hidden));
    }
    this.sheetIndex = Math.min(this.sheetIndex, info.sheets.length - 1);
    await this.loadSheet({ anchor, keepSelection: prevDisplayed !== null });
    if (token !== this.loadToken) return;
    $("#loading").classList.remove("on");
    if (opts.announce && prevDisplayed !== null) {
      const fresh = await this.api.sheet(id, this.sheetIndex, prevDisplayed);
      this.grid.wake(fresh.diff.changes, reducedMotion.matches);
      const update = await this.api.bookInfo(id, prevDisplayed);
      this.toast(this.updateSentence(update), "update");
    }
    this.renderAll();
  }

  updateSentence(i: BookInfo): string {
    const parts: string[] = [];
    if (i.edits) parts.push(`${i.edits} edit${i.edits === 1 ? "" : "s"}`);
    if (i.results) parts.push(`${i.results} result${i.results === 1 ? "" : "s"}`);
    if (i.rowsAdded) parts.push(`${i.rowsAdded} row${i.rowsAdded === 1 ? "" : "s"} added`);
    if (i.rowsRemoved) parts.push(`${i.rowsRemoved} removed`);
    return parts.length ? `Updated · ${parts.join(" · ")}` : "Updated · no visible changes";
  }

  async loadSheet(opts: { anchor?: Anchor | null; keepSelection?: boolean } = {}) {
    if (!this.info || this.displayed === null) return;
    const ref = this.compareRef(this.displayed);
    const payload = await this.api.sheet(this.displayed, this.sheetIndex, ref !== this.displayed ? ref : undefined);
    const data = new SheetData(payload);
    const sameSheet = this.data?.meta.name === data.meta.name;
    this.data = data;
    this.groups = yearGroups(data.meta);
    const collapsed = this.collapsed.get(data.meta.name) ?? new Set<number>();
    this.collapsed.set(data.meta.name, collapsed);
    const viewCols = buildViewCols(data.meta, this.groups, collapsed);
    const prevScroll = this.grid.scrollPos;
    this.grid.setSheet(data, this.info.styles, this.groups, collapsed, viewCols);
    if (opts.anchor && sameSheet) this.restore(opts.anchor);
    else if (!opts.keepSelection || !sameSheet) {
      this.grid.scrollPos = { top: 0, left: 0 };
      const r = Math.min(this.grid.rowCount - 1, Math.max(0, (data.meta.headerRow ?? 0)));
      this.grid.select(r, Math.min(this.grid.colCount - 1, Math.max(0, data.meta.labelCols)));
    } else this.grid.scrollPos = prevScroll;
    this.remember();
    this.renderAll();
  }

  // Keeping your place: the selected cell is identified by meaning.
  anchor(): Anchor | null {
    const d = this.data;
    if (!d) return null;
    const row = this.grid.rowOf(this.grid.sel.row);
    const vc = this.grid.colOf(this.grid.sel.col);
    if (row === undefined || !vc || vc.kind !== "sheet") return null;
    return {
      label: d.rowLabel(row),
      occurrence: occurrence(d, row),
      row,
      header: d.colHeader(vc.col),
      col: vc.col,
      offset: this.grid.rowScreenOffset(this.grid.sel.row),
      left: this.grid.scrollPos.left,
    };
  }

  restore(a: Anchor) {
    const d = this.data!;
    let row = a.row;
    if (a.label) {
      let seen = 0;
      for (let r = 1; r <= d.meta.maxRow; r++) {
        if (d.rowLabel(r) === a.label && ++seen === a.occurrence) {
          row = r;
          break;
        }
      }
    }
    let col = a.col;
    if (a.header) {
      for (let c = 1; c <= d.meta.maxCol; c++) if (d.colHeader(c) === a.header) col = c;
    }
    const vr = this.grid.viewRowOf(row) ?? 0;
    const vc = this.grid.viewColOf(col) ?? 0;
    this.grid.scrollPos = { top: this.grid.scrollPos.top, left: a.left };
    this.grid.setRowScreenOffset(vr, a.offset);
    this.grid.select(vr, vc);
  }

  // ------------------------------------------------------------ actions

  setCompare(mode: CompareMode) {
    this.compareMode = mode;
    if (this.displayed !== null) void this.display(this.displayed);
  }

  setBaseline(id?: number) {
    if (this.displayed === null) return;
    this.previousBaseline = this.baseline;
    this.baseline = id ?? this.displayed;
    this.compareMode = "baseline";
    void this.display(this.displayed);
    this.toast(`Baseline set to ${clock(this.versionAt(this.baseline))}`, "info", { label: "Undo", run: () => this.undoBaseline() });
  }

  undoBaseline() {
    if (this.previousBaseline === null || this.displayed === null) return;
    this.baseline = this.previousBaseline;
    this.previousBaseline = null;
    void this.display(this.displayed);
  }

  versionAt(id: number | null): number {
    return this.info?.versions.find((v) => v.id === id)?.at ?? Date.now();
  }

  togglePause() {
    this.paused = !this.paused;
    if (!this.paused) {
      const n = this.pendingWhilePaused;
      this.pendingWhilePaused = 0;
      if (this.latest !== null && this.latest !== this.displayed) void this.display(this.latest, { announce: true });
      else if (n === 0) this.toast("Resumed · nothing changed while paused", "info");
    }
    this.renderTopBar();
  }

  async switchSheet(i: number) {
    if (!this.info || i < 0 || i >= this.info.sheets.length || i === this.sheetIndex) return;
    this.sheetIndex = i;
    await this.loadSheet();
    this.grid.focus();
  }

  toggleYear(year: number) {
    const d = this.data;
    if (!d) return;
    const set = this.collapsed.get(d.meta.name)!;
    if (set.has(year)) set.delete(year);
    else set.add(year);
    this.relayout();
  }

  setLevel(years: boolean) {
    const d = this.data;
    if (!d || !this.groups.length) return;
    const set = this.collapsed.get(d.meta.name)!;
    set.clear();
    if (years) this.groups.forEach((g) => set.add(g.year));
    this.relayout();
  }

  relayout() {
    const d = this.data!;
    const anchor = this.anchor();
    const collapsed = this.collapsed.get(d.meta.name)!;
    this.grid.setSheet(d, this.info!.styles, this.groups, collapsed, buildViewCols(d.meta, this.groups, collapsed));
    if (anchor) this.restore(anchor);
    this.remember();
    this.renderAll();
  }

  togglePanel(p: Exclude<Panel, null>) {
    this.panel = this.panel === p ? null : p;
    this.remember();
    this.renderPanel();
    this.grid.schedule(true);
  }

  applyTheme() {
    document.documentElement.dataset.theme = this.theme;
    this.grid.setTheme(this.theme);
  }

  toggleTheme() {
    this.theme = this.theme === "light" ? "dark" : "light";
    localStorage.setItem("cellwake.theme", this.theme);
    this.applyTheme();
    this.renderTopBar();
  }

  /** Step through changes in reading order, across sheets. */
  async stepChange(dir: 1 | -1) {
    const d = this.data;
    if (!d || !this.info) return;
    const list = this.visibleChanges();
    const cur = { r: this.grid.rowOf(this.grid.sel.row) ?? 0, c: this.currentCol() ?? 0 };
    const idx = dir > 0 ? list.findIndex((ch) => ch.r > cur.r || (ch.r === cur.r && ch.c > cur.c)) : findLastIndex(list, (ch) => ch.r < cur.r || (ch.r === cur.r && ch.c < cur.c));
    if (idx >= 0) return this.goToChange(list[idx]);
    // Move on to the next sheet that has changes.
    const n = this.info.sheets.length;
    for (let k = 1; k < n; k++) {
      const i = (this.sheetIndex + dir * k + n) % n;
      const s = this.info.sheets[i];
      if (s.edits + s.results > 0) {
        this.sheetIndex = i;
        await this.loadSheet();
        const l = this.visibleChanges();
        if (l.length) this.goToChange(dir > 0 ? l[0] : l[l.length - 1]);
        this.toast(`${s.name}`, "info");
        return;
      }
    }
    if (list.length) this.goToChange(dir > 0 ? list[0] : list[list.length - 1]);
  }

  visibleChanges(): CellChange[] {
    return this.data?.changeList ?? [];
  }

  goToChange(ch: CellChange) {
    let vc = this.grid.viewColOf(ch.c);
    if (vc === undefined) {
      // Hidden in a collapsed year: open it.
      const g = this.groups.find((g) => g.quarters.includes(ch.c));
      if (g) {
        this.collapsed.get(this.data!.meta.name)!.delete(g.year);
        this.relayout();
        this.toast(`Expanded ${g.year} to show the change`, "info", { label: "Collapse", run: () => this.toggleYear(g.year) });
        vc = this.grid.viewColOf(ch.c);
      }
    }
    const vr = this.grid.viewRowOf(ch.r);
    if (vr === undefined || vc === undefined) return;
    this.grid.reveal(vr, vc);
    this.grid.select(vr, vc);
  }

  currentCol(): number | undefined {
    const vc = this.grid.colOf(this.grid.sel.col);
    return vc?.kind === "sheet" ? vc.col : undefined;
  }

  async jumpTo(sheetIndex: number, r: number, c: number, record = true) {
    if (record && this.data) this.history.push({ sheet: this.sheetIndex, row: this.grid.rowOf(this.grid.sel.row) ?? 1, col: this.currentCol() ?? 1 });
    if (sheetIndex !== this.sheetIndex) {
      this.sheetIndex = sheetIndex;
      await this.loadSheet();
    }
    let vc = this.grid.viewColOf(c);
    if (vc === undefined) {
      const g = this.groups.find((g) => g.quarters.includes(c));
      if (g) {
        this.collapsed.get(this.data!.meta.name)!.delete(g.year);
        this.relayout();
        vc = this.grid.viewColOf(c);
      }
    }
    const vr = this.grid.viewRowOf(r);
    if (vr === undefined || vc === undefined) return;
    this.grid.reveal(vr, vc);
    this.grid.select(vr, vc);
    this.grid.focus();
  }

  async back() {
    const h = this.history.pop();
    if (h) await this.jumpTo(h.sheet, h.row, h.col, false);
  }

  // ------------------------------------------------------------- copying

  selectionCells(): { r: number; c: number }[][] {
    const s = this.grid.sel;
    const rows: { r: number; c: number }[][] = [];
    for (let ri = Math.min(s.row, s.row2); ri <= Math.max(s.row, s.row2); ri++) {
      const line: { r: number; c: number }[] = [];
      for (let ci = Math.min(s.col, s.col2); ci <= Math.max(s.col, s.col2); ci++) {
        const vc = this.grid.colOf(ci);
        if (vc?.kind === "sheet") line.push({ r: this.grid.rowOf(ri), c: vc.col });
      }
      rows.push(line);
    }
    return rows;
  }

  async copy(withContext: boolean) {
    const d = this.data;
    if (!d || !this.info) return;
    const rows = this.selectionCells();
    let text: string;
    let count = 0;
    if (!withContext) {
      text = rows.map((line) => line.map(({ r, c }) => d.cell(r, c)?.text ?? "").join("\t")).join("\n");
      count = rows.reduce((n, l) => n + l.length, 0);
    } else {
      const lines = [`**${this.info.fileName}** · sheet **${d.meta.name}** · version ${clock(this.versionAt(this.displayed))}`, ""];
      for (const line of rows) {
        for (const { r, c } of line) {
          const cell = d.cell(r, c);
          if (!cell && !d.change(r, c)) continue;
          count++;
          const label = d.rowLabel(r);
          const header = d.colHeader(c);
          let s = `- \`${address(r, c)}\`${label ? ` ${label}` : ""}${header ? ` · ${header}` : ""}: **${cell?.text || "blank"}**`;
          if (cell?.formula) s += ` \`${cell.formula}\``;
          const ch = d.change(r, c);
          if (ch) {
            const dl = delta(ch.beforeValue, cell?.value ?? null, cell?.text ?? "", !!this.info.styles[cell?.style ?? 0]?.percent);
            s += ` (was ${shortValue(ch.beforeValue, ch.beforeText)}${dl ? `, ${dl}` : ""}${ch.beforeFormula && ch.beforeFormula !== cell?.formula ? `, formula was \`${ch.beforeFormula}\`` : ""})`;
          }
          if (cell?.calc === 1) s += " _(value from file cache)_";
          lines.push(s);
        }
      }
      text = lines.join("\n");
    }
    await navigator.clipboard.writeText(text);
    this.toast(`Copied ${count} cell${count === 1 ? "" : "s"}${withContext ? " with context" : ""}`, "info");
  }

  async copyChangeReport() {
    const d = this.data;
    if (!d || !this.info) return;
    const lines = [`**${this.info.fileName}** · changes ${this.compareMode === "baseline" ? `since ${clock(this.versionAt(this.baseline))}` : "in the latest update"}`, ""];
    for (const g of changeRows(d)) {
      lines.push(`- **${d.meta.name}** · ${g.label || `row ${g.r}`}: ${g.cells.length} cell${g.cells.length === 1 ? "" : "s"} (${g.edited ? "edited" : "recalculated"})${g.span ? ` · ${g.span}` : ""}${g.range ? ` · ${g.range}` : ""}`);
    }
    for (const rr of d.diff.removedRows) lines.push(`- **${d.meta.name}** · removed row: ${rr.label || rr.cells.map((c) => c[1]).slice(0, 3).join(" | ")}`);
    await navigator.clipboard.writeText(lines.join("\n"));
    this.toast("Copied the change report", "info");
  }

  // ------------------------------------------------------------ keyboard

  onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea")) {
      if (e.key === "Escape") this.closeOverlays();
      return;
    }
    if (document.body.classList.contains("empty")) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void this.pick();
      }
      return;
    }
    const s = this.grid.sel;
    const ctrl = e.ctrlKey || e.metaKey;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      this.grid.select((e.shiftKey ? s.row2 : s.row) + dr, (e.shiftKey ? s.col2 : s.col) + dc, e.shiftKey);
    };
    const edge = (dr: number, dc: number) => {
      e.preventDefault();
      const [r, c] = this.edgeOfData(e.shiftKey ? s.row2 : s.row, e.shiftKey ? s.col2 : s.col, dr, dc);
      this.grid.select(r, c, e.shiftKey);
    };
    const k = e.key;
    if (ctrl && k.toLowerCase() === "k") return void (e.preventDefault(), this.openPalette());
    if (ctrl && k.toLowerCase() === "g") return void (e.preventDefault(), this.openPalette("go"));
    if (ctrl && k.toLowerCase() === "f") return void (e.preventDefault(), this.openPalette("find"));
    if (ctrl && k.toLowerCase() === "o") return void (e.preventDefault(), this.pick());
    if (ctrl && k.toLowerCase() === "c") return void (e.preventDefault(), this.copy(e.shiftKey));
    if (ctrl && (k === "=" || k === "+")) return void (e.preventDefault(), this.zoomBy(1.1));
    if (ctrl && k === "-") return void (e.preventDefault(), this.zoomBy(1 / 1.1));
    if (ctrl && k === "0") return void (e.preventDefault(), this.zoomBy(0));
    if (ctrl && k === "PageDown") return void (e.preventDefault(), this.switchSheet(this.nextVisibleSheet(1)));
    if (ctrl && k === "PageUp") return void (e.preventDefault(), this.switchSheet(this.nextVisibleSheet(-1)));
    if (e.altKey && k === "ArrowLeft") return void (e.preventDefault(), this.back());
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
        return move(this.grid.pageRows, 0);
      case "PageUp":
        return move(-this.grid.pageRows, 0);
      case "Home":
        e.preventDefault();
        return this.grid.select(ctrl ? 0 : s.row, 0, e.shiftKey);
      case "End":
        e.preventDefault();
        return this.grid.select(ctrl ? this.grid.rowCount - 1 : s.row, this.grid.colCount - 1, e.shiftKey);
      case "g":
        return this.grid.select(0, s.col);
      case "G":
        return this.grid.select(this.grid.rowCount - 1, s.col);
      case "Tab":
        return move(0, e.shiftKey ? -1 : 1);
      case "n":
        return void this.stepChange(1);
      case "N":
        return void this.stepChange(-1);
      case " ":
        e.preventDefault();
        return this.togglePause();
      case "F5":
        e.preventDefault();
        return this.setBaseline();
      case "F2":
      case "i":
        e.preventDefault();
        return this.togglePanel("inspector");
      case "d":
        return this.togglePanel("changes");
      case "Enter":
        e.preventDefault();
        return void this.followFirstInput();
      case "Backspace":
        e.preventDefault();
        return void this.back();
      case "[":
        return this.setLevel(true);
      case "]":
        return this.setLevel(false);
      case "t":
        return this.toggleTheme();
      case "?":
        return this.showHelp();
      case "Escape":
        if (this.closeOverlays()) return;
        if (s.row !== s.row2 || s.col !== s.col2) return this.grid.select(s.row, s.col);
        if (this.panel) return this.togglePanel(this.panel);
    }
  }

  nextVisibleSheet(dir: 1 | -1): number {
    const sheets = this.info?.sheets ?? [];
    for (let k = 1; k <= sheets.length; k++) {
      const i = (this.sheetIndex + dir * k + sheets.length) % sheets.length;
      if (!sheets[i].hidden) return i;
    }
    return this.sheetIndex;
  }

  edgeOfData(row: number, col: number, dr: number, dc: number): [number, number] {
    const d = this.data!;
    const filled = (ri: number, ci: number) => {
      const vc = this.grid.colOf(ci);
      const r = this.grid.rowOf(ri);
      return vc?.kind === "sheet" && !!d.cell(r, vc.col)?.text;
    };
    let r = row;
    let c = col;
    const inside = (ri: number, ci: number) => ri >= 0 && ci >= 0 && ri < this.grid.rowCount && ci < this.grid.colCount;
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

  zoomBy(f: number) {
    this.grid.setZoom(f === 0 ? 1 : this.grid.getZoom() * f);
    this.renderStatus();
  }

  async followFirstInput() {
    if (!this.inspection) await this.inspect();
    const first = this.inspection?.inputs[0];
    if (first) await this.jumpTo(first.sheetIndex, first.r, first.c);
  }

  // ----------------------------------------------------------- selection

  private selectTimer = 0;

  onSelect(_s: Selection) {
    this.inspection = null;
    this.renderPeek();
    this.renderStatus();
    clearTimeout(this.selectTimer);
    if (this.panel === "inspector") this.selectTimer = window.setTimeout(() => void this.inspect(), 60);
    else if (this.panel === "changes") this.highlightChangeRow();
  }

  async inspect() {
    const d = this.data;
    const c = this.currentCol();
    if (!d || this.displayed === null || c === undefined) {
      this.renderPanel();
      return;
    }
    const r = this.grid.rowOf(this.grid.sel.row);
    this.inspection = await this.api.inspect(this.displayed, this.sheetIndex, r, c);
    this.renderPanel();
  }

  // ------------------------------------------------------------- render

  renderShell() {
    $("#app").innerHTML = `
      <header id="topbar"></header>
      <div id="peek"></div>
      <div id="body">
        <nav id="rail"></nav>
        <main id="gridwrap"><div id="loading"><div class="spinner"></div><span>Reading workbook…</span></div></main>
        <aside id="panel"></aside>
      </div>
      <footer id="status"></footer>
      <div id="start"></div>
      <div id="toasts"></div>
      <div id="tooltip"></div>
      <div id="overlay"></div>`;
    $("#gridwrap").prepend(this.grid.el);
  }

  renderAll() {
    this.renderTopBar();
    this.renderPeek();
    this.renderRail();
    this.renderPanel();
    this.renderStatus();
  }

  renderTopBar() {
    const i = this.info;
    const w = this.watch;
    const bar = $("#topbar");
    const fileName = i?.fileName ?? (this.path ? this.path.split(/[\\/]/).pop() : "");
    let live: string;
    if (this.paused) {
      live = `<span class="live paused">${icon("pause")} Paused${this.pendingWhilePaused ? ` · <b>${this.pendingWhilePaused} newer version${this.pendingWhilePaused === 1 ? "" : "s"}</b>` : ""}</span>`;
    } else if (w.state === "error") {
      live = `<span class="live error" title="${esc(w.message ?? "")}">${icon("alert")} ${esc(w.message ?? "Cannot read the file")}${this.displayed ? ` · showing ${clock(this.versionAt(this.displayed))}` : ""}</span>`;
    } else if (w.state === "writing") {
      live = `<span class="live writing"><i class="dot"></i> File is being written…</span>`;
    } else if (w.state === "calculating" || (i && !i.calc.calculated)) {
      live = `<span class="live calc"><i class="dot"></i> Recalculating…</span>`;
    } else if (w.state === "loading" || !i) {
      live = `<span class="live calc"><i class="dot"></i> Opening…</span>`;
    } else {
      live = `<span class="live on"><i class="dot"></i> Live</span>`;
    }
    const at = this.displayed !== null ? this.versionAt(this.displayed) : null;
    const total = i ? i.edits + i.results : 0;
    const headline = i
      ? total || i.rowsAdded || i.rowsRemoved
        ? `<button class="headline" data-act="changes" title="Show changes (d)"><b class="edits">${i.edits}</b> edit${i.edits === 1 ? "" : "s"}<span class="sep">·</span><b class="results">${i.results}</b> result${i.results === 1 ? "" : "s"}${i.rowsAdded ? `<span class="sep">·</span>${i.rowsAdded} row${i.rowsAdded === 1 ? "" : "s"} added` : ""}${i.rowsRemoved ? `<span class="sep">·</span>${i.rowsRemoved} removed` : ""}<span class="muted"> ${this.compareMode === "baseline" ? `since ${clock(this.versionAt(this.baseline))}` : "in latest update"}</span></button>`
        : `<span class="headline quiet">No changes ${this.compareMode === "baseline" ? "since baseline" : "in latest update"}</span>`
      : "";
    bar.innerHTML = `
      <div class="brand" title="Cellwake"><img src="/cellwake-mark.svg" alt="" /></div>
      <div class="file">
        <span class="name">${esc(fileName ?? "")}</span>
        <span class="folder">${esc(i?.folder ?? "")}</span>
      </div>
      ${live}
      ${at ? `<span class="version" title="Version shown">${icon("clock")} ${clock(at)} <span class="muted">${ago(at)}</span></span>` : ""}
      <div class="spacer"></div>
      ${headline}
      <div class="nav">
        <button class="icon" data-act="prev" title="Previous change (Shift+N)">${icon("up")}</button>
        <button class="icon" data-act="next" title="Next change (N)">${icon("down")}</button>
      </div>
      <button class="icon ${this.paused ? "active" : ""}" data-act="pause" title="${this.paused ? "Resume (Space)" : "Pause: hold this version while you look (Space)"}">${icon(this.paused ? "play" : "pause")}</button>
      <button class="ghost" data-act="baseline" title="Make this version the baseline (F5)">${icon("flag")} Set baseline</button>
      <div class="divider"></div>
      <button class="icon ${this.panel === "changes" ? "active" : ""}" data-act="changes" title="Changes (d)">${icon("changes")}</button>
      <button class="icon ${this.panel === "inspector" ? "active" : ""}" data-act="inspector" title="Inspector (i)">${icon("inspect")}</button>
      <button class="icon" data-act="palette" title="Command palette (Ctrl+K)">${icon("search")}</button>
      <button class="icon" data-act="theme" title="Light or dark (t)">${icon(this.theme === "light" ? "moon" : "sun")}</button>`;
    bar.onclick = (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "prev") void this.stepChange(-1);
      if (act === "next") void this.stepChange(1);
      if (act === "pause") this.togglePause();
      if (act === "baseline") this.setBaseline();
      if (act === "changes") this.togglePanel("changes");
      if (act === "inspector") this.togglePanel("inspector");
      if (act === "palette") this.openPalette();
      if (act === "theme") this.toggleTheme();
    };
    document.title = fileName ? `${fileName} — Cellwake` : "Cellwake";
  }

  renderPeek() {
    const el = $("#peek");
    const d = this.data;
    if (!d || !this.info) {
      el.innerHTML = "";
      return;
    }
    const row = this.grid.rowOf(this.grid.sel.row);
    const vc = this.grid.colOf(this.grid.sel.col);
    if (!vc) return;
    if (vc.kind === "derived") {
      el.innerHTML = `<span class="addr">Σ ${vc.group.year}</span><span class="what">${esc(d.rowLabel(row))} · derived annual</span><span class="formula muted">Not in the workbook: ${row === d.meta.headerRow ? "the year's quarters" : "computed from the four quarters"}</span>`;
      return;
    }
    const cell = d.cell(row, vc.col);
    const ch = d.change(row, vc.col);
    const label = d.rowLabel(row);
    const header = d.colHeader(vc.col);
    const percent = !!this.info.styles[cell?.style ?? 0]?.percent;
    const dl = ch ? delta(ch.beforeValue, cell?.value ?? null, cell?.text ?? "", percent) : "";
    const kind = ch ? `<span class="kind k-${ch.kind}">${kindLabel(ch.kind)}</span>` : "";
    el.innerHTML = `
      <span class="addr">${address(row, vc.col)}</span>
      <span class="what">${esc(label || "—")}${header ? ` <span class="muted">·</span> ${esc(header)}` : ""}</span>
      <span class="value ${cell?.error ? "err" : ""}">${esc(cell?.text || "blank")}</span>
      ${ch ? `<span class="was">was ${esc(shortValue(ch.beforeValue, ch.beforeText))}</span>${dl ? `<span class="delta">${esc(dl)}</span>` : ""}${kind}` : ""}
      ${cell?.calc === 1 ? `<span class="calc-note" title="The engine could not calculate this formula; the value saved in the file is shown">from file cache</span>` : ""}
      ${cell?.formula ? `<span class="formula" title="${esc(cell.formula)}">${formulaHtml(cell.formula)}</span>` : ""}
      ${cell?.comment ? `<span class="comment-note" title="${esc(cell.comment)}">${icon("note")}</span>` : ""}`;
  }

  renderRail() {
    const i = this.info;
    const rail = $("#rail");
    if (!i) {
      rail.innerHTML = "";
      return;
    }
    rail.innerHTML =
      `<div class="rail-title">Sheets</div>` +
      i.sheets
        .map((s, idx) => {
          if (s.hidden) return "";
          const n = s.edits;
          const badge = n ? `<span class="badge edits" title="${n} edit${n === 1 ? "" : "s"}, ${s.results} result${s.results === 1 ? "" : "s"}">${n}</span>` : s.results ? `<span class="badge results" title="${s.results} recalculated">${s.results}</span>` : "";
          return `<button class="sheet ${idx === this.sheetIndex ? "on" : ""} ${s.newSheet ? "new" : ""}" data-i="${idx}" title="${esc(s.name)}"><span class="nm">${esc(s.name)}</span>${badge}</button>`;
        })
        .join("") +
      (i.sheets.some((s) => s.hidden) ? `<div class="rail-foot">${i.sheets.filter((s) => s.hidden).length} hidden</div>` : "") +
      (i.removedSheets.length ? `<div class="rail-foot removed">Removed: ${i.removedSheets.map(esc).join(", ")}</div>` : "");
    rail.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (b) void this.switchSheet(Number(b.dataset.i));
    };
  }

  renderStatus() {
    const i = this.info;
    const d = this.data;
    const el = $("#status");
    if (!i || !d) {
      el.innerHTML = "";
      return;
    }
    const cells = this.selectionCells().flat();
    const nums = cells.map(({ r, c }) => d.cell(r, c)?.value).filter((v): v is number => typeof v === "number");
    const sum = nums.reduce((a, b) => a + b, 0);
    const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
    const sel =
      nums.length > 1
        ? `<span>Sum <b>${fmt(sum)}</b></span><span>Average <b>${fmt(sum / nums.length)}</b></span><span>Count <b>${cells.filter(({ r, c }) => d.cell(r, c)?.text).length}</b></span>`
        : "";
    const row = this.grid.rowOf(this.grid.sel.row);
    const vc = this.grid.colOf(this.grid.sel.col);
    const addr = vc?.kind === "sheet" ? `${d.meta.name}!${colLetters(vc.col)}${row}` : d.meta.name;
    const c = i.calc;
    const calc = !c.calculated
      ? `<span class="calc pending">Recalculating…</span>`
      : c.cached || c.unavailable
        ? `<span class="calc warn" title="Some formulas use functions the engine does not support">${c.cached ? `${c.cached} from file cache` : ""}${c.cached && c.unavailable ? " · " : ""}${c.unavailable ? `${c.unavailable} unavailable` : ""}</span>`
        : `<span class="calc ok">${icon("check")} All values calculated</span>`;
    el.innerHTML = `
      <span class="addr">${esc(addr)}</span>
      ${sel}
      <div class="spacer"></div>
      ${c.errors ? `<span class="errs" title="Cells showing an error">${c.errors} error${c.errors === 1 ? "" : "s"}</span>` : ""}
      ${calc}
      ${d.meta.frozenInferred ? `<span class="muted" title="The file has no frozen panes; Cellwake froze the header row and label columns it found">Freeze: inferred</span>` : ""}
      <span class="muted">${Math.round(this.grid.getZoom() * 100)}%</span>
      <button class="link" data-act="help">? Shortcuts</button>`;
    el.onclick = (e) => {
      if ((e.target as HTMLElement).closest("[data-act=help]")) this.showHelp();
    };
  }

  renderPanel() {
    const el = $("#panel");
    document.body.classList.toggle("panel-open", !!this.panel);
    if (!this.panel || !this.data || !this.info) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `
      <div class="tabs">
        <button class="${this.panel === "changes" ? "on" : ""}" data-tab="changes">Changes</button>
        <button class="${this.panel === "inspector" ? "on" : ""}" data-tab="inspector">Inspector</button>
        <button class="icon close" data-tab="close" title="Close (Esc)">${icon("x")}</button>
      </div>
      <div class="panel-body">${this.panel === "changes" ? this.changesHtml() : this.inspectorHtml()}</div>`;
    el.onclick = (e) => this.onPanelClick(e);
    if (this.panel === "inspector" && !this.inspection) void this.inspect();
    if (this.panel === "changes") this.highlightChangeRow();
  }

  changesHtml(): string {
    const i = this.info!;
    const d = this.data!;
    const versions = i.versions;
    const timeline = versions
      .map((v) => {
        const cls = [v.id === this.displayed ? "shown" : "", v.id === this.baseline ? "base" : ""].join(" ");
        return `<button class="ver ${cls}" data-ver="${v.id}" title="${v.id === this.baseline ? "Baseline" : "Click to make this the baseline"}">${clock(v.at)}${v.id === this.baseline ? " · base" : ""}</button>`;
      })
      .join("");
    const groups = changeRows(d);
    const edited = groups.filter((g) => g.edited);
    const results = groups.filter((g) => !g.edited);
    const rowHtml = (g: ChangeRow) => `
      <button class="chrow ${g.edited ? "edited" : "result"}" data-r="${g.r}" data-c="${g.cells[0].c}">
        <span class="bar"></span>
        <span class="lbl">${esc(g.label || `Row ${g.r}`)}</span>
        <span class="meta">${g.cells.length} cell${g.cells.length === 1 ? "" : "s"}${g.span ? ` · ${esc(g.span)}` : ""}</span>
        ${g.range ? `<span class="rng">${esc(g.range)}</span>` : ""}
        ${g.spark ? `<span class="spark">${g.spark}</span>` : ""}
      </button>`;
    const other = i.sheets
      .map((s, idx) => ({ s, idx }))
      .filter(({ s, idx }) => idx !== this.sheetIndex && s.edits + s.results + s.structure > 0);
    const removed = d.diff.removedRows;
    const empty = !groups.length && !removed.length && !d.diff.addedRows.length;
    return `
      <div class="seg">
        <button class="${this.compareMode === "baseline" ? "on" : ""}" data-mode="baseline">Since baseline</button>
        <button class="${this.compareMode === "latest" ? "on" : ""}" data-mode="latest">Latest update</button>
      </div>
      <div class="timeline">${timeline}</div>
      <div class="sheet-head"><b>${esc(d.meta.name)}</b><span class="muted">${d.diff.edits} edits · ${d.diff.results} results</span><button class="link" data-act="report" title="Copy the change list as Markdown">${icon("copy")} Copy report</button></div>
      ${empty ? `<div class="empty-note">${icon("check")} Nothing changed on this sheet${this.compareMode === "baseline" ? " since the baseline" : " in the latest update"}.</div>` : ""}
      ${edited.length ? `<div class="sec">Edited</div>${edited.map(rowHtml).join("")}` : ""}
      ${d.diff.addedRows.length ? `<div class="sec">Rows added</div>${d.diff.addedRows.map((r) => `<button class="chrow added" data-r="${r}" data-c="1"><span class="bar"></span><span class="lbl">${esc(d.rowLabel(r) || `Row ${r}`)}</span><span class="meta">new row</span></button>`).join("")}` : ""}
      ${removed.length ? `<div class="sec">Rows removed</div>${removed.map((rr) => `<div class="chrow removed"><span class="bar"></span><span class="lbl">${esc(rr.label || rr.cells.map((c) => c[1]).slice(0, 2).join(" · ") || "Unlabelled row")}</span><span class="meta">was below row ${rr.after}</span><span class="rng">${esc(rr.cells.slice(1, 5).map((c) => c[1]).join("  "))}</span></div>`).join("")}` : ""}
      ${results.length ? `<div class="sec">Recalculated</div>${results.map(rowHtml).join("")}` : ""}
      ${other.length ? `<div class="sec">Other sheets</div>${other.map(({ s, idx }) => `<button class="chrow sheetrow" data-sheet="${idx}"><span class="lbl">${esc(s.name)}</span><span class="meta">${s.edits} edits · ${s.results} results${s.structure ? ` · ${s.structure} rows` : ""}</span>${icon("chevron")}</button>`).join("")}` : ""}`;
  }

  inspectorHtml(): string {
    const d = this.data!;
    const row = this.grid.rowOf(this.grid.sel.row);
    const vc = this.grid.colOf(this.grid.sel.col);
    if (!vc || vc.kind !== "sheet") return `<div class="empty-note">A derived annual column is computed by Cellwake from the four quarters; it is not in the workbook.</div>`;
    const cell = d.cell(row, vc.col);
    const ch = d.change(row, vc.col);
    const label = d.rowLabel(row);
    const header = d.colHeader(vc.col);
    const percent = !!this.info!.styles[cell?.style ?? 0]?.percent;
    const ins = this.inspection;
    const refList = (list: Inspection["inputs"]) =>
      list.length
        ? list
            .map(
              (x) =>
                `<button class="ref" data-sheet="${x.sheetIndex}" data-r="${x.r}" data-c="${x.c}"><span class="lbl">${esc(x.label || x.address)}${x.header ? ` <span class="muted">· ${esc(x.header)}</span>` : ""}</span><span class="val">${esc(x.text)}</span>${x.sheetIndex !== this.sheetIndex ? `<span class="sheetname">${esc(x.sheet)}</span>` : ""}${x.more ? `<span class="more">+${x.more} more</span>` : ""}</button>`,
            )
            .join("")
        : `<div class="muted small">None</div>`;
    const calcNote = cell?.calc === 1 ? "From the file's cache: the engine does not support a function in this formula." : cell?.calc === 2 ? "Unavailable: the engine could not calculate this and the file holds no saved value." : cell?.formula ? "Calculated by Cellwake." : cell ? "A constant typed into the workbook." : "Empty cell.";
    return `
      <div class="insp-title">${esc(label || "—")}${header ? ` <span class="muted">·</span> ${esc(header)}` : ""}</div>
      <div class="insp-sub">${esc(d.meta.name)}!${address(row, vc.col)}</div>
      <div class="insp-value ${cell?.error ? "err" : ""}">${esc(cell?.text || "blank")}</div>
      ${cell && typeof cell.value === "number" && cell.text !== String(cell.value) ? `<div class="insp-raw">${cell.value}</div>` : ""}
      ${ch ? `<div class="insp-was"><span class="kind k-${ch.kind}">${kindLabel(ch.kind)}</span> was <b>${esc(shortValue(ch.beforeValue, ch.beforeText))}</b> <span class="delta">${esc(delta(ch.beforeValue, cell?.value ?? null, cell?.text ?? "", percent))}</span></div>` : ""}
      ${cell?.formula ? `<div class="insp-sec">Formula</div><div class="insp-formula">${formulaHtml(cell.formula, { names: this.info!.sheets.map((x) => x.name), current: this.sheetIndex })}</div>` : ""}
      ${ch?.beforeFormula && ch.beforeFormula !== cell?.formula ? `<div class="insp-formula before">${esc(ch.beforeFormula)}</div>` : ""}
      ${cell?.comment ? `<div class="insp-sec">Note</div><div class="insp-note">${esc(cell.comment)}</div>` : ""}
      <div class="insp-sec">Inputs</div>
      ${ins ? refList(ins.inputs) : `<div class="muted small">…</div>`}
      <div class="insp-sec">Used by</div>
      ${ins ? refList(ins.usedBy) : `<div class="muted small">…</div>`}
      <div class="insp-calc">${calcNote}</div>
      ${this.history.length ? `<button class="link back" data-act="back">${icon("back")} Back (Backspace)</button>` : ""}`;
  }

  onPanelClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (tab === "close") return this.togglePanel(this.panel!);
    if (tab === "changes" || tab === "inspector") {
      this.panel = tab;
      this.remember();
      return this.renderPanel();
    }
    const mode = t.closest<HTMLElement>("[data-mode]")?.dataset.mode as CompareMode | undefined;
    if (mode) return this.setCompare(mode);
    const ver = t.closest<HTMLElement>("[data-ver]")?.dataset.ver;
    if (ver) return this.setBaseline(Number(ver));
    if (t.closest("[data-act=report]")) return void this.copyChangeReport();
    if (t.closest("[data-act=back]")) return void this.back();
    const ref = t.closest<HTMLElement>(".ref, .fref[data-r]");
    if (ref) return void this.jumpTo(Number(ref.dataset.sheet ?? this.sheetIndex), Number(ref.dataset.r), Number(ref.dataset.c));
    const sheetRow = t.closest<HTMLElement>("[data-sheet]");
    if (sheetRow?.classList.contains("sheetrow")) return void this.switchSheet(Number(sheetRow.dataset.sheet));
    const row = t.closest<HTMLElement>(".chrow[data-r]");
    if (row) {
      const vr = this.grid.viewRowOf(Number(row.dataset.r));
      let vc = this.grid.viewColOf(Number(row.dataset.c));
      if (vc === undefined) vc = this.grid.viewColOf(1) ?? 0;
      if (vr !== undefined) {
        this.grid.reveal(vr, vc);
        this.grid.select(vr, vc);
        this.grid.focus();
      }
    }
  }

  highlightChangeRow() {
    const row = this.grid.rowOf(this.grid.sel.row);
    document.querySelectorAll(".chrow.current").forEach((el) => el.classList.remove("current"));
    document.querySelector(`.chrow[data-r="${row}"]`)?.classList.add("current");
  }

  // ------------------------------------------------------------- overlays

  toast(text: string, kind: "info" | "update", action?: { label: string; run: () => void }) {
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

  hover(row: number | null, col: number | null, x: number, y: number) {
    const tip = $("#tooltip");
    const d = this.data;
    if (row === null || col === null || !d) return void tip.classList.remove("on");
    const vc = this.grid.colOf(col);
    if (!vc || vc.kind !== "sheet") return void tip.classList.remove("on");
    const r = this.grid.rowOf(row);
    const ch = d.change(r, vc.col);
    const cell = d.cell(r, vc.col);
    if (!ch && !cell?.comment) return void tip.classList.remove("on");
    const percent = !!this.info?.styles[cell?.style ?? 0]?.percent;
    tip.innerHTML = `${ch ? `<div><span class="kind k-${ch.kind}">${kindLabel(ch.kind)}</span> ${esc(shortValue(ch.beforeValue, ch.beforeText))} → <b>${esc(cell?.text || "blank")}</b> <span class="delta">${esc(delta(ch.beforeValue, cell?.value ?? null, cell?.text ?? "", percent))}</span></div>` : ""}${cell?.comment ? `<div class="tip-note">${esc(cell.comment)}</div>` : ""}`;
    tip.style.left = `${Math.min(x + 14, innerWidth - 340)}px`;
    tip.style.top = `${y + 18}px`;
    tip.classList.add("on");
  }

  showContextMenu(x: number, y: number) {
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
      this.closeOverlays();
      if (m === "copy") void this.copy(false);
      if (m === "ctx") void this.copy(true);
      if (m === "inspect") {
        this.panel = null;
        this.togglePanel("inspector");
      }
      if (m === "baseline") this.setBaseline();
    };
  }

  closeOverlays(): boolean {
    const o = $("#overlay");
    const was = o.classList.contains("on");
    o.className = "";
    o.innerHTML = "";
    if (was) this.grid.focus();
    return was;
  }

  showHelp() {
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
      if (e.target === o) this.closeOverlays();
    };
  }

  // ------------------------------------------------------ command palette

  openPalette(mode: "all" | "go" | "find" = "all") {
    const o = $("#overlay");
    o.className = "on modal-host";
    const placeholder = mode === "go" ? "Go to a cell (B12) or a row label…" : mode === "find" ? "Find on this sheet…" : "Type a command, sheet or row label…";
    o.innerHTML = `<div class="modal palette"><input id="pal-in" placeholder="${placeholder}" autocomplete="off" spellcheck="false" /><div id="pal-list"></div></div>`;
    const input = $<HTMLInputElement>("#pal-in");
    const list = $("#pal-list");
    let items: PaletteItem[] = [];
    let active = 0;
    const draw = () => {
      items = this.paletteItems(input.value, mode);
      active = Math.min(active, Math.max(0, items.length - 1));
      list.innerHTML = items
        .slice(0, 60)
        .map((it, i) => `<button class="pal-item ${i === active ? "on" : ""}" data-i="${i}"><span class="pk">${it.kind}</span><span class="pt">${esc(it.title)}</span>${it.hint ? `<span class="ph">${esc(it.hint)}</span>` : ""}</button>`)
        .join("") || `<div class="muted small pad">No matches</div>`;
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
        this.closeOverlays();
        it.run();
      }
    };
    list.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!b) return;
      const it = items[Number(b.dataset.i)];
      this.closeOverlays();
      it.run();
    };
    o.onclick = (e) => {
      if (e.target === o) this.closeOverlays();
    };
    draw();
    input.focus();
  }

  paletteItems(q: string, mode: "all" | "go" | "find"): PaletteItem[] {
    const query = q.trim().toLowerCase();
    const out: PaletteItem[] = [];
    const d = this.data;
    const m = /^([a-z]{1,3})(\d+)$/i.exec(q.trim());
    if (m && d) {
      const c = m[1].toUpperCase().split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
      const r = Number(m[2]);
      out.push({ kind: "Go", title: `${m[1].toUpperCase()}${r}`, hint: d.rowLabel(r), run: () => void this.jumpTo(this.sheetIndex, r, c) });
    }
    if (mode === "all") {
      const actions: PaletteItem[] = [
        { kind: "Action", title: "Open a workbook…", hint: "Ctrl O", run: () => void this.pick() },
        { kind: "Action", title: this.paused ? "Resume live updates" : "Pause live updates", hint: "Space", run: () => this.togglePause() },
        { kind: "Action", title: "Set baseline to this version", hint: "F5", run: () => this.setBaseline() },
        { kind: "Action", title: "Compare with the baseline", run: () => this.setCompare("baseline") },
        { kind: "Action", title: "Compare with the previous version", run: () => this.setCompare("latest") },
        { kind: "Action", title: "Next change", hint: "N", run: () => void this.stepChange(1) },
        { kind: "Action", title: "Show changes", hint: "D", run: () => this.togglePanel("changes") },
        { kind: "Action", title: "Inspect the selected cell", hint: "I", run: () => this.togglePanel("inspector") },
        { kind: "Action", title: "Copy with context", hint: "Ctrl Shift C", run: () => void this.copy(true) },
        { kind: "Action", title: "Copy change report", run: () => void this.copyChangeReport() },
        { kind: "Action", title: "Collapse to years", hint: "[", run: () => this.setLevel(true) },
        { kind: "Action", title: "Expand quarters", hint: "]", run: () => this.setLevel(false) },
        { kind: "Action", title: this.theme === "light" ? "Dark theme" : "Light theme", hint: "T", run: () => this.toggleTheme() },
        { kind: "Action", title: "Keyboard shortcuts", hint: "?", run: () => this.showHelp() },
      ];
      out.push(...actions.filter((a) => !query || a.title.toLowerCase().includes(query)));
      this.info?.sheets.forEach((s: SheetSummary, i) => {
        if (!query || s.name.toLowerCase().includes(query)) out.push({ kind: "Sheet", title: s.name, hint: s.edits ? `${s.edits} edits` : "", run: () => void this.switchSheet(i) });
      });
    }
    if (d && query) {
      const seen = new Set<number>();
      for (let r = 1; r <= d.meta.maxRow && out.length < 80; r++) {
        const label = d.rowLabel(r);
        if (label && label.toLowerCase().includes(query) && !seen.has(r)) {
          seen.add(r);
          out.push({ kind: "Row", title: label, hint: `row ${r}`, run: () => void this.jumpTo(this.sheetIndex, r, this.currentCol() ?? d.meta.labelCols + 1) });
        }
      }
      if (mode === "find") {
        for (const cell of d.allCells()) {
          if (out.length >= 120) break;
          if (cell.c > d.meta.labelCols && cell.text.toLowerCase().includes(query)) {
            out.push({ kind: "Cell", title: cell.text, hint: `${address(cell.r, cell.c)} · ${d.rowLabel(cell.r)}`, run: () => void this.jumpTo(this.sheetIndex, cell.r, cell.c) });
          }
        }
      }
    }
    return out;
  }
}

interface PaletteItem {
  kind: string;
  title: string;
  hint?: string;
  run: () => void;
}

interface Anchor {
  label: string;
  occurrence: number;
  row: number;
  header: string;
  col: number;
  offset: number;
  left: number;
}

interface ChangeRow {
  r: number;
  label: string;
  cells: CellChange[];
  edited: boolean;
  span: string;
  range: string;
  spark: string;
}

function occurrence(d: SheetData, row: number): number {
  const label = d.rowLabel(row);
  let n = 0;
  for (let r = 1; r <= row; r++) if (d.rowLabel(r) === label) n++;
  return n;
}

function kindLabel(k: CellChange["kind"]): string {
  return { edit: "Edited", formula: "Formula edited", result: "Recalculated", added: "Added", cleared: "Cleared" }[k];
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

/** Changes grouped by row, with a period span, the range of relative moves and a sparkline. */
function changeRows(d: SheetData): ChangeRow[] {
  const byRow = new Map<number, CellChange[]>();
  for (const ch of d.changeList) {
    const list = byRow.get(ch.r) ?? [];
    list.push(ch);
    byRow.set(ch.r, list);
  }
  return [...byRow].map(([r, cells]) => {
    const first = d.colHeader(cells[0].c) || colLetters(cells[0].c);
    const last = d.colHeader(cells[cells.length - 1].c) || colLetters(cells[cells.length - 1].c);
    const pcts: number[] = [];
    for (const ch of cells) {
      const after = d.cell(ch.r, ch.c)?.value;
      if (typeof ch.beforeValue === "number" && typeof after === "number" && ch.beforeValue !== 0) pcts.push(((after - ch.beforeValue) / Math.abs(ch.beforeValue)) * 100);
    }
    const lo = Math.min(...pcts);
    const hi = Math.max(...pcts);
    const f = (p: number) => (Math.abs(p) < 0.005 ? "0%" : `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(Math.abs(p) < 1 ? 2 : 1)}%`);
    const range = pcts.length ? (Math.abs(hi - lo) < 0.05 ? f(lo) : `${f(lo)} to ${f(hi)}`) : "";
    return {
      r,
      label: d.rowLabel(r),
      cells,
      edited: cells.some((c) => c.kind !== "result"),
      span: cells.length > 1 ? `${first}–${last}` : first,
      range,
      spark: sparkline(d, r, cells),
    };
  });
}

/** Before/after line for a row of period values. */
function sparkline(d: SheetData, r: number, cells: CellChange[]): string {
  const cols = d.meta.periods.map((p, i) => (p ? i + 1 : 0)).filter((c) => c > 0);
  if (cols.length < 4 || cells.length < 2) return "";
  const changed = new Map(cells.map((c) => [c.c, c]));
  const after: (number | null)[] = [];
  const before: (number | null)[] = [];
  for (const c of cols) {
    const v = d.cell(r, c)?.value;
    const a = typeof v === "number" ? v : null;
    const ch = changed.get(c);
    after.push(a);
    before.push(ch ? (typeof ch.beforeValue === "number" ? ch.beforeValue : null) : a);
  }
  const all = [...after, ...before].filter((v): v is number => v !== null);
  if (all.length < 4) return "";
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const W = 84;
  const H = 22;
  const path = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v === null ? null : `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`))
      .filter(Boolean)
      .map((p, i) => `${i ? "L" : "M"}${p}`)
      .join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${path(before)}" class="sp-before"/><path d="${path(after)}" class="sp-after"/></svg>`;
}

/** A formula with its references as chips; with `sheets`, they are clickable. */
function formulaHtml(f: string, sheets?: { names: string[]; current: number }): string {
  const re = /((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)/g;
  let out = "";
  let last = 0;
  for (const m of f.matchAll(re)) {
    const i = m.index ?? 0;
    const prev = f[i - 1] ?? "";
    if (/[A-Za-z0-9_.]/.test(prev) || f[i + m[0].length] === "(") continue;
    out += esc(f.slice(last, i));
    const sheet = m[1] ? m[1].slice(0, -1).replace(/^'|'$/g, "").replace(/''/g, "'") : "";
    const idx = sheets ? (sheet ? sheets.names.indexOf(sheet) : sheets.current) : -1;
    const cls = sheet && idx !== sheets?.current ? "fref other" : "fref";
    const ref = /^\$?([A-Z]{1,3})\$?(\d+)/.exec(m[2]);
    const target =
      idx >= 0 && ref
        ? ` data-sheet="${idx}" data-r="${ref[2]}" data-c="${ref[1].split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0)}" role="button"`
        : "";
    out += `<span class="${cls}"${target}>${esc(m[0])}</span>`;
    last = i + m[0].length;
  }
  return out + esc(f.slice(last));
}

const app = new App();
void app.start();
