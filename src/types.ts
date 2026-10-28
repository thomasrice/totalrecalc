// Shapes sent by the Rust side (see src-tauri/src/session.rs).

export type Value = number | string | boolean | null;

export interface Edge {
  style: string;
  color: string;
}

export interface CellStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  size: number;
  color?: string;
  fill?: string;
  align: "left" | "center" | "right" | "general";
  valign: "top" | "center" | "bottom";
  indent: number;
  wrap: boolean;
  top?: Edge;
  right?: Edge;
  bottom?: Edge;
  left?: Edge;
  percent: boolean;
}

export interface Period {
  year: number;
  quarter: number;
  kind?: string;
}

export interface SheetMeta {
  name: string;
  hidden: boolean;
  maxRow: number;
  maxCol: number;
  frozenRows: number;
  frozenCols: number;
  frozenInferred: boolean;
  showGrid: boolean;
  colWidths: number[];
  hiddenCols: number[];
  rowHeights: Record<string, number>;
  hiddenRows: number[];
  merges: [number, number, number, number][];
  colOutline: Record<string, number>;
  rowOutline: Record<string, number>;
  headerRow?: number;
  periods: (Period | null)[];
  labelCols: number;
}

/** `[row, col, text, value, style, flags, formula, formatColor, comment]` */
export type WireCell = [number, number, string, Value, number, number, string | null, string | null, string | null];

export type ChangeKind = "edit" | "formula" | "result" | "added" | "cleared";

export interface CellChange {
  r: number;
  c: number;
  kind: ChangeKind;
  beforeText: string;
  beforeValue: Value;
  beforeFormula?: string;
}

export interface RemovedRow {
  after: number;
  label: string;
  cells: [number, string][];
}

export interface SheetDiff {
  changes: CellChange[];
  addedRows: number[];
  removedRows: RemovedRow[];
  addedCols: number[];
  removedCols: string[];
  newSheet: boolean;
  edits: number;
  results: number;
}

export interface SheetPayload {
  meta: SheetMeta;
  cells: WireCell[];
  diff: SheetDiff;
}

export interface VersionInfo {
  id: number;
  at: number;
  calculated: boolean;
}

export interface SheetSummary {
  name: string;
  hidden: boolean;
  edits: number;
  results: number;
  structure: number;
  newSheet: boolean;
}

export interface WatchState {
  state: "loading" | "watching" | "writing" | "error" | "calculating";
  message?: string;
  since?: number;
}

export interface CalcSummary {
  calculated: boolean;
  cached: number;
  unavailable: number;
  errors: number;
}

export interface BookInfo {
  path: string;
  fileName: string;
  folder: string;
  version: number;
  versions: VersionInfo[];
  sheets: SheetSummary[];
  styles: CellStyle[];
  calc: CalcSummary;
  watch: WatchState;
  compare?: number;
  /** The requested comparison version is no longer held. */
  compareMissing: boolean;
  edits: number;
  results: number;
  rowsAdded: number;
  rowsRemoved: number;
  removedSheets: string[];
}

export interface RefInfo {
  sheet: string;
  sheetIndex: number;
  r: number;
  c: number;
  address: string;
  label: string;
  header: string;
  text: string;
  /** Number of further cells in a range that were not listed. */
  more?: number;
}

export interface Inspection {
  inputs: RefInfo[];
  usedBy: RefInfo[];
}
