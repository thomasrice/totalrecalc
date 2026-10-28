//! Formula references: what a cell reads (inputs) and what reads it (used by).

use crate::book::Book;
use crate::formula::{self, col_letters};
use serde::Serialize;

const MAX_LISTED: usize = 60;
const MAX_ROW: i32 = 1_048_576;
const MAX_COL: i32 = 16_384;

#[derive(Clone, Debug)]
pub struct Range {
    pub sheet: String,
    pub r1: i32,
    pub c1: i32,
    pub r2: i32,
    pub c2: i32,
}

impl Range {
    fn contains(&self, sheet: &str, r: i32, c: i32) -> bool {
        self.sheet == sheet && (self.r1..=self.r2).contains(&r) && (self.c1..=self.c2).contains(&c)
    }
}

/// Every cell range a formula refers to. Whole columns and rows span the sheet.
pub fn ranges(formula: &str, own_sheet: &str) -> Vec<Range> {
    formula::references(formula)
        .into_iter()
        .map(|r| {
            let to = r.to.unwrap_or(r.from);
            let (c1, c2) = (r.from.col.unwrap_or(1), to.col.unwrap_or(MAX_COL));
            let (r1, r2) = (r.from.row.unwrap_or(1), to.row.unwrap_or(MAX_ROW));
            Range {
                sheet: r.sheet.unwrap_or_else(|| own_sheet.to_string()),
                r1: r1.min(r2),
                c1: c1.min(c2),
                r2: r1.max(r2),
                c2: c1.max(c2),
            }
        })
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    pub sheet: String,
    pub sheet_index: usize,
    pub r: i32,
    pub c: i32,
    pub address: String,
    pub label: String,
    pub header: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub more: Option<usize>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub inputs: Vec<RefInfo>,
    pub used_by: Vec<RefInfo>,
}

fn info(book: &Book, sheet_index: usize, r: i32, c: i32) -> RefInfo {
    let sheet = &book.sheets[sheet_index];
    RefInfo {
        sheet: sheet.meta.name.clone(),
        sheet_index,
        r,
        c,
        address: format!("{}{}", col_letters(c), r),
        label: sheet.row_label(r),
        header: sheet.col_header(c),
        text: sheet.cells.get(&(r, c)).map(|cell| cell.text.clone()).unwrap_or_default(),
        more: None,
    }
}

pub fn inspect(book: &Book, sheet_index: usize, r: i32, c: i32) -> Inspection {
    let Some(sheet) = book.sheets.get(sheet_index) else { return Inspection::default() };
    let name = sheet.meta.name.as_str();
    let mut out = Inspection::default();

    if let Some(formula) = sheet.cells.get(&(r, c)).and_then(|cell| cell.formula.as_deref()) {
        for range in ranges(formula, name) {
            let Some(si) = book.sheets.iter().position(|s| s.meta.name == range.sheet) else { continue };
            let total = ((range.r2 - range.r1 + 1) as i64 * (range.c2 - range.c1 + 1) as i64) as usize;
            let mut listed = 0;
            'cells: for rr in range.r1..=range.r2 {
                for cc in range.c1..=range.c2 {
                    if out.inputs.len() >= MAX_LISTED || listed >= 12 {
                        break 'cells;
                    }
                    out.inputs.push(info(book, si, rr, cc));
                    listed += 1;
                }
            }
            if total > listed
                && let Some(last) = out.inputs.last_mut()
            {
                last.more = Some(total - listed);
            }
        }
    }

    'scan: for (si, s) in book.sheets.iter().enumerate() {
        for (&(rr, cc), cell) in &s.cells {
            let Some(f) = cell.formula.as_deref() else { continue };
            if ranges(f, &s.meta.name).iter().any(|rg| rg.contains(name, r, c)) {
                out.used_by.push(info(book, si, rr, cc));
                if out.used_by.len() >= MAX_LISTED {
                    break 'scan;
                }
            }
        }
    }
    out
}
