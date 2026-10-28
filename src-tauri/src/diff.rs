//! What changed between two versions of a workbook.
//!
//! Rows are matched by meaning (section, label, occurrence) and aligned as a
//! sequence, the way a text diff aligns lines, so an inserted row is seen as
//! one new row rather than a shift of everything below it. Columns are
//! matched by their header. A cell is then an *edit* (its constant or formula
//! changed), a *result* (same formula, new value), or *added*.

use crate::book::{Book, Cell, Sheet, Value};
use regex::Regex;
use serde::Serialize;
use similar::{Algorithm, DiffOp, capture_diff_slices};
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A constant was changed, or a formula now gives a different value because its text changed.
    Edit,
    /// Formula text changed but the value did not.
    Formula,
    /// Same formula, different value: a consequence of edits elsewhere.
    Result,
    /// Content where there was none.
    Added,
    /// Content removed from a cell that still exists.
    Cleared,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellChange {
    pub r: i32,
    pub c: i32,
    pub kind: Kind,
    pub before_text: String,
    pub before_value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_formula: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedRow {
    /// The row in the new version below which the removed row used to sit (0 = top).
    pub after: i32,
    pub label: String,
    /// `(column in the old version, display text)` for non-empty cells.
    pub cells: Vec<(i32, String)>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SheetDiff {
    pub changes: Vec<CellChange>,
    pub added_rows: Vec<i32>,
    pub removed_rows: Vec<RemovedRow>,
    pub added_cols: Vec<i32>,
    pub removed_cols: Vec<String>,
    pub new_sheet: bool,
    pub edits: usize,
    pub results: usize,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// Keyed by sheet name in the new version.
    pub sheets: HashMap<String, SheetDiff>,
    pub removed_sheets: Vec<String>,
    pub edits: usize,
    pub results: usize,
    pub rows_added: usize,
    pub rows_removed: usize,
}

/// Mapping of row and column numbers from the old version to the new.
struct Alignment {
    rows: HashMap<i32, i32>,
    cols: HashMap<i32, i32>,
    added_rows: Vec<i32>,
    removed_rows: Vec<(i32, i32)>, // (old row, new row it sits after)
    added_cols: Vec<i32>,
    removed_cols: Vec<i32>,
}

pub fn diff(old: &Book, new: &Book) -> Diff {
    let alignments: HashMap<&str, Alignment> = new
        .sheets
        .iter()
        .filter_map(|ns| old.sheet(&ns.meta.name).map(|os| (ns.meta.name.as_str(), align(os, ns, old, new))))
        .collect();

    let mut out = Diff {
        removed_sheets: old
            .sheets
            .iter()
            .filter(|s| new.sheet(&s.meta.name).is_none())
            .map(|s| s.meta.name.clone())
            .collect(),
        ..Default::default()
    };

    for ns in &new.sheets {
        let name = ns.meta.name.as_str();
        let mut sd = SheetDiff::default();
        let (Some(os), Some(al)) = (old.sheet(name), alignments.get(name)) else {
            sd.new_sheet = true;
            out.sheets.insert(name.to_string(), sd);
            continue;
        };
        let inverse_rows: HashMap<i32, i32> = al.rows.iter().map(|(o, n)| (*n, *o)).collect();
        let inverse_cols: HashMap<i32, i32> = al.cols.iter().map(|(o, n)| (*n, *o)).collect();

        for (&(r, c), cell) in &ns.cells {
            let (Some(&orow), Some(&ocol)) = (inverse_rows.get(&r), inverse_cols.get(&c)) else { continue };
            let before = os.cells.get(&(orow, ocol));
            if let Some(kind) = classify(before, cell, name, &alignments) {
                sd.changes.push(change(r, c, kind, before));
            }
        }
        // Cells that had content and are now gone, in rows and columns that still exist.
        for (&(orow, ocol), before) in &os.cells {
            let (Some(&r), Some(&c)) = (al.rows.get(&orow), al.cols.get(&ocol)) else { continue };
            if !ns.cells.contains_key(&(r, c)) && has_content(before) {
                sd.changes.push(change(r, c, Kind::Cleared, Some(before)));
            }
        }
        sd.changes.sort_by_key(|ch| (ch.r, ch.c));
        sd.edits = sd.changes.iter().filter(|c| c.kind != Kind::Result).count();
        sd.results = sd.changes.len() - sd.edits;
        sd.added_rows = al.added_rows.clone();
        sd.added_cols = al.added_cols.clone();
        sd.removed_cols = al.removed_cols.iter().map(|c| column_key(os, *c)).collect();
        sd.removed_rows = al
            .removed_rows
            .iter()
            .map(|(orow, after)| RemovedRow {
                after: *after,
                label: os.row_label(*orow),
                cells: os
                    .cells
                    .range((*orow, 0)..(*orow + 1, 0))
                    .filter(|(_, cell)| !cell.text.is_empty())
                    .map(|((_, c), cell)| (*c, cell.text.clone()))
                    .collect(),
            })
            .collect();
        out.edits += sd.edits;
        out.results += sd.results;
        out.rows_added += sd.added_rows.len();
        out.rows_removed += sd.removed_rows.len();
        out.sheets.insert(name.to_string(), sd);
    }
    out
}

fn change(r: i32, c: i32, kind: Kind, before: Option<&Cell>) -> CellChange {
    CellChange {
        r,
        c,
        kind,
        before_text: before.map(|b| b.text.clone()).unwrap_or_default(),
        before_value: before.map(|b| b.value.clone()).unwrap_or(Value::Empty),
        before_formula: before.and_then(|b| b.formula.clone()),
    }
}

fn has_content(cell: &Cell) -> bool {
    cell.formula.is_some() || cell.value != Value::Empty
}

fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0),
        _ => a == b,
    }
}

fn classify(before: Option<&Cell>, after: &Cell, sheet: &str, alignments: &HashMap<&str, Alignment>) -> Option<Kind> {
    let Some(before) = before.filter(|b| has_content(b)) else {
        return has_content(after).then_some(Kind::Added);
    };
    if !has_content(after) {
        return Some(Kind::Cleared);
    }
    let value_changed = !same_value(&before.value, &after.value) || before.error != after.error;
    let formula_changed = match (&before.formula, &after.formula) {
        (None, None) => false,
        (Some(f_old), Some(f_new)) => remap_formula(f_old, sheet, alignments) != *f_new,
        _ => true,
    };
    match (formula_changed, value_changed) {
        (false, false) => None,
        (true, false) => Some(if after.formula.is_some() && before.formula.is_some() { Kind::Formula } else { Kind::Edit }),
        (true, true) => Some(Kind::Edit),
        (false, true) => Some(if after.formula.is_some() { Kind::Result } else { Kind::Edit }),
    }
}

// ----------------------------------------------------------------- alignment

fn column_key(sheet: &Sheet, col: i32) -> String {
    let h = sheet.col_header(col);
    if h.is_empty() { format!("#{col}") } else { h }
}

fn row_keys(sheet: &Sheet, book: &Book) -> Vec<(i32, String)> {
    let mut keys = Vec::new();
    let mut section = String::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for r in 1..=sheet.meta.max_row {
        let label = sheet.row_label(r);
        let row_cells: Vec<&Cell> = sheet.cells.range((r, 0)..(r + 1, 0)).map(|(_, c)| c).collect();
        // Numbers beyond the label columns: a section heading has none.
        let has_numbers = sheet
            .cells
            .range((r, sheet.meta.label_cols + 1)..(r + 1, 0))
            .any(|(_, c)| matches!(c.value, Value::Number(_)));
        let base = if label.is_empty() {
            if row_cells.iter().all(|c| !has_content(c)) {
                "∅".to_string()
            } else {
                // An unlabelled row: identify it by its first few texts and formulas.
                let sig: Vec<String> = row_cells
                    .iter()
                    .take(4)
                    .map(|c| c.formula.clone().unwrap_or_else(|| c.text.clone()))
                    .collect();
                format!("~{}", sig.join("|"))
            }
        } else {
            let bold = row_cells.first().map(|c| book.styles.get(c.style as usize).is_some_and(|s| s.bold)).unwrap_or(false);
            if bold && !has_numbers {
                section = label.clone();
            }
            format!("{section}›{label}")
        };
        let n = seen.entry(base.clone()).or_default();
        *n += 1;
        keys.push((r, format!("{base}#{n}")));
    }
    keys
}

fn align(old: &Sheet, new: &Sheet, old_book: &Book, new_book: &Book) -> Alignment {
    let ok = row_keys(old, old_book);
    let nk = row_keys(new, new_book);
    let (rows, added_rows, removed_rows) = align_seq(&ok, &nk);
    let oc: Vec<(i32, String)> = (1..=old.meta.max_col).map(|c| (c, column_key(old, c))).collect();
    let nc: Vec<(i32, String)> = (1..=new.meta.max_col).map(|c| (c, column_key(new, c))).collect();
    let (cols, added_cols, removed) = align_seq(&oc, &nc);
    Alignment {
        rows,
        cols,
        added_rows: added_rows.into_iter().filter(|r| new.cells.range((*r, 0)..(*r + 1, 0)).next().is_some()).collect(),
        removed_rows: removed_rows
            .into_iter()
            .filter(|(r, _)| old.cells.range((*r, 0)..(*r + 1, 0)).any(|(_, c)| has_content(c)))
            .collect(),
        added_cols,
        removed_cols: removed.into_iter().map(|(c, _)| c).collect(),
    }
}

/// Align two keyed sequences. Returns old→new index map, added new indices,
/// and removed old indices paired with the new index they sit after.
#[allow(clippy::type_complexity)]
fn align_seq(old: &[(i32, String)], new: &[(i32, String)]) -> (HashMap<i32, i32>, Vec<i32>, Vec<(i32, i32)>) {
    let ok: Vec<&str> = old.iter().map(|(_, k)| k.as_str()).collect();
    let nk: Vec<&str> = new.iter().map(|(_, k)| k.as_str()).collect();
    let mut map = HashMap::new();
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let after = |ni: usize| if ni == 0 { 0 } else { new[ni - 1].0 };
    for op in capture_diff_slices(Algorithm::Patience, &ok, &nk) {
        match op {
            DiffOp::Equal { old_index, new_index, len } => {
                for i in 0..len {
                    map.insert(old[old_index + i].0, new[new_index + i].0);
                }
            }
            DiffOp::Insert { new_index, new_len, .. } => added.extend((0..new_len).map(|i| new[new_index + i].0)),
            DiffOp::Delete { old_index, old_len, new_index } => {
                removed.extend((0..old_len).map(|i| (old[old_index + i].0, after(new_index))));
            }
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                removed.extend((0..old_len).map(|i| (old[old_index + i].0, after(new_index))));
                added.extend((0..new_len).map(|i| new[new_index + i].0));
            }
        }
    }
    (map, added, removed)
}

// ------------------------------------------------------- formula comparison

static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[^A-Za-z0-9_.$!'])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Z]{1,3})(\$?)([0-9]+)").unwrap()
});

/// Rewrite the cell references in an old formula through the row and column
/// alignment, so that a formula that only moved because rows were inserted
/// above it compares equal to its new text.
fn remap_formula(formula: &str, own_sheet: &str, alignments: &HashMap<&str, Alignment>) -> String {
    let mut out = String::with_capacity(formula.len());
    // Leave string literals alone.
    for (i, part) in formula.split('"').enumerate() {
        if i > 0 {
            out.push('"');
        }
        if i % 2 == 1 {
            out.push_str(part);
            continue;
        }
        let replaced = REFERENCE.replace_all(part, |caps: &regex::Captures| {
            let whole = caps.get(0).unwrap();
            // A function name such as LOG10( is not a reference.
            if part[whole.end()..].starts_with('(') {
                return whole.as_str().to_string();
            }
            let prefix = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let sheet_name = if prefix.is_empty() {
                own_sheet.to_string()
            } else {
                prefix.trim_end_matches('!').trim_matches('\'').replace("''", "'")
            };
            let Some(al) = alignments.get(sheet_name.as_str()) else { return whole.as_str().to_string() };
            let col = col_number(&caps[4]);
            let row: i32 = caps[6].parse().unwrap_or(0);
            let new_row = al.rows.get(&row).copied();
            let new_col = al.cols.get(&col).copied();
            match (new_row, new_col) {
                (Some(nr), Some(nc)) => {
                    format!("{}{}{}{}{}{}", &caps[1], prefix, &caps[3], col_letters(nc), &caps[5], nr)
                }
                _ => format!("{}{}#DELETED", &caps[1], prefix),
            }
        });
        out.push_str(&replaced);
    }
    out
}

fn col_number(letters: &str) -> i32 {
    letters.chars().fold(0, |acc, ch| acc * 26 + (ch as i32 - 'A' as i32 + 1))
}

pub fn col_letters(mut col: i32) -> String {
    let mut s = Vec::new();
    while col > 0 {
        let rem = ((col - 1) % 26) as u8;
        s.push((b'A' + rem) as char);
        col = (col - 1) / 26;
    }
    s.iter().rev().collect()
}
