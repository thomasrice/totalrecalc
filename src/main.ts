import "./fonts.css";
import "./styles.css";
import { type Api, createApi } from "./api";
import type { BookInfo, CellChange, Inspection, WatchState } from "./types";
import { SheetData, address, colLetters } from "./sheet";
import { Grid, type Selection } from "./grid";
import { buildViewCols, yearGroups, type YearGroup } from "./periods";
import type { Theme } from "./theme";
import { ago, clock, delta, esc, shortValue } from "./format";
import { icon } from "./icons";
import { $ } from "./dom";
import { changeReport, changesHtml, formulaHtml, inspectorHtml, kindLabel } from "./panels";
import { openPalette } from "./palette";
import { showContextMenu, showHelp, toast } from "./overlays";
import { handleKey } from "./keys";

type CompareMode = "baseline" | "latest";
type Panel = "changes" | "inspector" | null;

interface FileMemory {
  sheet?: string;
  collapsed?: Record<string, number[]>;
  panel?: Panel;
  scroll?: Record<string, { top: number; left: number }>;
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

export class App {
  api!: Api;
  info: BookInfo | null = null;
  path: string | null = null;
  displayed: number | null = null;
  latest: number | null = null;
  baseline: number | null = null;
  previousBaseline: number | null = null;
  compareMode: CompareMode = "baseline";
  paused = false;
  private openToken = 0;
  /** Versions that arrived while paused. */
  pending = new Set<number>();
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
  /** The sheet the user last asked for, by name; display() honours it. */
  wantedSheet: string | null = null;
  /** Whether n/N step through edits only (true unless the version has none). */
  onlyEdits = true;
  private inspecting = "";
  private loadToken = 0;

  constructor() {
    this.grid = new Grid({
      select: (s) => this.onSelect(s),
      toggleGroup: (y) => this.toggleYear(y),
      setLevel: (years) => this.setLevel(years),
      contextMenu: (x, y) => showContextMenu(this, x, y),
      hoverCell: (r, c, x, y) => this.hover(r, c, x, y),
    });
  }

  // ------------------------------------------------------------- startup

  async start() {
    // WebKitGTK (the Linux webview) rounds glyph advances at small sizes and
    // squeezes word spaces; styles.css compensates under this class.
    const ua = navigator.userAgent;
    if (/Linux/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) document.documentElement.classList.add("webkitgtk");
    this.theme = localStorage.getItem("totalrecalc.theme") === "dark" ? "dark" : "light";
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
    document.addEventListener("keydown", (e) => handleKey(this, e));
    window.setInterval(() => this.renderTopBar(), 15000);
    const initial = await this.api.initialPath();
    if (initial) await this.open(initial);
    else this.showStart();
  }

  showStart() {
    document.body.classList.add("empty");
    $("#start").innerHTML = `
      <div class="start-card">
        <img class="start-mark" src="${import.meta.env.BASE_URL}totalrecalc-mark.svg" alt="" />
        <h1>Total Recalc</h1>
        <p class="tagline">Open your mind. Not your file.</p>
        <p>Watch a spreadsheet while an AI agent edits it.</p>
        <button class="primary" id="open-btn">${icon("open")} Open a workbook…</button>
        <div class="drop-hint">or drop an <b>.xlsx</b> file anywhere</div>
        <div class="start-foot">Read-only: Total Recalc never locks or writes your file.</div>
      </div>`;
    $("#open-btn").onclick = () => this.pick();
  }

  async pick() {
    const p = await this.api.pickFile();
    if (p) await this.open(p);
  }

  async open(path: string) {
    document.body.classList.remove("empty");
    this.loadToken++;
    this.path = path;
    this.info = null;
    this.displayed = this.latest = this.baseline = this.previousBaseline = null;
    this.paused = false;
    this.pending.clear();
    this.data = null;
    this.history = [];
    this.watch = { state: "loading" };
    this.renderTopBar();
    $("#loading").classList.add("on");
    const opening = ++this.openToken;
    try {
      const opened = await this.api.openFile(path);
      if (opening !== this.openToken) return;
      this.path = opened.path;
    } catch (e) {
      $("#loading").classList.remove("on");
      toast(`Could not open ${path}: ${e}`, "info");
      if (!this.info) this.showStart();
      return;
    }
    const mem = this.memory();
    this.collapsed = new Map(Object.entries(mem.collapsed ?? {}).map(([k, v]) => [k, new Set(v)]));
    this.panel = mem.panel ?? null;
  }

  memory(): FileMemory {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(`totalrecalc.file:${this.path}`) ?? "{}");
      return parsed && typeof parsed === "object" ? (parsed as FileMemory) : {};
    } catch {
      return {};
    }
  }

  remember() {
    if (!this.path || !this.data) return;
    const mem: FileMemory = {
      sheet: this.data.meta.name,
      collapsed: Object.fromEntries([...this.collapsed].map(([k, v]) => [k, [...v]])),
      panel: this.panel,
      scroll: { ...(this.memory().scroll ?? {}), [this.data.meta.name]: this.grid.scrollPos },
    };
    try {
      localStorage.setItem(`totalrecalc.file:${this.path}`, JSON.stringify(mem));
    } catch {
      /* storage unavailable */
    }
  }

  // ------------------------------------------------------------ versions

  onVersion(id: number, _calculated: boolean) {
    this.latest = Math.max(this.latest ?? 0, id);
    if (this.baseline === null) this.baseline = id;
    if (this.paused && this.displayed !== null && id !== this.displayed) {
      this.pending.add(id);
      this.renderTopBar();
      return;
    }
    void this.display(id, { announce: this.displayed !== null && this.displayed !== id });
  }

  compareRef(version: number, versions = this.info?.versions ?? []): number | undefined {
    if (this.compareMode === "baseline") return this.baseline ?? undefined;
    return versions
      .map((v) => v.id)
      .filter((v) => v < version)
      .pop();
  }

  /**
   * Show a version. Everything is fetched first and committed at once, and a
   * newer request (another version, a sheet switch, Pause) abandons this one.
   */
  async display(id: number, opts: { announce?: boolean } = {}) {
    const token = ++this.loadToken;
    const prevDisplayed = this.displayed;
    const anchor = this.anchor();
    try {
      const plain = await this.api.bookInfo(id, undefined);
      if (token !== this.loadToken) return;
      let ref = this.compareRef(id, plain.versions);
      let info = ref !== undefined && ref !== id ? await this.api.bookInfo(id, ref) : plain;
      if (info.compareMissing && this.compareMode === "baseline") {
        // The baseline aged out of memory: fall back to the oldest version held.
        this.baseline = plain.versions[0]?.id ?? id;
        ref = this.baseline;
        info = await this.api.bookInfo(id, ref);
        toast("The baseline was no longer held; comparing with the oldest version", "info");
      }
      if (token !== this.loadToken) return;
      // Stay on the same sheet by name, even if sheets were added or reordered.
      const wanted = this.wantedSheet ?? this.data?.meta.name ?? this.memory().sheet;
      let index = info.sheets.findIndex((s) => s.name === wanted);
      if (index < 0) index = prevDisplayed === null ? Math.max(0, info.sheets.findIndex((s) => !s.hidden)) : Math.min(this.sheetIndex, info.sheets.length - 1);
      const payload = await this.api.sheet(id, index, ref !== id ? ref : undefined);
      if (token !== this.loadToken) return;
      this.info = info;
      this.displayed = id;
      this.sheetIndex = index;
      if (this.watch.state === "loading") this.watch = info.watch;
      this.applySheet(new SheetData(payload), prevDisplayed === null ? "first" : anchor);
      $("#loading").classList.remove("on");
      void this.api.pinVersions([this.displayed, this.baseline, this.previousBaseline].filter((v): v is number => v !== null));
      if (opts.announce && prevDisplayed !== null) {
        const fresh = await this.api.sheetChanges(id, index, prevDisplayed);
        if (token !== this.loadToken) return;
        if (fresh) this.grid.wake(fresh.changes, reducedMotion.matches);
        const update = await this.api.bookInfo(id, prevDisplayed);
        if (token !== this.loadToken) return;
        // If nothing that changed is on screen, offer to go there.
        const seen = (fresh?.changes ?? []).some((ch) => this.grid.isOnScreen(ch.r, ch.c));
        const hasEdits = update.edits + update.rowsAdded > 0;
        // In an embedded replay (?follow), go straight to the first edit.
        if (!seen && !this.api.desktop && new URLSearchParams(location.search).has("follow")) {
          toast(this.updateSentence(update), "update");
          void this.stepChange(1);
          return;
        }
        toast(this.updateSentence(update), "update", !seen && (hasEdits || update.results) ? { label: "Show", run: () => void this.stepChange(1) } : undefined);
      }
    } catch (e) {
      if (token === this.loadToken) toast(`Could not show that version: ${e}`, "info");
    }
  }

  updateSentence(i: BookInfo): string {
    const n = (x: number) => x.toLocaleString("en-US");
    const parts: string[] = [];
    const edited = i.sheets.filter((s) => s.edits + s.structure > 0);
    const where = edited.length === 1 ? ` on ${edited[0].name}` : edited.length > 1 ? ` on ${edited.length} sheets` : "";
    if (i.edits) parts.push(`${n(i.edits)} edit${i.edits === 1 ? "" : "s"}${where}`);
    if (i.results) parts.push(`${n(i.results)} recalculated`);
    if (i.rowsAdded) parts.push(`${n(i.rowsAdded)} row${i.rowsAdded === 1 ? "" : "s"} added`);
    if (i.rowsRemoved) parts.push(`${n(i.rowsRemoved)} removed`);
    return parts.length ? `Updated · ${parts.join(" · ")}` : "Updated · no visible changes";
  }

  /**
   * Switch to another sheet. The index is committed together with the sheet's
   * data, so the grid and everything that reads `sheetIndex` always agree. If
   * a newer version arrived while this was in flight (and its display was
   * abandoned for this one), show it now.
   */
  async loadSheet(index = this.sheetIndex) {
    if (!this.info || this.displayed === null) return;
    const token = ++this.loadToken;
    this.wantedSheet = this.info.sheets[index]?.name ?? null;
    const version = this.displayed;
    const ref = this.compareRef(version);
    // Large sheets take a moment to arrive; say so if it is noticeable.
    const slow = window.setTimeout(() => {
      $("#loading span").textContent = `Loading ${this.info?.sheets[index]?.name ?? "sheet"}…`;
      $("#loading").classList.add("on");
    }, 180);
    try {
      this.remember();
      const payload = await this.api.sheet(version, index, ref !== version ? ref : undefined);
      if (token !== this.loadToken) return;
      this.sheetIndex = index;
      this.applySheet(new SheetData(payload), "fresh");
    } catch (e) {
      if (token === this.loadToken) toast(`Could not load the sheet: ${e}`, "info");
    } finally {
      clearTimeout(slow);
      $("#loading").classList.remove("on");
      $("#loading span").textContent = "Reading workbook…";
    }
    if (token === this.loadToken && !this.paused && this.latest !== null && this.latest !== this.displayed) {
      void this.display(this.latest, { announce: true });
    }
  }

  /** Put a loaded sheet on screen: keep the place (anchor), or start fresh. */
  applySheet(data: SheetData, place: Anchor | null | "first" | "fresh") {
    const sameSheet = this.data?.meta.name === data.meta.name;
    this.data = data;
    this.inspection = null;
    this.groups = yearGroups(data.meta);
    const collapsed = this.collapsed.get(data.meta.name) ?? new Set<number>();
    for (const y of [...collapsed]) if (!this.groups.some((g) => g.year === y)) collapsed.delete(y);
    this.collapsed.set(data.meta.name, collapsed);
    this.grid.setSheet(data, this.info!.styles, this.groups, collapsed, buildViewCols(data.meta, this.groups, collapsed));
    if (place && typeof place === "object" && sameSheet) this.restore(place);
    else {
      const saved = this.memory().scroll?.[data.meta.name];
      this.grid.scrollPos = saved ?? { top: 0, left: 0 };
      const r = Math.min(this.grid.rowCount - 1, Math.max(0, data.meta.headerRow ?? 0));
      const c = Math.min(this.grid.colCount - 1, Math.max(0, data.meta.labelCols));
      this.grid.setSelection({ row: r, col: c, row2: r, col2: c }, !saved);
    }
    this.remember();
    this.renderAll();
  }

  // Keeping your place: both corners of the selection are identified by meaning.
  anchor(): Anchor | null {
    const d = this.data;
    if (!d) return null;
    const point = (vr: number, vcIndex: number): Point | null => {
      const row = this.grid.rowOf(vr);
      const vc = this.grid.colOf(vcIndex);
      if (row === undefined || !vc || vc.kind !== "sheet") return null;
      return { label: d.rowLabel(row), occurrence: occurrence(d, row), row, header: d.colHeader(vc.col), col: vc.col };
    };
    const s = this.grid.sel;
    const active = point(s.row, s.col);
    if (!active) return null;
    return { active, other: point(s.row2, s.col2) ?? active, offset: this.grid.rowScreenOffset(s.row), left: this.grid.scrollPos.left };
  }

  /** Where a quarter hidden inside a collapsed year now shows: the year's own column. */
  yearColumn(col: number): number | undefined {
    const g = this.groups.find((g) => g.quarters.includes(col));
    if (!g) return undefined;
    if (g.annual !== null) return this.grid.viewColOf(g.annual);
    const i = this.grid.viewCols.findIndex((vc) => vc.kind === "derived" && vc.group.year === g.year);
    return i >= 0 ? i : undefined;
  }

  restore(a: Anchor) {
    const d = this.data!;
    const find = (p: Point): [number, number] => {
      let row = p.row;
      if (p.label) {
        let seen = 0;
        for (let r = 1; r <= d.meta.maxRow; r++) {
          if (d.rowLabel(r) === p.label && ++seen === p.occurrence) {
            row = r;
            break;
          }
        }
      }
      let col = p.col;
      if (p.header) {
        for (let c = 1; c <= d.meta.maxCol; c++) {
          if (d.colHeader(c) === p.header) {
            col = c;
            break;
          }
        }
      }
      return [this.grid.viewRowOf(row) ?? 0, this.grid.viewColOf(col) ?? this.yearColumn(col) ?? 0];
    };
    const [r, c] = find(a.active);
    const [r2, c2] = find(a.other);
    this.grid.scrollPos = { top: this.grid.scrollPos.top, left: a.left };
    this.grid.setRowScreenOffset(r, a.offset);
    this.grid.setSelection({ row: r, col: c, row2: r2, col2: c2 }, false);
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
    toast(`Baseline set to ${this.versionName(this.baseline)}`, "info", { label: "Undo", run: () => this.undoBaseline() });
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
    if (this.paused) {
      // Abandon any version that was on its way to the screen.
      this.loadToken++;
      if (this.latest !== null && this.latest !== this.displayed) this.pending.add(this.latest);
    } else {
      const n = this.pending.size;
      this.pending.clear();
      if (this.latest !== null && this.latest !== this.displayed) void this.display(this.latest, { announce: true });
      else if (n === 0) toast("Resumed · nothing changed while paused", "info");
    }
    this.renderTopBar();
  }

  async switchSheet(i: number) {
    if (!this.info || i < 0 || i >= this.info.sheets.length || i === this.sheetIndex) return;
    await this.loadSheet(i);
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
    localStorage.setItem("totalrecalc.theme", this.theme);
    this.applyTheme();
    this.renderTopBar();
  }

  /**
   * Step through edits in reading order, across sheets. Recalculated results
   * are reached from the Changes panel; when a version has no edits at all,
   * stepping falls back to results.
   */
  async stepChange(dir: 1 | -1) {
    const d = this.data;
    if (!d || !this.info) return;
    this.onlyEdits = this.info.edits + this.info.rowsAdded > 0;
    const list = this.visibleChanges();
    const cur = { r: this.grid.rowOf(this.grid.sel.row) ?? 0, c: this.currentCol() ?? 0 };
    const idx = dir > 0 ? list.findIndex((ch) => ch.r > cur.r || (ch.r === cur.r && ch.c > cur.c)) : findLastIndex(list, (ch) => ch.r < cur.r || (ch.r === cur.r && ch.c < cur.c));
    if (idx >= 0) return this.goToChange(list[idx]);
    // Move on to the next sheet that has changes.
    const n = this.info.sheets.length;
    for (let k = 1; k < n; k++) {
      const i = (this.sheetIndex + dir * k + n) % n;
      const s = this.info.sheets[i];
      if (this.onlyEdits ? s.edits + s.structure > 0 : s.results > 0) {
        await this.loadSheet(i);
        const l = this.visibleChanges();
        if (l.length) this.goToChange(dir > 0 ? l[0] : l[l.length - 1]);
        this.flashRail(i);
        return;
      }
    }
    if (list.length) this.goToChange(dir > 0 ? list[0] : list[list.length - 1]);
  }

  visibleChanges(): CellChange[] {
    const all = this.data?.changeList ?? [];
    return this.onlyEdits ? all.filter((c) => c.kind !== "result") : all;
  }

  flashRail(i: number) {
    const el = document.querySelector(`#rail [data-i="${i}"]`);
    el?.classList.remove("flash");
    void (el as HTMLElement | null)?.offsetWidth;
    el?.classList.add("flash");
  }

  versionName(id: number | null): string {
    const vs = this.info?.versions ?? [];
    const v = vs.find((x) => x.id === id);
    if (!v) return "an earlier version";
    return `v${vs.indexOf(v) + 1} · ${clock(v.at)}`;
  }

  async copyChangeReport() {
    await this.writeClipboard(changeReport(this), "the change report");
  }

  async writeClipboard(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${what}`, "info");
    } catch {
      toast("Couldn't reach the clipboard", "info");
    }
  }

  goToChange(ch: CellChange) {
    let vc = this.grid.viewColOf(ch.c);
    if (vc === undefined) {
      // Hidden in a collapsed year: open it.
      const g = this.groups.find((g) => g.quarters.includes(ch.c));
      if (g) {
        this.collapsed.get(this.data!.meta.name)!.delete(g.year);
        this.relayout();
        toast(`Expanded ${g.year} to show the change`, "info", { label: "Collapse", run: () => this.toggleYear(g.year) });
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
      await this.loadSheet(sheetIndex);
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
      const lines = [`**${this.info.fileName}** · sheet **${d.meta.name}** · ${this.versionName(this.displayed)}`, ""];
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
    await this.writeClipboard(text, `${count} cell${count === 1 ? "" : "s"}${withContext ? " with context" : ""}`);
  }

  nextVisibleSheet(dir: 1 | -1): number {
    const sheets = this.info?.sheets ?? [];
    for (let k = 1; k <= sheets.length; k++) {
      const i = (this.sheetIndex + dir * k + sheets.length) % sheets.length;
      if (!sheets[i].hidden) return i;
    }
    return this.sheetIndex;
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
    this.inspecting = "";
    this.renderPeek();
    this.renderStatus();
    clearTimeout(this.selectTimer);
    if (this.panel === "inspector") this.selectTimer = window.setTimeout(() => void this.inspect(), 60);
    else if (this.panel === "changes") this.highlightChangeRow();
  }

  async inspect() {
    const d = this.data;
    const c = this.currentCol();
    const version = this.displayed;
    if (!d || version === null || c === undefined) {
      // A derived column or nothing selected: nothing to look up.
      this.inspection = { inputs: [], usedBy: [] };
      this.renderPanel();
      return;
    }
    const r = this.grid.rowOf(this.grid.sel.row);
    const key = `${version}:${this.sheetIndex}:${r}:${c}`;
    this.inspecting = key;
    try {
      const result = await this.api.inspect(version, this.sheetIndex, r, c);
      if (this.inspecting !== key) return;
      this.inspection = result;
    } catch {
      if (this.inspecting !== key) return;
      this.inspection = { inputs: [], usedBy: [] };
    }
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
      <div id="toasts" role="status" aria-live="polite"></div>
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
      live = `<span class="live paused">${icon("pause")} Paused${this.pending.size ? ` · <b>${this.pending.size} newer version${this.pending.size === 1 ? "" : "s"}</b>` : ""}</span>`;
    } else if (w.state === "error") {
      const since = w.since ? ` since ${clock(w.since)}` : "";
      live = `<span class="live error" title="${esc(`${w.message ?? "Cannot read the file"}${since}. Total Recalc keeps trying and keeps showing the last good version.`)}">${icon("alert")} Can't read the file${this.displayed ? ` · showing ${this.versionName(this.displayed).split(" · ")[0]}` : ""}</span>`;
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
        ? `<button class="headline" data-act="changes" title="Show changes (d)"><b class="edits">${i.edits.toLocaleString("en-US")}</b> <span class="hl-word">edit${i.edits === 1 ? "" : "s"}</span><span class="sep">·</span><b class="results">${i.results.toLocaleString("en-US")}</b> <span class="hl-word">result${i.results === 1 ? "" : "s"}</span>${i.rowsAdded ? `<span class="sep">·</span>${i.rowsAdded} row${i.rowsAdded === 1 ? "" : "s"} added` : ""}${i.rowsRemoved ? `<span class="sep">·</span>${i.rowsRemoved} removed` : ""}<span class="muted"> ${this.compareMode === "baseline" ? `since v${(this.info?.versions.findIndex((v) => v.id === this.baseline) ?? 0) + 1}` : "in latest update"}</span></button>`
        : `<span class="headline quiet">No changes ${this.compareMode === "baseline" ? "since baseline" : "in latest update"}</span>`
      : "";
    bar.innerHTML = `
      <div class="brand" title="Total Recalc"><img src="${import.meta.env.BASE_URL}totalrecalc-mark.svg" alt="" /></div>
      <div class="file">
        <span class="name">${esc(fileName ?? "")}</span>
        <span class="folder">${esc(i?.folder ?? "")}</span>
      </div>
      ${live}
      ${at ? `<span class="version" title="Version shown">${icon("clock")} ${clock(at)} <span class="muted">${ago(at)}</span></span>` : ""}
      <div class="spacer"></div>
      ${headline}
      <div class="nav">
        <button class="icon" data-act="prev" title="Previous edit (Shift+N)">${icon("up")}</button>
        <button class="icon" data-act="next" title="Next edit (N)">${icon("down")}</button>
      </div>
      <button class="icon ${this.paused ? "active" : ""}" data-act="pause" title="${this.paused ? "Resume (Space)" : "Pause: hold this version while you look (Space)"}">${icon(this.paused ? "play" : "pause")}</button>
      <button class="ghost" data-act="baseline" title="Make this version the baseline (F5)">${icon("flag")}<span class="label">Set baseline</span></button>
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
      if (act === "palette") openPalette(this);
      if (act === "theme") this.toggleTheme();
    };
    document.title = fileName ? `${fileName} — Total Recalc` : "Total Recalc";
  }

  /** Step to the next cell showing a value from the file's cache. */
  nextCachedCell() {
    const d = this.data;
    if (!d) return;
    const cells = [...d.allCells()].filter((c) => c.calc !== 0).sort((a, b) => a.r - b.r || a.c - b.c);
    if (!cells.length) return toast("No values from the file's cache on this sheet; they are on other sheets", "info");
    const cur = { r: this.grid.rowOf(this.grid.sel.row), c: this.currentCol() ?? 0 };
    const next = cells.find((x) => x.r > cur.r || (x.r === cur.r && x.c > cur.c)) ?? cells[0];
    void this.jumpTo(this.sheetIndex, next.r, next.c, false);
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
    // In the label columns the cell is its own label: don't say it twice.
    const isLabel = vc.col <= d.meta.labelCols;
    const what = isLabel ? header : [label, header].filter(Boolean).join(" · ");
    el.innerHTML = `
      <span class="addr">${address(row, vc.col)}</span>
      ${what ? `<span class="what">${esc(what)}</span>` : ""}
      <span class="value ${cell?.error ? "err" : ""} ${cell?.text ? "" : "empty"}">${esc(cell?.text || "blank")}</span>
      ${ch ? `<span class="was">was ${esc(shortValue(ch.beforeValue, ch.beforeText))}</span>${dl ? `<span class="delta">${esc(dl)}</span>` : ""}${kind}` : ""}
      ${cell?.calc === 1 ? `<span class="calc-note" title="Total Recalc's engine cannot evaluate this formula faithfully (or it depends on one that it cannot), so the value Excel saved in the file is shown">from file cache</span>` : ""}
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
          const n = s.edits + s.structure;
          const badge = n
            ? `<span class="badge edits" title="${s.edits} edit${s.edits === 1 ? "" : "s"}${s.structure ? `, ${s.structure} rows added or removed` : ""}, ${s.results} recalculated">${n}</span>`
            : s.results
              ? `<span class="dot-results" title="${s.results} recalculated"></span>`
              : "";
          const initials = s.name.split(/[\s&_-]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || s.name.slice(0, 2);
          return `<button class="sheet ${idx === this.sheetIndex ? "on" : ""} ${s.newSheet ? "new" : ""}" data-i="${idx}" aria-label="${esc(s.name)}"><span class="ini">${esc(initials)}</span><span class="nm">${esc(s.name)}</span>${badge}</button>`;
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
    const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) >= 100 ? 1 : 3 });
    const sel =
      nums.length > 1
        ? `<span>Sum <b>${fmt(sum)}</b></span><span>Avg <b>${fmt(sum / nums.length)}</b></span><span>Count <b>${cells.filter(({ r, c }) => d.cell(r, c)?.text).length}</b></span>`
        : "";
    const row = this.grid.rowOf(this.grid.sel.row);
    const vc = this.grid.colOf(this.grid.sel.col);
    const addr = vc?.kind === "sheet" ? `${d.meta.name}!${colLetters(vc.col)}${row}` : d.meta.name;
    const c = i.calc;
    const calc = !c.calculated
      ? `<span class="calc pending">Recalculating…</span>`
      : c.cached || c.unavailable
        ? `<button class="calc warn" data-act="cached" title="Formulas Total Recalc's engine cannot evaluate faithfully show the value Excel saved. Click to step through them.">${c.cached ? `${c.cached.toLocaleString()} from file cache` : ""}${c.cached && c.unavailable ? " · " : ""}${c.unavailable ? `${c.unavailable.toLocaleString()} unavailable` : ""}</button>`
        : `<span class="calc ok">${icon("check")} All values calculated</span>`;
    el.innerHTML = `
      <span class="addr">${esc(addr)}</span>
      ${sel}
      <div class="spacer"></div>
      ${c.errors ? `<span class="errs" title="Cells showing an error">${c.errors} error${c.errors === 1 ? "" : "s"}</span>` : ""}
      ${calc}
      ${d.meta.frozenInferred ? `<span class="muted" title="The file has no frozen panes; Total Recalc froze the header row and label columns it found">Freeze: inferred</span>` : ""}
      <span class="muted">${Math.round(this.grid.getZoom() * 100)}%</span>
      <button class="link" data-act="help">? Shortcuts</button>`;
    el.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-act=help]")) showHelp(this);
      if (t.closest("[data-act=cached]")) this.nextCachedCell();
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
      <div class="panel-body">${this.panel === "changes" ? changesHtml(this) : inspectorHtml(this)}</div>`;
    el.onclick = (e) => this.onPanelClick(e);
    if (this.panel === "inspector" && !this.inspection) void this.inspect();
    if (this.panel === "changes") this.highlightChangeRow();
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
    const ref = t.closest<HTMLElement>(".ref, button.fref");
    if (ref) return void this.jumpTo(Number(ref.dataset.sheet ?? this.sheetIndex), Number(ref.dataset.r), Number(ref.dataset.c));
    const sheetRow = t.closest<HTMLElement>("[data-sheet]");
    if (sheetRow?.classList.contains("sheetrow")) return void this.switchSheet(Number(sheetRow.dataset.sheet));
    const row = t.closest<HTMLElement>(".chrow[data-r]");
    // jumpTo opens a collapsed year if the change is inside it.
    if (row) void this.jumpTo(this.sheetIndex, Number(row.dataset.r), Number(row.dataset.c), false);
  }

  highlightChangeRow() {
    const row = this.grid.rowOf(this.grid.sel.row);
    document.querySelectorAll(".chrow.current").forEach((el) => el.classList.remove("current"));
    document.querySelector(`.chrow[data-r="${row}"]`)?.classList.add("current");
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
    // Long labels clipped by their column: show the whole text.
    const clipped = !!cell && typeof cell.value === "string" && cell.text.length * 7 > vc.width * this.grid.getZoom() - 10 && vc.col <= d.meta.labelCols;
    if (!ch && !cell?.comment && !clipped) return void tip.classList.remove("on");
    const percent = !!this.info?.styles[cell?.style ?? 0]?.percent;
    tip.innerHTML = `${clipped && !ch ? `<div>${esc(cell!.text)}</div>` : ""}${ch ? `<div><span class="kind k-${ch.kind}">${kindLabel(ch.kind)}</span> ${esc(shortValue(ch.beforeValue, ch.beforeText))} → <b>${esc(cell?.text || "blank")}</b> <span class="delta">${esc(delta(ch.beforeValue, cell?.value ?? null, cell?.text ?? "", percent))}</span></div>` : ""}${cell?.comment ? `<div class="tip-note">${esc(cell.comment)}</div>` : ""}`;
    tip.style.left = `${Math.min(x + 14, innerWidth - 340)}px`;
    tip.style.top = `${y + 18}px`;
    tip.classList.add("on");
  }
}

interface Point {
  label: string;
  occurrence: number;
  row: number;
  header: string;
  col: number;
}

interface Anchor {
  active: Point;
  other: Point;
  offset: number;
  left: number;
}

function occurrence(d: SheetData, row: number): number {
  const label = d.rowLabel(row);
  let n = 0;
  for (let r = 1; r <= row; r++) if (d.rowLabel(r) === label) n++;
  return n;
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

const app = new App();
void app.start();
