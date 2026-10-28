// The spreadsheet grid. Only the visible cells are in the DOM; the sheet is
// split into frozen and scrolling panes that move with the native scrollbars.

import type { CellStyle, ChangeKind } from "./types";
import type { SheetData } from "./sheet";
import { colLetters } from "./sheet";
import { type ViewCol, type YearGroup, derivedValue, periodLabel } from "./periods";
import { type Theme, workbookColors } from "./theme";

const ROW_HEAD_W = 46;
const LETTER_H = 22;
const GROUP_H = 22;
const DEFAULT_ROW_H = 24;
const OVERSCAN_ROWS = 24;
const OVERSCAN_COLS = 8;

export interface Selection {
  /** Active cell, as view indices. */
  row: number;
  col: number;
  /** The other corner of the range, as view indices. */
  row2: number;
  col2: number;
}

export interface GridEvents {
  select(sel: Selection): void;
  toggleGroup(year: number): void;
  setLevel(collapsed: boolean): void;
  contextMenu(x: number, y: number): void;
  hoverCell(row: number | null, col: number | null, x: number, y: number): void;
}

interface Region {
  pane: HTMLDivElement;
  inner: HTMLDivElement;
  cells: HTMLDivElement;
  overlay: HTMLDivElement;
  rendered: { r0: number; r1: number; c0: number; c1: number } | null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class Grid {
  readonly el: HTMLDivElement;
  private viewport: HTMLDivElement;
  private sizer: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private ticksY: HTMLDivElement;
  private ticksX: HTMLDivElement;
  private regions: Record<string, Region> = {};

  private data: SheetData | null = null;
  private styles: CellStyle[] = [];
  private theme: Theme = "light";
  private groups: YearGroup[] = [];
  private collapsed = new Set<number>();

  viewCols: ViewCol[] = [];
  viewRows: number[] = [];
  private colX: number[] = [0];
  private rowY: number[] = [0];
  private rowIndex = new Map<number, number>();
  private colIndex = new Map<number, number>();
  private frozenR = 0;
  private frozenC = 0;
  private frozenW = 0;
  private frozenH = 0;
  private headH = LETTER_H;
  private merges = new Map<number, [number, number, number, number]>();
  private covered = new Set<number>();
  private zoom = 1;

  sel: Selection = { row: 0, col: 0, row2: 0, col2: 0 };
  private pulses = new Map<number, number>(); // key -> delay ms
  private pulseUntil = 0;
  private dragging = false;
  private raf = 0;

  constructor(private events: GridEvents) {
    this.el = document.createElement("div");
    this.el.className = "grid";
    this.styleEl = document.createElement("style");
    document.head.appendChild(this.styleEl);
    this.viewport = document.createElement("div");
    this.viewport.className = "grid-viewport";
    this.viewport.tabIndex = 0;
    this.sizer = document.createElement("div");
    this.sizer.className = "grid-sizer";
    this.viewport.appendChild(this.sizer);
    this.el.appendChild(this.viewport);
    for (const name of ["corner", "top", "left", "main", "hdrFrozen", "hdrScroll", "grpFrozen", "grpScroll", "rowFrozen", "rowScroll", "box"]) {
      const pane = document.createElement("div");
      pane.className = `grid-pane pane-${name}`;
      const inner = document.createElement("div");
      inner.className = "grid-inner";
      const cells = document.createElement("div");
      const overlay = document.createElement("div");
      overlay.className = "grid-overlay";
      inner.append(cells, overlay);
      pane.appendChild(inner);
      this.el.appendChild(pane);
      this.regions[name] = { pane, inner, cells, overlay, rendered: null };
    }
    this.ticksY = document.createElement("div");
    this.ticksY.className = "ticks ticks-y";
    this.ticksX = document.createElement("div");
    this.ticksX.className = "ticks ticks-x";
    this.el.append(this.ticksY, this.ticksX);

    this.viewport.addEventListener("scroll", () => this.schedule());
    new ResizeObserver(() => this.schedule(true)).observe(this.el);
    this.viewport.addEventListener("mousedown", (e) => this.onMouseDown(e));
    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", () => (this.dragging = false));
    this.viewport.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const hit = this.hit(e);
      if (hit && hit.row >= 0 && hit.col >= 0 && !this.inSelection(hit.row, hit.col)) this.select(hit.row, hit.col);
      this.events.contextMenu(e.clientX, e.clientY);
    });
    this.viewport.addEventListener("mouseleave", () => this.events.hoverCell(null, null, 0, 0));
    this.viewport.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        }
      },
      { passive: false },
    );
    this.el.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-year],[data-level]");
      if (!t) return;
      if (t.dataset.year) this.events.toggleGroup(Number(t.dataset.year));
      if (t.dataset.level) this.events.setLevel(t.dataset.level === "years");
    });
  }

  focus() {
    this.viewport.focus({ preventScroll: true });
  }

  // --------------------------------------------------------------- content

  setTheme(theme: Theme) {
    this.theme = theme;
    this.writeStyleSheet();
    this.schedule(true);
  }

  setZoom(z: number) {
    this.zoom = Math.min(2, Math.max(0.6, z));
    this.el.style.setProperty("--zoom", String(this.zoom));
    if (this.data) this.layout();
    this.schedule(true);
  }

  getZoom() {
    return this.zoom;
  }

  setSheet(data: SheetData, styles: CellStyle[], groups: YearGroup[], collapsed: Set<number>, viewCols: ViewCol[]) {
    const stylesChanged = styles !== this.styles;
    this.data = data;
    this.styles = styles;
    this.groups = groups;
    this.collapsed = collapsed;
    this.viewCols = viewCols;
    if (stylesChanged) this.writeStyleSheet();
    this.merges.clear();
    this.covered.clear();
    for (const m of data.meta.merges) {
      this.merges.set(m[0] * 20000 + m[1], m);
      for (let r = m[0]; r <= m[2]; r++) for (let c = m[1]; c <= m[3]; c++) if (r !== m[0] || c !== m[1]) this.covered.add(r * 20000 + c);
    }
    this.layout();
    this.schedule(true);
  }

  private layout() {
    const d = this.data!;
    const z = this.zoom;
    const hiddenRows = new Set(d.meta.hiddenRows);
    this.viewRows = [];
    for (let r = 1; r <= d.meta.maxRow; r++) if (!hiddenRows.has(r)) this.viewRows.push(r);
    if (this.viewRows.length === 0) this.viewRows.push(1);
    this.rowY = [0];
    this.rowIndex.clear();
    this.viewRows.forEach((r, i) => {
      this.rowIndex.set(r, i);
      this.rowY.push(this.rowY[i] + Math.round((d.meta.rowHeights[r] ?? DEFAULT_ROW_H) * z));
    });
    this.colX = [0];
    this.colIndex.clear();
    this.viewCols.forEach((vc, i) => {
      if (vc.kind === "sheet") this.colIndex.set(vc.col, i);
      this.colX.push(this.colX[i] + Math.round(vc.width * z));
    });
    this.frozenR = this.viewRows.filter((r) => r <= d.meta.frozenRows).length;
    this.frozenC = this.viewCols.filter((vc) => vc.kind === "sheet" && vc.col <= d.meta.frozenCols).length;
    this.frozenW = this.colX[this.frozenC];
    this.frozenH = this.rowY[this.frozenR];
    this.headH = LETTER_H + (this.groups.length ? GROUP_H : 0);
    this.sizer.style.width = `${ROW_HEAD_W + this.colX[this.colX.length - 1] + 2}px`;
    this.sizer.style.height = `${this.headH + this.rowY[this.rowY.length - 1] + 2}px`;
    for (const r of Object.values(this.regions)) r.rendered = null;
    this.clampSelection();
    this.renderTicks();
  }

  rowOf(view: number) {
    return this.viewRows[view];
  }

  colOf(view: number): ViewCol | undefined {
    return this.viewCols[view];
  }

  viewRowOf(row: number): number | undefined {
    return this.rowIndex.get(row);
  }

  viewColOf(col: number): number | undefined {
    return this.colIndex.get(col);
  }

  get rowCount() {
    return this.viewRows.length;
  }

  get colCount() {
    return this.viewCols.length;
  }

  /** Visible rows per page, for PgUp/PgDn. */
  get pageRows() {
    return Math.max(1, Math.floor((this.viewport.clientHeight - this.headH - this.frozenH) / (DEFAULT_ROW_H * this.zoom)) - 1);
  }

  // ------------------------------------------------------------ stylesheet

  private writeStyleSheet() {
    const z = "var(--zoom, 1)";
    const css: string[] = [];
    const edge = (e: { style: string; color: string } | undefined, side: string) => {
      if (!e) return "";
      const w = e.style === "thick" ? 3 : e.style === "medium" || e.style === "double" ? 2 : 1;
      const st = e.style === "double" ? "double" : e.style === "dotted" ? "dotted" : e.style === "dashed" ? "dashed" : "solid";
      const color = workbookColors(this.theme, undefined, e.color).text ?? e.color;
      return `border-${side}:${e.style === "double" ? 3 : w}px ${st} ${color};`;
    };
    this.styles.forEach((s, i) => {
      const { fill, text } = workbookColors(this.theme, s.fill, s.color);
      const size = Math.min(22, Math.max(9, (s.size || 11) * 1.18));
      let rule = `font-size:calc(${size.toFixed(1)}px * ${z});`;
      if (s.bold) rule += "font-weight:600;";
      if (s.italic) rule += "font-style:italic;";
      if (s.underline || s.strike) rule += `text-decoration:${s.underline ? "underline " : ""}${s.strike ? "line-through" : ""};`;
      if (text) rule += `color:${text};`;
      if (fill) rule += `background:${fill};`;
      if (s.align === "left" || s.align === "right" || s.align === "center") rule += `justify-content:${s.align === "left" ? "flex-start" : s.align === "right" ? "flex-end" : "center"};text-align:${s.align};`;
      if (s.valign === "top") rule += "align-items:flex-start;";
      else if (s.valign === "center") rule += "align-items:center;";
      if (s.indent) rule += `padding-left:calc(${4 + s.indent * 10}px * ${z});`;
      if (s.wrap) rule += "white-space:normal;line-height:1.2;";
      rule += edge(s.top, "top") + edge(s.right, "right") + edge(s.bottom, "bottom") + edge(s.left, "left");
      css.push(`.s${i}{${rule}}`);
    });
    this.styleEl.textContent = css.join("\n");
  }

  // ------------------------------------------------------------- rendering

  schedule(force = false) {
    if (force) for (const r of Object.values(this.regions)) r.rendered = null;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render() {
    const d = this.data;
    if (!d) return;
    const W = this.viewport.clientWidth;
    const H = this.viewport.clientHeight;
    const sl = this.viewport.scrollLeft;
    const st = this.viewport.scrollTop;
    const fw = this.frozenW;
    const fh = this.frozenH;
    const hh = this.headH;
    const gh = this.groups.length ? GROUP_H : 0;
    const totalW = this.colX[this.colX.length - 1];
    const totalH = this.rowY[this.rowY.length - 1];
    const lastR = this.viewRows.length;
    const lastC = this.viewCols.length;

    const place = (name: string, left: number, top: number, width: number, height: number, tx: number, ty: number) => {
      const reg = this.regions[name];
      reg.pane.style.cssText = `left:${left}px;top:${top}px;width:${Math.max(0, width)}px;height:${Math.max(0, height)}px`;
      reg.inner.style.transform = `translate(${tx}px,${ty}px)`;
      return reg;
    };
    const scrollW = Math.min(W - ROW_HEAD_W - fw, totalW - fw);
    const scrollH = Math.min(H - hh - fh, totalH - fh);

    // Visible view ranges for scrolling content.
    const c0 = Math.max(this.frozenC, lowerBound(this.colX, fw + sl));
    const c1 = Math.min(lastC, lowerBound(this.colX, fw + sl + Math.max(0, scrollW)) + 1);
    const r0 = Math.max(this.frozenR, lowerBound(this.rowY, fh + st));
    const r1 = Math.min(lastR, lowerBound(this.rowY, fh + st + Math.max(0, scrollH)) + 1);

    const body = (name: string, rs: [number, number], cs: [number, number]) => {
      const reg = this.regions[name];
      const ren = reg.rendered;
      if (ren && ren.r0 <= rs[0] && ren.r1 >= rs[1] && ren.c0 <= cs[0] && ren.c1 >= cs[1]) return;
      const scrollsR = rs[0] >= this.frozenR && rs[1] > this.frozenR && name !== "top" && name !== "corner";
      const scrollsC = cs[0] >= this.frozenC && name !== "left" && name !== "corner";
      const range = {
        r0: scrollsR ? Math.max(this.frozenR, rs[0] - OVERSCAN_ROWS) : rs[0],
        r1: scrollsR ? Math.min(lastR, rs[1] + OVERSCAN_ROWS) : rs[1],
        c0: scrollsC ? Math.max(this.frozenC, cs[0] - OVERSCAN_COLS) : cs[0],
        c1: scrollsC ? Math.min(lastC, cs[1] + OVERSCAN_COLS) : cs[1],
      };
      reg.rendered = range;
      reg.cells.innerHTML = this.cellsHtml(range.r0, range.r1, range.c0, range.c1, cs[0] < this.frozenC ? this.frozenC : lastC);
    };

    // Body panes.
    place("corner", ROW_HEAD_W, hh, fw, fh, 0, 0);
    body("corner", [0, this.frozenR], [0, this.frozenC]);
    place("top", ROW_HEAD_W + fw, hh, scrollW, fh, -fw - sl, 0);
    body("top", [0, this.frozenR], [c0, c1]);
    place("left", ROW_HEAD_W, hh + fh, fw, scrollH, 0, -fh - st);
    body("left", [r0, r1], [0, this.frozenC]);
    place("main", ROW_HEAD_W + fw, hh + fh, scrollW, scrollH, -fw - sl, -fh - st);
    body("main", [r0, r1], [c0, c1]);

    // Column letters and the group bar.
    place("hdrFrozen", ROW_HEAD_W, gh, fw, LETTER_H, 0, 0).cells.innerHTML = this.letterHtml(0, this.frozenC);
    place("hdrScroll", ROW_HEAD_W + fw, gh, scrollW, LETTER_H, -fw - sl, 0).cells.innerHTML = this.letterHtml(c0, c1);
    const gf = place("grpFrozen", ROW_HEAD_W, 0, fw, gh, 0, 0);
    const gs = place("grpScroll", ROW_HEAD_W + fw, 0, scrollW, gh, -fw - sl, 0);
    gf.cells.innerHTML = gh ? this.groupHtml(0, this.frozenC) : "";
    gs.cells.innerHTML = gh ? this.groupHtml(c0, c1) : "";

    // Row numbers.
    place("rowFrozen", 0, hh, ROW_HEAD_W, fh, 0, 0).cells.innerHTML = this.rowNumHtml(0, this.frozenR);
    place("rowScroll", 0, hh + fh, ROW_HEAD_W, scrollH, 0, -fh - st).cells.innerHTML = this.rowNumHtml(r0, r1);
    const box = place("box", 0, 0, ROW_HEAD_W, hh, 0, 0);
    box.cells.innerHTML = gh
      ? `<div class="level-switch"><button data-level="quarters" class="${this.collapsed.size ? "" : "on"}" title="Expand every year (])">Q</button><button data-level="years" class="${this.collapsed.size ? "on" : ""}" title="Collapse to years ([)">Y</button></div>`
      : "";

    this.el.classList.toggle("has-frozen-cols", this.frozenC > 0);
    this.el.classList.toggle("has-frozen-rows", this.frozenR > 0);
    this.el.style.setProperty("--frozen-x", `${ROW_HEAD_W + fw}px`);
    this.el.style.setProperty("--frozen-y", `${hh + fh}px`);
    this.renderSelection();
    if (this.pulses.size && performance.now() > this.pulseUntil) this.pulses.clear();
  }

  private cellsHtml(r0: number, r1: number, c0: number, c1: number, spillLimit: number): string {
    const d = this.data!;
    const out: string[] = [];
    const grid = d.meta.showGrid;
    const z = this.zoom;
    // Gridlines first, so fills and borders paint over them.
    if (grid) {
      const top = this.rowY[r0];
      const bottom = this.rowY[r1];
      const left = this.colX[c0];
      const right = this.colX[c1];
      for (let c = c0 + 1; c <= c1; c++) out.push(`<div class="gl gv" style="left:${this.colX[c] - 1}px;top:${top}px;height:${bottom - top}px"></div>`);
      for (let r = r0 + 1; r <= r1; r++) out.push(`<div class="gl gh" style="top:${this.rowY[r] - 1}px;left:${left}px;width:${right - left}px"></div>`);
    }
    const header = d.meta.headerRow;
    const now = performance.now();
    for (let ri = r0; ri < r1; ri++) {
      const row = this.viewRows[ri];
      const y = this.rowY[ri];
      const h = this.rowY[ri + 1] - y;
      for (let ci = c0; ci < c1; ci++) {
        const vc = this.viewCols[ci];
        const x = this.colX[ci];
        let w = this.colX[ci + 1] - x;
        if (vc.kind === "derived") {
          const text = row === header ? `${periodLabel(vc.group)} Σ` : (derivedValue(d, row, vc.group, this.styles)?.text ?? "");
          const sample = d.cell(row, vc.group.quarters[vc.group.quarters.length - 1]);
          const cls = sample ? `s${sample.style}` : "";
          out.push(`<div class="c derived ${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px" title="Derived from the four quarters">${esc(text)}</div>`);
          continue;
        }
        const col = vc.col;
        const k = row * 20000 + col;
        if (this.covered.has(k)) continue;
        const cell = d.cell(row, col);
        const ch = d.change(row, col);
        if (!cell && !ch) continue;
        let hh = h;
        const m = this.merges.get(k);
        if (m) {
          const lastC = this.colIndex.get(m[3]) ?? ci;
          const lastR = this.rowIndex.get(m[2]) ?? ri;
          w = this.colX[lastC + 1] - x;
          hh = this.rowY[lastR + 1] - y;
        }
        const style = cell ? this.styles[cell.style] : undefined;
        const isNum = cell && typeof cell.value === "number";
        const align = style?.align ?? "general";
        let cls = `c s${cell?.style ?? 0}`;
        if (isNum && align === "general") cls += " num";
        else if (typeof cell?.value === "boolean" && align === "general") cls += " ctr";
        if (cell?.error) cls += " err";
        if (cell && cell.calc === 1) cls += " cached";
        if (cell && cell.calc === 2) cls += " unavail";
        if (cell?.comment) cls += " has-comment";
        if (style?.fill) cls += " filled";
        if (ch) cls += ` k-${ch.kind}`;
        const delay = this.pulses.get(k);
        if (delay !== undefined && now < this.pulseUntil) cls += " pulse";
        // Text spills into empty neighbours on the right, as in Excel.
        let spillW = 0;
        if (cell && !isNum && cell.text && !style?.wrap && (align === "general" || align === "left") && !m) {
          let j = ci + 1;
          while (j < this.viewCols.length && j < spillLimit && this.colX[j] - x < 1200 * z) {
            const n = this.viewCols[j];
            if (n.kind !== "sheet") break;
            const nc = d.cell(row, n.col);
            if ((nc && nc.text) || this.covered.has(row * 20000 + n.col) || d.change(row, n.col)) break;
            j++;
          }
          if (j > ci + 1) {
            cls += " spill";
            spillW = this.colX[j] - x;
          }
        }
        const color = cell?.formatColor ? workbookColors(this.theme, undefined, cell.formatColor).text : null;
        const st = `left:${x}px;top:${y}px;width:${w}px;height:${hh}px${color ? `;color:${color}` : ""}${delay !== undefined ? `;animation-delay:${delay}ms` : ""}`;
        const text = cell ? esc(cell.text) : "";
        const span = spillW ? `<span style="width:${spillW - 8 * z}px">${text}</span>` : `<span>${text}</span>`;
        out.push(`<div class="${cls}" style="${st}">${span}</div>`);
      }
    }
    return out.join("");
  }

  private letterHtml(c0: number, c1: number): string {
    const out: string[] = [];
    const [s0, s1] = [Math.min(this.sel.col, this.sel.col2), Math.max(this.sel.col, this.sel.col2)];
    const added = new Set(this.data?.diff.addedCols ?? []);
    for (let ci = c0; ci < c1; ci++) {
      const vc = this.viewCols[ci];
      const x = this.colX[ci];
      const w = this.colX[ci + 1] - x;
      const label = vc.kind === "sheet" ? colLetters(vc.col) : "Σ";
      const on = ci >= s0 && ci <= s1 ? " on" : "";
      const add = vc.kind === "sheet" && added.has(vc.col) ? " added" : "";
      out.push(`<div class="hd${on}${add}${vc.kind === "derived" ? " derived" : ""}" style="left:${x}px;width:${w}px">${label}</div>`);
    }
    return out.join("");
  }

  private rowNumHtml(r0: number, r1: number): string {
    const out: string[] = [];
    const [s0, s1] = [Math.min(this.sel.row, this.sel.row2), Math.max(this.sel.row, this.sel.row2)];
    const added = new Set(this.data?.diff.addedRows ?? []);
    const removedAfter = new Set(this.data?.diff.removedRows.map((r) => r.after) ?? []);
    for (let ri = r0; ri < r1; ri++) {
      const row = this.viewRows[ri];
      const y = this.rowY[ri];
      const h = this.rowY[ri + 1] - y;
      const on = ri >= s0 && ri <= s1 ? " on" : "";
      const add = added.has(row) ? " added" : "";
      const rem = removedAfter.has(row) ? " removed-below" : "";
      out.push(`<div class="rn${on}${add}${rem}" style="top:${y}px;height:${h}px">${row}</div>`);
    }
    return out.join("");
  }

  private groupHtml(c0: number, c1: number): string {
    const out: string[] = [];
    for (const g of this.groups) {
      const collapsed = this.collapsed.has(g.year);
      const members = [...g.quarters, ...(g.annual !== null ? [g.annual] : [])];
      const idx = members.map((c) => this.colIndex.get(c)).filter((i): i is number => i !== undefined);
      const derivedIdx = this.viewCols.findIndex((vc) => vc.kind === "derived" && vc.group.year === g.year);
      if (derivedIdx >= 0) idx.push(derivedIdx);
      if (!idx.length) continue;
      const lo = Math.min(...idx);
      const hi = Math.max(...idx);
      if (hi < c0 || lo >= c1) continue;
      const x = this.colX[lo] + 3;
      const w = this.colX[hi + 1] - this.colX[lo] - 6;
      const hidden = collapsed ? this.hiddenChanges(g) : 0;
      out.push(
        `<div class="grp${collapsed ? " collapsed" : ""}" style="left:${x}px;width:${w}px"><button data-year="${g.year}" title="${collapsed ? "Expand" : "Collapse"} ${g.year}">${collapsed ? "▸" : "▾"} ${g.year}${hidden ? `<span class="grp-badge">${hidden}</span>` : ""}</button></div>`,
      );
    }
    return out.join("");
  }

  private hiddenChanges(g: YearGroup): number {
    const d = this.data!;
    const cols = new Set(g.quarters);
    return d.changeList.filter((ch) => cols.has(ch.c)).length;
  }

  // ------------------------------------------------------------ selection

  private clampSelection() {
    const maxR = this.viewRows.length - 1;
    const maxC = this.viewCols.length - 1;
    const s = this.sel;
    this.sel = {
      row: Math.min(s.row, maxR),
      col: Math.min(s.col, maxC),
      row2: Math.min(s.row2, maxR),
      col2: Math.min(s.col2, maxC),
    };
  }

  select(row: number, col: number, extend = false) {
    row = Math.max(0, Math.min(this.viewRows.length - 1, row));
    col = Math.max(0, Math.min(this.viewCols.length - 1, col));
    this.sel = extend ? { ...this.sel, row2: row, col2: col } : { row, col, row2: row, col2: col };
    this.ensureVisible(extend ? row : this.sel.row, extend ? col : this.sel.col);
    this.renderSelection();
    this.renderHeaders();
    this.events.select(this.sel);
  }

  inSelection(row: number, col: number) {
    const s = this.sel;
    return row >= Math.min(s.row, s.row2) && row <= Math.max(s.row, s.row2) && col >= Math.min(s.col, s.col2) && col <= Math.max(s.col, s.col2);
  }

  private renderHeaders() {
    for (const name of ["hdrFrozen", "hdrScroll", "rowFrozen", "rowScroll"]) this.regions[name].rendered = null;
    this.schedule();
  }

  private renderSelection() {
    const s = this.sel;
    const r0 = Math.min(s.row, s.row2);
    const r1 = Math.max(s.row, s.row2);
    const c0 = Math.min(s.col, s.col2);
    const c1 = Math.max(s.col, s.col2);
    const rect = (a: number, b: number, c: number, e: number) =>
      `left:${this.colX[c]}px;top:${this.rowY[a]}px;width:${this.colX[e + 1] - this.colX[c]}px;height:${this.rowY[b + 1] - this.rowY[a]}px`;
    const multi = r0 !== r1 || c0 !== c1;
    const html = `${multi ? `<div class="sel-range" style="${rect(r0, r1, c0, c1)}"></div>` : ""}<div class="sel-active" style="${rect(s.row, s.row, s.col, s.col)}"></div>`;
    for (const name of ["corner", "top", "left", "main"]) this.regions[name].overlay.innerHTML = html;
  }

  ensureVisible(row: number, col: number) {
    const v = this.viewport;
    const viewH = v.clientHeight - this.headH - this.frozenH;
    const viewW = v.clientWidth - ROW_HEAD_W - this.frozenW;
    if (row >= this.frozenR) {
      const top = this.rowY[row] - this.frozenH;
      const bottom = this.rowY[row + 1] - this.frozenH;
      if (top < v.scrollTop) v.scrollTop = top;
      else if (bottom > v.scrollTop + viewH) v.scrollTop = bottom - viewH;
    }
    if (col >= this.frozenC) {
      const left = this.colX[col] - this.frozenW;
      const right = this.colX[col + 1] - this.frozenW;
      if (left < v.scrollLeft) v.scrollLeft = left;
      else if (right > v.scrollLeft + viewW) v.scrollLeft = Math.min(left, right - viewW);
    }
  }

  /** Scroll so a cell sits about a third of the way down the view. */
  reveal(row: number, col: number) {
    const v = this.viewport;
    const viewH = v.clientHeight - this.headH - this.frozenH;
    const viewW = v.clientWidth - ROW_HEAD_W - this.frozenW;
    if (row >= this.frozenR) v.scrollTop = Math.max(0, this.rowY[row] - this.frozenH - viewH / 3);
    if (col >= this.frozenC) {
      const left = this.colX[col] - this.frozenW;
      if (left < v.scrollLeft || left + 120 > v.scrollLeft + viewW) v.scrollLeft = Math.max(0, left - viewW / 3);
    }
  }

  get scrollPos() {
    return { top: this.viewport.scrollTop, left: this.viewport.scrollLeft };
  }

  set scrollPos(p: { top: number; left: number }) {
    this.viewport.scrollTop = p.top;
    this.viewport.scrollLeft = p.left;
  }

  /** Screen offset of a view row from the top of the scrolling area, to keep it fixed across reloads. */
  rowScreenOffset(row: number): number {
    return this.rowY[row] - this.frozenH - this.viewport.scrollTop;
  }

  setRowScreenOffset(row: number, offset: number) {
    if (row >= this.frozenR) this.viewport.scrollTop = Math.max(0, this.rowY[row] - this.frozenH - offset);
  }

  // ---------------------------------------------------------------- mouse

  private hit(e: MouseEvent): { row: number; col: number } | null {
    const r = this.viewport.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x >= this.viewport.clientWidth || y >= this.viewport.clientHeight) return null;
    let col = -1;
    let row = -1;
    if (x >= ROW_HEAD_W) {
      const cx = x - ROW_HEAD_W < this.frozenW ? x - ROW_HEAD_W : x - ROW_HEAD_W + this.viewport.scrollLeft;
      col = Math.min(this.viewCols.length - 1, lowerBound(this.colX, cx));
    }
    if (y >= this.headH) {
      const cy = y - this.headH < this.frozenH ? y - this.headH : y - this.headH + this.viewport.scrollTop;
      row = Math.min(this.viewRows.length - 1, lowerBound(this.rowY, cy));
    }
    return { row, col };
  }

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const hit = this.hit(e);
    if (!hit) return;
    this.focus();
    if (hit.row < 0 && hit.col < 0) return;
    if (hit.row < 0) {
      // Column header: select the column.
      this.sel = { row: 0, col: hit.col, row2: this.viewRows.length - 1, col2: hit.col };
      this.renderSelection();
      this.renderHeaders();
      this.events.select(this.sel);
      return;
    }
    if (hit.col < 0) {
      this.sel = { row: hit.row, col: 0, row2: hit.row, col2: this.viewCols.length - 1 };
      this.renderSelection();
      this.renderHeaders();
      this.events.select(this.sel);
      return;
    }
    e.preventDefault();
    this.select(hit.row, hit.col, e.shiftKey);
    this.dragging = true;
  }

  private onMouseMove(e: MouseEvent) {
    if (this.dragging) {
      const hit = this.hit(e);
      const r = this.viewport.getBoundingClientRect();
      // Auto-scroll while dragging past the edge.
      if (e.clientY > r.bottom - 12) this.viewport.scrollTop += 24;
      if (e.clientX > r.right - 12) this.viewport.scrollLeft += 40;
      if (hit && hit.row >= 0 && hit.col >= 0 && (hit.row !== this.sel.row2 || hit.col !== this.sel.col2)) this.select(hit.row, hit.col, true);
      return;
    }
    if (e.target instanceof Node && this.viewport.contains(e.target)) {
      const hit = this.hit(e);
      this.events.hoverCell(hit && hit.row >= 0 ? hit.row : null, hit && hit.col >= 0 ? hit.col : null, e.clientX, e.clientY);
    }
  }

  // ---------------------------------------------------------------- wake

  /** Ripple across the given cells in reading order: the wake. */
  wake(cells: { r: number; c: number }[], reducedMotion: boolean) {
    this.pulses.clear();
    const sorted = [...cells].sort((a, b) => a.r - b.r || a.c - b.c);
    const span = reducedMotion ? 0 : 600;
    const step = sorted.length > 1 ? Math.min(30, span / sorted.length) : 0;
    sorted.forEach((cell, i) => this.pulses.set(cell.r * 20000 + cell.c, Math.round(i * step)));
    this.pulseUntil = performance.now() + Math.min(span, sorted.length * step) + 900;
    this.schedule(true);
    setTimeout(() => this.schedule(true), this.pulseUntil - performance.now() + 50);
  }

  // ---------------------------------------------------------- tick marks

  private renderTicks() {
    const d = this.data;
    if (!d) return;
    const totalH = this.rowY[this.rowY.length - 1] || 1;
    const totalW = this.colX[this.colX.length - 1] || 1;
    const rows = new Map<number, ChangeKind>();
    const cols = new Map<number, ChangeKind>();
    const rank = (k: ChangeKind) => (k === "result" ? 0 : 1);
    for (const ch of d.changeList) {
      const ri = this.rowIndex.get(ch.r);
      const ci = this.colIndex.get(ch.c);
      if (ri !== undefined && (!rows.has(ri) || rank(ch.kind) > rank(rows.get(ri)!))) rows.set(ri, ch.kind);
      if (ci !== undefined && (!cols.has(ci) || rank(ch.kind) > rank(cols.get(ci)!))) cols.set(ci, ch.kind);
    }
    this.ticksY.innerHTML = [...rows]
      .map(([ri, k]) => `<i class="t-${k}" style="top:${((this.rowY[ri] / totalH) * 100).toFixed(3)}%"></i>`)
      .join("");
    this.ticksX.innerHTML = [...cols]
      .map(([ci, k]) => `<i class="t-${k}" style="left:${((this.colX[ci] / totalW) * 100).toFixed(3)}%"></i>`)
      .join("");
    this.ticksY.style.top = `${this.headH}px`;
    this.ticksX.style.left = `${ROW_HEAD_W}px`;
  }
}
