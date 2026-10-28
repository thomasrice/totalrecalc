//! The workbook as Total Recalc sees it: plain owned data, independent of the
//! calculation engine, so versions can be kept, diffed and sent to the UI.

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Value {
    Number(f64),
    Text(String),
    Bool(bool),
    Empty,
}

/// Relative tolerance below which two numbers count as the same value.
const SAME_NUMBER: f64 = 1e-9;

impl Value {
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    /// Equal, treating numbers that differ only by floating-point noise as equal.
    pub fn same(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Number(x), Value::Number(y)) => (x - y).abs() <= SAME_NUMBER * x.abs().max(y.abs()).max(1.0),
            _ => self == other,
        }
    }
}

/// How trustworthy a displayed value is.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Calc {
    /// A constant, or a formula the engine calculated.
    Ok,
    /// The engine could not calculate it; the value saved in the file is shown.
    Cached,
    /// Neither a calculation nor a saved value is available.
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
pub struct Cell {
    /// Display text after number formatting.
    pub text: String,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    pub style: u32,
    pub calc: Calc,
    pub error: bool,
    /// Colour imposed by the number format (e.g. `[Red]`), as `#rrggbb`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    /// `thin`, `medium`, `thick`, `double`, `dashed` or `dotted`.
    pub style: String,
    pub color: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    /// Font size in points.
    pub size: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    /// `left`, `center`, `right`, or `general` (numbers right, text left).
    pub align: String,
    pub valign: String,
    pub indent: u32,
    pub wrap: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<Edge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<Edge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom: Option<Edge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<Edge>,
    pub percent: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub year: i32,
    /// 1-4 for quarters, 0 for a full year.
    pub quarter: u8,
    /// Actual (`A`), estimate (`E`) or unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<char>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SheetMeta {
    pub name: String,
    pub hidden: bool,
    pub max_row: i32,
    pub max_col: i32,
    pub frozen_rows: i32,
    pub frozen_cols: i32,
    pub frozen_inferred: bool,
    pub show_grid: bool,
    /// Pixel widths for columns 1..=max_col (index 0 is column 1).
    pub col_widths: Vec<f32>,
    pub hidden_cols: Vec<i32>,
    /// Pixel heights for rows that differ from the default.
    pub row_heights: BTreeMap<i32, f32>,
    pub hidden_rows: Vec<i32>,
    /// `[first_row, first_col, last_row, last_col]`
    pub merges: Vec<[i32; 4]>,
    /// The row whose cells name the periods, if one was found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_row: Option<i32>,
    /// Period for each column 1..=max_col (index 0 is column 1).
    pub periods: Vec<Option<Period>>,
    /// Columns that hold row labels (1..=label_cols).
    pub label_cols: i32,
}

#[derive(Clone, Debug)]
pub struct Sheet {
    pub meta: SheetMeta,
    pub cells: BTreeMap<(i32, i32), Cell>,
}

impl Sheet {
    /// The label of a row: the first non-empty text in the label columns.
    pub fn row_label(&self, row: i32) -> String {
        for c in 1..=self.meta.label_cols.max(1) {
            if let Some(cell) = self.cells.get(&(row, c)) {
                let t = cell.text.trim();
                if !t.is_empty() && cell.value.as_number().is_none() {
                    return t.to_string();
                }
            }
        }
        String::new()
    }

    /// The header text of a column, from the header row.
    pub fn col_header(&self, col: i32) -> String {
        self.meta.header_row.and_then(|r| self.cells.get(&(r, col))).map(|c| c.text.trim().to_string()).unwrap_or_default()
    }
}

#[derive(Clone, Debug)]
pub struct Book {
    pub sheets: Vec<Sheet>,
    pub styles: Vec<Style>,
    /// True once every formula has been through the calculation engine.
    pub calculated: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CalcSummary {
    pub calculated: bool,
    pub cached: usize,
    pub unavailable: usize,
    pub errors: usize,
}

impl Book {
    pub fn calc_summary(&self) -> CalcSummary {
        let mut s = CalcSummary { calculated: self.calculated, ..Default::default() };
        for sheet in &self.sheets {
            for cell in sheet.cells.values() {
                match cell.calc {
                    Calc::Cached => s.cached += 1,
                    Calc::Unavailable => s.unavailable += 1,
                    Calc::Ok => {}
                }
                if cell.error {
                    s.errors += 1;
                }
            }
        }
        s
    }

    pub fn sheet(&self, name: &str) -> Option<&Sheet> {
        self.sheets.iter().find(|s| s.meta.name == name)
    }
}
