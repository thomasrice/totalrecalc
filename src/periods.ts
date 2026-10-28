// Period groups: quarters gathered under their year, collapsible, with a
// derived annual column when a collapsed year has none of its own.

import type { CellStyle, SheetMeta } from "./types";
import type { SheetData } from "./sheet";

export interface YearGroup {
  year: number;
  /** Sheet columns holding the year's quarters, in order. */
  quarters: number[];
  /** The year's own annual column, if the sheet has one next to its quarters. */
  annual: number | null;
}

export type ViewCol =
  | { kind: "sheet"; col: number; width: number }
  | { kind: "derived"; group: YearGroup; width: number };

/**
 * Years that can fold: those whose quarters are visible and either complete
 * (four of them) or summarised by the year's own annual column beside them.
 * Anything else stays as it is, rather than collapsing to nothing.
 */
export function yearGroups(meta: SheetMeta): YearGroup[] {
  const byYear = new Map<number, YearGroup>();
  const order: number[] = [];
  const hidden = new Set(meta.hiddenCols);
  meta.periods.forEach((p, i) => {
    if (!p) return;
    const col = i + 1;
    if (hidden.has(col)) return;
    let g = byYear.get(p.year);
    if (!g) {
      g = { year: p.year, quarters: [], annual: null };
      byYear.set(p.year, g);
      order.push(p.year);
    }
    if (p.quarter > 0) g.quarters.push(col);
    else if (g.annual === null) g.annual = col;
  });
  return order
    .map((y) => byYear.get(y)!)
    .filter((g) => g.quarters.length >= 2)
    .map((g) => {
      // An annual column only counts as the group's own if it sits next to the quarters.
      const lo = Math.min(...g.quarters);
      const hi = Math.max(...g.quarters);
      const adjacent = g.annual !== null && (g.annual === hi + 1 || g.annual === lo - 1);
      return { ...g, annual: adjacent ? g.annual : null };
    })
    .filter((g) => g.annual !== null || new Set(g.quarters.map((c) => meta.periods[c - 1]?.quarter)).size === 4);
}

export function buildViewCols(meta: SheetMeta, groups: YearGroup[], collapsed: Set<number>): ViewCol[] {
  const hidden = new Set(meta.hiddenCols);
  const hiddenByGroup = new Set<number>();
  const derivedAfter = new Map<number, YearGroup>();
  for (const g of groups) {
    if (!collapsed.has(g.year)) continue;
    g.quarters.forEach((c) => hiddenByGroup.add(c));
    if (g.annual === null && g.quarters.length === 4) derivedAfter.set(Math.max(...g.quarters), g);
  }
  const out: ViewCol[] = [];
  for (let c = 1; c <= meta.maxCol; c++) {
    const width = meta.colWidths[c - 1] ?? 64;
    if (!hidden.has(c) && !hiddenByGroup.has(c)) out.push({ kind: "sheet", col: c, width });
    const g = derivedAfter.get(c);
    if (g) out.push({ kind: "derived", group: g, width });
  }
  return out;
}

// ------------------------------------------------------------ derived values

type RowRule = "sum" | "last" | "blank";

// Conservative on purpose: a derived figure is shown only when the row is
// plainly a flow (summed) or plainly a balance on a balance sheet (year end).
// Anything else is left blank rather than guessed.
const RATIO = /(margin|growth|per share|\/ ?sh|ratio|\brate\b|yield|days|multiple|%|\bx\b|average|\bavg\b|price|cover|return on|\broe\b|\broic\b|\beps\b|mix|share of|index|count|headcount|employees|outstanding)/i;
const FLOW = /(revenue|sales|income|profit|loss|ebit|ebitda|cost|expense|opex|capex|capital expenditure|cash flow|free cash|dividend|interest|tax|depreciation|amortisation|amortization|r&d|research|marketing|administrative|g&a|s&m|cogs|gross|operating|bookings|shipments|units|volume|purchases|repayment|issuance|proceeds|payments)/i;

/** How a row should roll up from quarters to a year. */
export function rowRule(sheetName: string, label: string, sampleStyle: CellStyle | undefined): RowRule {
  if (!label || sampleStyle?.percent || RATIO.test(label)) return "blank";
  if (/balance/i.test(sheetName)) return "last";
  if (FLOW.test(label)) return "sum";
  return "blank";
}

export function derivedValue(data: SheetData, row: number, g: YearGroup, styles: CellStyle[]): { text: string; rule: RowRule } | null {
  const cells = g.quarters.map((c) => data.cell(row, c));
  const values = cells.map((c) => (c && typeof c.value === "number" ? c.value : null));
  if (values.every((v) => v === null)) return null;
  const sample = cells[cells.length - 1] ?? cells.find(Boolean);
  const rule = rowRule(data.meta.name, data.rowLabel(row), sample ? styles[sample.style] : undefined);
  if (rule === "blank" || values.some((v) => v === null)) return { text: "", rule: "blank" };
  const v = rule === "sum" ? values.reduce<number>((a, b) => a + (b ?? 0), 0) : values[values.length - 1]!;
  return { text: formatLike(v, cells.map((c) => c?.text ?? "")), rule };
}

/** Format a number the way its neighbours are formatted. */
export function formatLike(v: number, samples: string[]): string {
  const sample = samples.find((s) => /\d/.test(s)) ?? "";
  const decimals = (sample.replace(/[()\-%]/g, "").split(".")[1] ?? "").replace(/\D/g, "").length;
  const grouping = sample.includes(",");
  const parens = samples.some((s) => /^\(.*\)$/.test(s.trim()));
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  });
  if (v < 0) return parens ? `(${abs})` : `-${abs}`;
  return abs;
}

export function periodLabel(g: YearGroup): string {
  return `FY${String(g.year).slice(-2)}`;
}
