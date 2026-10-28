// A loaded sheet with fast cell lookup and its changes.

import type { CellChange, SheetDiff, SheetMeta, SheetPayload, Value } from "./types";

export interface Cell {
  r: number;
  c: number;
  text: string;
  value: Value;
  style: number;
  error: boolean;
  /** 0 calculated, 1 from the file's cache, 2 unavailable */
  calc: number;
  formula: string | null;
  formatColor: string | null;
  comment: string | null;
}

/** One number per cell, for maps and sets (columns never exceed 16,384). */
export const cellKey = (r: number, c: number) => r * 20000 + c;

export class SheetData {
  readonly meta: SheetMeta;
  readonly diff: SheetDiff;
  private cells = new Map<number, Cell>();
  private changes = new Map<number, CellChange>();
  private labels = new Map<number, string>();
  /** Rows (in reading order) that contain changes. */
  readonly changedRows: number[];

  constructor(p: SheetPayload) {
    this.meta = p.meta;
    this.diff = p.diff;
    for (const [r, c, text, value, style, flags, formula, formatColor, comment] of p.cells) {
      this.cells.set(cellKey(r, c), { r, c, text, value, style, error: (flags & 1) === 1, calc: flags >> 1, formula, formatColor, comment });
    }
    for (const ch of p.diff.changes) this.changes.set(cellKey(ch.r, ch.c), ch);
    this.changedRows = [...new Set(p.diff.changes.map((c) => c.r))].sort((a, b) => a - b);
  }

  cell(r: number, c: number): Cell | undefined {
    return this.cells.get(cellKey(r, c));
  }

  change(r: number, c: number): CellChange | undefined {
    return this.changes.get(cellKey(r, c));
  }

  get changeList(): CellChange[] {
    return this.diff.changes;
  }

  /** The row's label: first non-numeric text in the label columns. */
  rowLabel(r: number): string {
    const hit = this.labels.get(r);
    if (hit !== undefined) return hit;
    let label = "";
    for (let c = 1; c <= Math.max(1, this.meta.labelCols); c++) {
      const cell = this.cell(r, c);
      if (cell && cell.text.trim() && typeof cell.value !== "number") {
        label = cell.text.trim();
        break;
      }
    }
    this.labels.set(r, label);
    return label;
  }

  colHeader(c: number): string {
    const h = this.meta.headerRow;
    return h ? (this.cell(h, c)?.text.trim() ?? "") : "";
  }

  *allCells(): IterableIterator<Cell> {
    yield* this.cells.values();
  }
}

export function colLetters(col: number): string {
  let s = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

/** "AB" → 28 */
export function colNumber(letters: string): number {
  return letters.toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

export function address(r: number, c: number): string {
  return `${colLetters(c)}${r}`;
}
