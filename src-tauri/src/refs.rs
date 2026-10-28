//! Formula references: what a cell reads (inputs) and what reads it (used by).

use crate::book::Book;
use crate::diff::col_letters;
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

static RANGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:^|[^A-Za-z0-9_.$!'])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?([A-Z]{1,3})\$?([0-9]+)(?::\$?([A-Z]{1,3})\$?([0-9]+))?",
    )
    .unwrap()
});

const MAX_LISTED: usize = 60;

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

fn col_number(letters: &str) -> i32 {
    letters.chars().fold(0, |acc, ch| acc * 26 + (ch as i32 - 'A' as i32 + 1))
}

/// Every cell range a formula refers to, outside string literals.
pub fn ranges(formula: &str, own_sheet: &str) -> Vec<Range> {
    let mut out = Vec::new();
    for (i, part) in formula.split('"').enumerate() {
        if i % 2 == 1 {
            continue;
        }
        for caps in RANGE.captures_iter(part) {
            let whole = caps.get(0).unwrap();
            if part[whole.end()..].starts_with('(') {
                continue; // a function name such as LOG10(
            }
            let sheet = caps
                .get(1)
                .map(|m| m.as_str().trim_end_matches('!').trim_matches('\'').replace("''", "'"))
                .unwrap_or_else(|| own_sheet.to_string());
            let (c1, r1) = (col_number(&caps[2]), caps[3].parse().unwrap_or(0));
            let (c2, r2) = match (caps.get(4), caps.get(5)) {
                (Some(c), Some(r)) => (col_number(c.as_str()), r.as_str().parse().unwrap_or(r1)),
                _ => (c1, r1),
            };
            out.push(Range { sheet, r1: r1.min(r2), c1: c1.min(c2), r2: r1.max(r2), c2: c1.max(c2) });
        }
    }
    out
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
            let total = ((range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)) as usize;
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
            // Cheap filter before parsing: the formula must mention the column letters.
            if !f.contains(&col_letters(c)) {
                continue;
            }
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
