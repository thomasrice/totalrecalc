//! Finding the structure of a model sheet: which row names the periods, which
//! columns hold row labels, and what period each column covers.

use crate::book::{Cell, Period, SheetMeta, Value};
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;

static QUARTER: LazyLock<Regex> = LazyLock::new(|| {
    // 1Q25, 1Q2025, 1Q25A, Q1 25, Q1-2025, Q1'25, 1QFY25E
    Regex::new(r"(?i)^(?:([1-4])q\s*(?:fy|cy)?'?(\d{2}|\d{4})|q([1-4])[\s\-']*(?:fy|cy)?'?(\d{2}|\d{4}))\s*([aef])?$").unwrap()
});
static YEAR: LazyLock<Regex> = LazyLock::new(|| {
    // FY2025, FY25E, CY2025, 2025, 2025A, 2025E, FY Dec-25
    Regex::new(r"(?i)^(?:(?:fy|cy)\s*'?(\d{2}|\d{4})|(\d{4}))\s*([aef])?$").unwrap()
});

fn year(s: &str) -> i32 {
    let y: i32 = s.parse().unwrap_or(0);
    if s.len() == 2 { 2000 + y } else { y }
}

pub fn parse_period(text: &str) -> Option<Period> {
    let t = text.trim();
    if let Some(c) = QUARTER.captures(t) {
        let (q, y) = match (c.get(1), c.get(2), c.get(3), c.get(4)) {
            (Some(q), Some(y), _, _) | (_, _, Some(q), Some(y)) => (q.as_str(), y.as_str()),
            _ => return None,
        };
        let kind = c.get(5).map(|k| k.as_str().to_ascii_uppercase().chars().next().unwrap());
        return Some(Period { year: year(y), quarter: q.parse().ok()?, kind });
    }
    if let Some(c) = YEAR.captures(t) {
        let y = c.get(1).or(c.get(2))?.as_str();
        let y = year(y);
        if !(1950..=2150).contains(&y) {
            return None;
        }
        let kind = c.get(3).map(|k| k.as_str().to_ascii_uppercase().chars().next().unwrap());
        return Some(Period { year: y, quarter: 0, kind });
    }
    None
}

/// Fill in header row, periods, label columns and (when the file has none)
/// an inferred freeze.
pub fn annotate(meta: &mut SheetMeta, cells: &BTreeMap<(i32, i32), Cell>) {
    let scan_to = if meta.frozen_rows > 0 { meta.frozen_rows.max(1) } else { 15 }.min(meta.max_row);
    let mut best: Option<(i32, usize)> = None;
    for r in 1..=scan_to {
        let n = (1..=meta.max_col)
            .filter(|c| cells.get(&(r, *c)).is_some_and(is_period_text))
            .count();
        if n >= 3 && best.is_none_or(|(_, m)| n > m) {
            best = Some((r, n));
        }
    }
    meta.header_row = best.map(|(r, _)| r);
    meta.periods = (1..=meta.max_col)
        .map(|c| {
            meta.header_row
                .and_then(|r| cells.get(&(r, c)))
                .filter(|cell| is_period_text(cell))
                .and_then(|cell| parse_period(&period_text(cell)))
        })
        .collect();

    // Label columns: up to the first period column, else the frozen columns,
    // else the leading columns that are mostly text.
    let first_period = meta.periods.iter().position(|p| p.is_some()).map(|i| i as i32 + 1);
    meta.label_cols = match first_period {
        Some(c) => (c - 1).max(1),
        None if meta.frozen_cols > 0 => meta.frozen_cols,
        None => leading_text_cols(meta, cells),
    }
    .min(4);

    if meta.frozen_rows == 0
        && meta.frozen_cols == 0
        && let Some(h) = meta.header_row
    {
        meta.frozen_rows = h;
        meta.frozen_cols = meta.label_cols;
        meta.frozen_inferred = true;
    }
}

fn period_text(cell: &Cell) -> String {
    match &cell.value {
        // A bare number like 2025 in a header row.
        Value::Number(n) if n.fract() == 0.0 => format!("{}", *n as i64),
        _ => cell.text.clone(),
    }
}

fn is_period_text(cell: &Cell) -> bool {
    parse_period(&period_text(cell)).is_some()
}

fn leading_text_cols(meta: &SheetMeta, cells: &BTreeMap<(i32, i32), Cell>) -> i32 {
    let mut cols = 1;
    for c in 1..=meta.max_col.min(4) {
        let (mut text, mut num) = (0, 0);
        for r in 1..=meta.max_row.min(200) {
            match cells.get(&(r, c)).map(|cell| &cell.value) {
                Some(Value::Text(t)) if !t.trim().is_empty() => text += 1,
                Some(Value::Number(_)) => num += 1,
                _ => {}
            }
        }
        if text > num && text > 0 {
            cols = c;
        } else {
            break;
        }
    }
    cols
}
