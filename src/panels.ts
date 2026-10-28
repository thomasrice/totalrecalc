// The side panel's two tabs (Changes, Cell details) and the change report.

import type { App } from "./main";
import type { CellChange, Inspection } from "./types";
import { SheetData, address, colLetters, colNumber } from "./sheet";
import { clock, delta, esc, shortValue, signedPercent } from "./format";
import { icon } from "./icons";

interface ChangeRow {
  r: number;
  label: string;
  cells: CellChange[];
  edited: boolean;
  span: string;
  range: string;
  spark: string;
}

export function changesHtml(app: App): string {
  const i = app.info!;
  const d = app.data!;
  const versions = i.versions;
  const timeline = versions
    .map((v) => {
      const cls = [v.id === app.displayed ? "shown" : "", v.id === app.baseline ? "base" : ""].join(" ");
      return `<button class="ver ${cls}" data-ver="${v.id}" title="${v.id === app.baseline ? "The baseline" : "Make this version the baseline"}"><b>v${versions.indexOf(v) + 1}</b> ${clock(v.at)}${v.id === app.baseline ? " · base" : ""}</button>`;
    })
    .join("");
  const groups = changeRows(d, (st) => !!app.info?.styles[st]?.percent);
  const edited = groups.filter((g) => g.edited);
  const results = groups.filter((g) => !g.edited);
  const rowHtml = (g: ChangeRow) => `
    <button class="chrow ${g.edited ? "edited" : "result"}" data-r="${g.r}" data-c="${g.cells[0].c}">
      <span class="bar"></span>
      <span class="lbl" title="${esc(g.label || `Row ${g.r}`)}">${esc(g.label || `Row ${g.r}`)}</span>
      <span class="meta">${g.cells.length} cell${g.cells.length === 1 ? "" : "s"}${g.span ? ` · ${esc(g.span)}` : ""}</span>
      ${g.range ? `<span class="rng">${esc(g.range)}</span>` : ""}
      ${g.spark ? `<span class="spark">${g.spark}</span>` : ""}
    </button>`;
  const other = i.sheets
    .map((s, idx) => ({ s, idx }))
    .filter(({ s, idx }) => idx !== app.sheetIndex && s.edits + s.results + s.structure > 0);
  const removed = d.diff.removedRows;
  const empty = !groups.length && !removed.length && !d.diff.addedRows.length;
  return `
    <div class="seg">
      <button class="${app.compareMode === "baseline" ? "on" : ""}" data-mode="baseline">Since baseline</button>
      <button class="${app.compareMode === "latest" ? "on" : ""}" data-mode="latest">Latest update</button>
    </div>
    <div class="timeline">${timeline}</div>
    <div class="sheet-head"><b>${esc(d.meta.name)}</b><span class="muted">${d.diff.edits} edits · ${d.diff.results} results</span><button class="icon" data-act="report" title="Copy the change list as Markdown">${icon("copy")}</button></div>
    ${empty ? `<div class="empty-note">${icon("check")} Nothing changed on this sheet${app.compareMode === "baseline" ? " since the baseline" : " in the latest update"}.</div>` : ""}
    ${edited.length ? `<div class="sec">Edited</div>${edited.map(rowHtml).join("")}` : ""}
    ${d.diff.addedRows.length ? `<div class="sec">Rows added</div>${d.diff.addedRows.map((r) => `<button class="chrow added" data-r="${r}" data-c="1"><span class="bar"></span><span class="lbl">${esc(d.rowLabel(r) || `Row ${r}`)}</span><span class="meta">new row</span></button>`).join("")}` : ""}
    ${removed.length ? `<div class="sec">Rows removed</div>${removed.map((rr) => `<div class="chrow removed"><span class="bar"></span><span class="lbl">${esc(rr.label || rr.cells.map((c) => c[1]).slice(0, 2).join(" · ") || "Unlabelled row")}</span><span class="meta">${rr.after ? `was below row ${rr.after}` : "was at the top"}</span><span class="rng">${esc(rr.cells.slice(1, 5).map((c) => c[1]).join("  "))}</span></div>`).join("")}` : ""}
    ${results.length ? `<div class="sec">Recalculated</div>${results.map(rowHtml).join("")}` : ""}
    ${other.length ? `<div class="sec">Other sheets</div>${other.map(({ s, idx }) => `<button class="chrow sheetrow" data-sheet="${idx}"><span class="lbl">${esc(s.name)}</span><span class="meta">${s.edits} edits · ${s.results} results${s.structure ? ` · ${s.structure} rows` : ""}</span>${icon("chevron")}</button>`).join("")}` : ""}`;
}

export function inspectorHtml(app: App): string {
  const d = app.data!;
  const row = app.grid.rowOf(app.grid.sel.row);
  const vc = app.grid.colOf(app.grid.sel.col);
  if (!vc) return "";
  const cell = d.cell(row, vc.col);
  const ch = d.change(row, vc.col);
  const label = d.rowLabel(row);
  const header = d.colHeader(vc.col);
  const percent = !!app.info!.styles[cell?.style ?? 0]?.percent;
  const ins = app.inspection;
  const refList = (list: Inspection["inputs"]) =>
    list.length
      ? list
          .map(
            (x) =>
              `<button class="ref" data-sheet="${x.sheetIndex}" data-r="${x.r}" data-c="${x.c}"><span class="lbl">${esc(x.label || x.address)}${x.header ? ` <span class="muted">· ${esc(x.header)}</span>` : ""}</span><span class="val">${esc(x.text)}</span>${x.sheetIndex !== app.sheetIndex ? `<span class="sheetname">${esc(x.sheet)}</span>` : ""}${x.more ? `<span class="more">+${x.more} more</span>` : ""}</button>`,
          )
          .join("")
      : `<div class="muted small">None</div>`;
  const calcNote = cell?.calc === 1 ? "From the file's cache: Total Recalc's engine cannot evaluate this formula faithfully (or it depends on one that it cannot), so the value Excel saved is shown." : cell?.calc === 2 ? "Unavailable: the engine could not calculate this and the file holds no saved value." : cell?.formula ? "Calculated by Total Recalc." : cell ? "A constant typed into the workbook." : "Blank cell.";
  return `
    <div class="insp-title" title="${esc([label, header].filter(Boolean).join(" · "))}">${esc(label || "—")}${header ? ` <span class="muted">·</span> ${esc(header)}` : ""}</div>
    <div class="insp-sub">${esc(d.meta.name)}!${address(row, vc.col)}</div>
    <div class="insp-value ${cell?.error ? "err" : ""}">${esc(cell?.text || "blank")}</div>
    ${cell && typeof cell.value === "number" && cell.text !== String(cell.value) ? `<div class="insp-raw">${Number(cell.value.toPrecision(12))}</div>` : ""}
    ${ch ? `<div class="insp-was"><span class="kind k-${ch.kind}">${kindLabel(ch.kind)}</span> was <b>${esc(shortValue(ch.beforeValue, ch.beforeText))}</b> <span class="delta">${esc(delta(ch.beforeValue, cell?.value ?? null, cell?.text ?? "", percent))}</span></div>` : ""}
    ${cell?.formula ? `<div class="insp-sec">Formula</div><div class="insp-formula">${formulaHtml(cell.formula, { names: app.info!.sheets.map((x) => x.name), current: app.sheetIndex })}</div>` : ""}
    ${ch?.beforeFormula && ch.beforeFormula !== cell?.formula ? `<div class="insp-formula before">${esc(ch.beforeFormula)}</div>` : ""}
    ${cell?.comment ? `<div class="insp-sec">Note</div><div class="insp-note">${esc(cell.comment)}</div>` : ""}
    ${
      ins?.unavailable
        ? `<div class="insp-sec">Inputs and used by</div><div class="muted small">Not in this sample: the desktop app works these out.</div>`
        : `<div class="insp-sec">Inputs</div>
    ${ins ? refList(ins.inputs) : `<div class="muted small">…</div>`}
    <div class="insp-sec">Used by</div>
    ${ins ? refList(ins.usedBy) : `<div class="muted small">…</div>`}`
    }
    <div class="insp-calc">${calcNote}</div>
    ${app.history.length ? `<button class="link back" data-act="back">${icon("back")} Back (Backspace)</button>` : ""}`;
}

export function changeReport(app: App): string {
  const d = app.data;
  if (!d || !app.info) return "";
  const i = app.info;
  const lines = [
    `**${i.fileName}** · ${app.versionName(app.displayed)} compared with ${app.compareMode === "baseline" ? `the baseline, ${app.versionName(app.baseline)}` : "the previous version"}: ${i.edits} edits, ${i.results} recalculated, ${i.rowsAdded} rows added, ${i.rowsRemoved} removed.`,
    "",
    `**${d.meta.name}**`,
  ];
  const rows = changeRows(d, (st) => !!app.info?.styles[st]?.percent);
  for (const g of rows.filter((g) => g.edited)) lines.push(`- ${g.label || `Row ${g.r}`}: edited, ${g.cells.length} cell${g.cells.length === 1 ? "" : "s"}${g.span ? `, ${g.span}` : ""}${g.range ? `, ${g.range}` : ""}`);
  for (const r of d.diff.addedRows) lines.push(`- ${d.rowLabel(r) || `Row ${r}`}: new row`);
  for (const rr of d.diff.removedRows) lines.push(`- ${rr.label || rr.cells.map((c) => c[1]).slice(0, 3).join(" | ")}: removed`);
  for (const g of rows.filter((g) => !g.edited)) lines.push(`- ${g.label || `Row ${g.r}`}: recalculated, ${g.cells.length} cell${g.cells.length === 1 ? "" : "s"}${g.range ? `, ${g.range}` : ""}`);
  const others = i.sheets.filter((s, idx) => idx !== app.sheetIndex && s.edits + s.results + s.structure > 0);
  if (others.length) {
    lines.push("", "Other sheets:");
    for (const s of others) lines.push(`- ${s.name}: ${s.edits} edits, ${s.results} recalculated${s.structure ? `, ${s.structure} rows added or removed` : ""}`);
  }
  if (i.removedSheets.length) lines.push("", `Sheets removed: ${i.removedSheets.join(", ")}`);
  return lines.join("\n");
}

export function kindLabel(k: CellChange["kind"]): string {
  return { edit: "Edited", formula: "Formula edited", result: "Recalculated", added: "Added", cleared: "Cleared" }[k];
}

export function changeRows(d: SheetData, percent: (style: number) => boolean): ChangeRow[] {
  const byRow = new Map<number, CellChange[]>();
  for (const ch of d.changeList) {
    const list = byRow.get(ch.r) ?? [];
    list.push(ch);
    byRow.set(ch.r, list);
  }
  return [...byRow].map(([r, cells]) => {
    const first = d.colHeader(cells[0].c) || colLetters(cells[0].c);
    const last = d.colHeader(cells[cells.length - 1].c) || colLetters(cells[cells.length - 1].c);
    // Percentage rows move in percentage points; everything else relatively.
    const points = cells.some((ch) => percent(d.cell(ch.r, ch.c)?.style ?? 0));
    const unit = points ? "pp" : "%";
    const pcts: number[] = [];
    for (const ch of cells) {
      const after = d.cell(ch.r, ch.c)?.value;
      if (typeof ch.beforeValue !== "number" || typeof after !== "number") continue;
      if (points) pcts.push((after - ch.beforeValue) * 100);
      else if (ch.beforeValue !== 0) pcts.push(((after - ch.beforeValue) / Math.abs(ch.beforeValue)) * 100);
    }
    const lo = Math.min(...pcts);
    const hi = Math.max(...pcts);
    const f = (p: number) => signedPercent(p, unit);
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

export function sparkline(d: SheetData, r: number, cells: CellChange[]): string {
  // One frequency only: quarters if the sheet has them, otherwise years.
  const periods = d.meta.periods.map((p, i) => ({ p, c: i + 1 })).filter((x) => x.p !== null);
  const quarters = periods.filter((x) => x.p!.quarter > 0);
  const cols = (quarters.length >= 4 ? quarters : periods.filter((x) => x.p!.quarter === 0)).map((x) => x.c);
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

export function formulaHtml(f: string, sheets?: { names: string[]; current: number }): string {
  // Sheet-qualified or not; a cell, a range, a whole-column (A:C) or whole-row (3:5) range.
  const re = /((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)/g;
  // String literals are left alone: split on quotes and only scan the code between them.
  return f
    .split('"')
    .map((part, i) => {
      if (i % 2 === 1) return esc(part);
      let out = "";
      let last = 0;
      for (const m of part.matchAll(re)) {
        const at = m.index ?? 0;
        const before = part[at - 1] ?? "";
        const after = part[at + m[0].length] ?? "";
        if (/[A-Za-z0-9_.$]/.test(before) || /[A-Za-z0-9_(]/.test(after)) continue;
        out += esc(part.slice(last, at));
        const sheet = m[1] ? m[1].slice(0, -1).replace(/^'|'$/g, "").replace(/''/g, "'") : "";
        const idx = sheets ? (sheet ? sheets.names.indexOf(sheet) : sheets.current) : -1;
        const cls = sheet && idx !== sheets?.current ? "fref other" : "fref";
        const cellRef = /^\$?([A-Z]{1,3})\$?(\d+)/.exec(m[2]);
        out +=
          idx >= 0 && cellRef
            ? `<button type="button" class="${cls}" data-sheet="${idx}" data-r="${cellRef[2]}" data-c="${colNumber(cellRef[1])}" title="Go to ${esc(m[0])}">${esc(m[0])}</button>`
            : `<span class="${cls}">${esc(m[0])}</span>`;
        last = at + m[0].length;
      }
      return out + esc(part.slice(last));
    })
    .join('"');
}

