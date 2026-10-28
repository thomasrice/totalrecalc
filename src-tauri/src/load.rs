//! Reading a workbook: bytes in, `Book` out. The calculation engine is
//! IronCalc; a few things it does not expose (outline levels) are read from
//! the package XML directly.

use crate::book::{Book, Calc, Cell, Edge, Sheet, SheetMeta, Style, Value};
use crate::package;
use crate::periods;
use crate::refs;
use anyhow::{Result, anyhow};
use ironcalc_base::Model;
use ironcalc_base::cell::CellValue;
use ironcalc_base::formatter::format::format_number;
use ironcalc_base::types::{BorderItem, BorderStyle, CellType, Color, HorizontalAlignment, Theme, VerticalAlignment};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Cursor, Read, Write};

/// Excel's default row height is 15pt; we draw rows a little taller for
/// legibility and scale custom heights by the same factor.
const DEFAULT_ROW_PX: f32 = 24.0;
const PX_PER_POINT: f32 = DEFAULT_ROW_PX / 15.0;

pub struct Loaded {
    pub model: Model<'static>,
    pub extras: package::Extras,
}

/// Parse a workbook. Does not recalculate.
pub fn parse(bytes: &[u8]) -> Result<Loaded> {
    let extras = package::read_extras(bytes).unwrap_or_default();
    let workbook = match ironcalc::import::load_from_xlsx_bytes(bytes, "workbook", "en", "UTC") {
        Ok(w) => w,
        Err(first) => {
            // Some writers produce valid packages IronCalc does not expect:
            // absolute relationship targets, or no sharedStrings part. Retry
            // with an in-memory copy normalised; the file itself is never touched.
            let normalised = normalise_package(bytes).map_err(|_| anyhow!("{first}"))?;
            ironcalc::import::load_from_xlsx_bytes(&normalised, "workbook", "en", "UTC").map_err(|e| anyhow!("{e}"))?
        }
    };
    let model = Model::from_workbook(workbook, "en").map_err(|e| anyhow!("{e}"))?;
    Ok(Loaded { model, extras })
}

fn normalise_package(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut has_sst = false;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i)?;
        let name = f.name()?.to_string();
        has_sst |= name == "xl/sharedStrings.xml";
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        if name.ends_with(".rels") && name.starts_with("xl/") {
            // Targets are relative to the folder above `_rels`.
            let relative = if name == "xl/_rels/workbook.xml.rels" { "" } else { "../" };
            let text = String::from_utf8_lossy(&buf).replace("Target=\"/xl/", &format!("Target=\"{relative}"));
            buf = text.into_bytes();
        }
        out.start_file(name, zip::write::SimpleFileOptions::default())?;
        out.write_all(&buf)?;
    }
    if !has_sst {
        out.start_file("xl/sharedStrings.xml", zip::write::SimpleFileOptions::default())?;
        out.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>"#,
        )?;
    }
    Ok(out.finish()?.into_inner())
}

/// Build a `Book` from the model's current values. `cached` holds the values
/// read from the file before recalculation; when given, the model has been
/// recalculated and each formula is checked against its cached value.
pub fn snapshot(loaded: &Loaded, cached: Option<&Book>) -> Book {
    let model = &loaded.model;
    let theme = &model.workbook.theme;
    let locale = ironcalc_base::locale::get_locale("en").expect("en locale");
    let mut styles: Vec<Style> = Vec::new();
    let mut style_ids: HashMap<i32, u32> = HashMap::new();
    let mut sheets = Vec::new();

    for (si, ws) in model.workbook.worksheets.iter().enumerate() {
        let si = si as u32;
        let comments: HashMap<(i32, i32), String> = ws
            .comments
            .iter()
            .filter_map(|c| parse_ref(&c.cell_ref).map(|rc| (rc, c.text.trim().to_string())))
            .collect();
        let extra = loaded.extras.sheets.get(&ws.name);
        let mut cells = BTreeMap::new();
        let (mut max_row, mut max_col) = (1, 1);
        for (r, c, _) in ws.sheet_data.cells() {
            let Ok(style_index) = model.get_cell_style_index(si, r, c) else { continue };
            let style_id = *style_ids.entry(style_index).or_insert_with(|| {
                let s = model.get_style_for_cell(si, r, c).map(|s| convert_style(&s, theme, loaded.extras.indents.get(style_index as usize).copied().unwrap_or(0))).unwrap_or_default();
                styles.push(s);
                (styles.len() - 1) as u32
            });
            let formula = model.get_cell_formula(si, r, c).ok().flatten();
            let valueless = formula.is_none() && extra.is_some_and(|x| x.valueless.contains(&(r, c)));
            let value = match model.get_cell_value_by_index(si, r, c) {
                _ if valueless => Value::Empty,
                Ok(CellValue::Number(n)) => Value::Number(n),
                Ok(CellValue::String(s)) => Value::Text(s),
                Ok(CellValue::Boolean(b)) => Value::Bool(b),
                _ => Value::Empty,
            };
            let error = matches!(model.get_cell_type(si, r, c), Ok(CellType::ErrorValue));
            let comment = comments.get(&(r, c)).cloned();
            let has_content = formula.is_some() || value != Value::Empty || comment.is_some();
            if !has_content && !draws_something(&styles[style_id as usize]) {
                continue;
            }
            let num_fmt = model.get_style_for_cell(si, r, c).map(|s| s.num_fmt).unwrap_or_default();
            let (text, format_color) = match &value {
                Value::Number(n) => format_value(*n, &num_fmt, locale),
                Value::Text(s) => (s.clone(), None),
                Value::Bool(b) => ((if *b { "TRUE" } else { "FALSE" }).to_string(), None),
                Value::Empty => (String::new(), None),
            };
            let mut cell = Cell { text, value, formula, style: style_id, calc: Calc::Ok, error, format_color, comment };
            if cached.is_none() && cell.formula.is_some() && cell.value == Value::Empty {
                cell.calc = Calc::Unavailable;
            }
            if has_content {
                max_row = max_row.max(r);
                max_col = max_col.max(c);
            }
            cells.insert((r, c), cell);
        }
        // Formatting that runs far beyond the content (whole-row fills, styled
        // columns to XFD) would make the sheet enormous; keep a small margin.
        let (keep_rows, keep_cols) = (max_row + 2, max_col + 2);
        cells.retain(|&(r, c), _| r <= keep_rows && c <= keep_cols);
        let merges: Vec<[i32; 4]> = ws
            .merged_cells
            .iter()
            .map(|m| [m.row, m.column, m.row + m.height - 1, m.column + m.width - 1])
            .collect();
        for m in &merges {
            max_row = max_row.max(m[2]);
            max_col = max_col.max(m[3]);
        }
        let mut col_widths = Vec::with_capacity(max_col as usize);
        let mut hidden_cols = Vec::new();
        for c in 1..=max_col {
            let w = model.get_column_width(si, c).unwrap_or(90.0);
            // IronCalc stores 9px per Excel width unit; Excel draws 7px per unit plus 5px padding.
            col_widths.push(((w / 9.0) * 7.0 + 5.0).round() as f32);
            if ws.cols.iter().any(|col| col.hidden && col.min <= c && c <= col.max) {
                hidden_cols.push(c);
            }
        }
        let mut row_heights = BTreeMap::new();
        let mut hidden_rows = Vec::new();
        for row in &ws.rows {
            if row.hidden {
                hidden_rows.push(row.r);
            }
            if row.custom_height && row.r <= max_row {
                // Stored in points, as in the file.
                let px = (row.height as f32 * PX_PER_POINT).round();
                if (px - DEFAULT_ROW_PX).abs() > 1.0 {
                    row_heights.insert(row.r, px.max(4.0));
                }
            }
        }

        let mut meta = SheetMeta {
            name: ws.name.clone(),
            hidden: !matches!(ws.state, ironcalc_base::types::SheetState::Visible),
            max_row,
            max_col,
            frozen_rows: ws.frozen_rows,
            frozen_cols: ws.frozen_columns,
            show_grid: ws.show_grid_lines,
            col_widths,
            hidden_cols,
            row_heights,
            hidden_rows,
            merges,
            col_outline: extra.map(|o| o.cols.clone()).unwrap_or_default(),
            row_outline: extra.map(|o| o.rows.clone()).unwrap_or_default(),
            ..Default::default()
        };
        let mut sheet = Sheet { meta: SheetMeta::default(), cells };
        periods::annotate(&mut meta, &sheet.cells);
        sheet.meta = meta;
        sheets.push(sheet);
    }
    let mut book = Book { sheets, styles, calculated: cached.is_some() };
    if let Some(cached) = cached {
        reconcile(&mut book, cached);
    }
    book
}

/// (sheet index, row, column)
type CellKey = (usize, i32, i32);

static UNFAITHFUL: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\b(INDIRECT|OFFSET|CELL|INFO)\s*\(|\[\d+\]").unwrap());

/// After recalculation, decide which formula cells must show the file's saved
/// result instead of the engine's. Only cells with an explicit reason qualify:
/// the engine produced an error where the file saved a value, or the formula
/// uses a construct the engine cannot evaluate faithfully (INDIRECT, OFFSET,
/// CELL, INFO, links to other workbooks). Every formula that depends on such a
/// cell inherits the doubt. Elsewhere the engine's value always wins, so an
/// edit can never be hidden behind a stale saved result.
fn reconcile(book: &mut Book, cached: &Book) {
    // Seeds.
    let mut doubtful: HashSet<CellKey> = HashSet::new();
    for (si, sheet) in book.sheets.iter().enumerate() {
        let saved = cached.sheet(&sheet.meta.name);
        for (&(r, c), cell) in &sheet.cells {
            let Some(f) = cell.formula.as_deref() else { continue };
            let saved_ok = saved.and_then(|x| x.cells.get(&(r, c))).is_some_and(|s| s.value != Value::Empty && !s.error);
            if (cell.error && saved_ok) || UNFAITHFUL.is_match(f) {
                doubtful.insert((si, r, c));
            }
        }
    }
    // Propagate to dependents, through references of modest size (a lookup
    // over a whole table is itself usually one of the seeds).
    if !doubtful.is_empty() {
        let names: HashMap<&str, usize> = book.sheets.iter().enumerate().map(|(i, s)| (s.meta.name.as_str(), i)).collect();
        let mut readers: HashMap<CellKey, Vec<CellKey>> = HashMap::new();
        for (si, sheet) in book.sheets.iter().enumerate() {
            for (&(r, c), cell) in &sheet.cells {
                let Some(f) = cell.formula.as_deref() else { continue };
                for rg in refs::ranges(f, &sheet.meta.name) {
                    let Some(&ti) = names.get(rg.sheet.as_str()) else { continue };
                    if (rg.r2 - rg.r1 + 1) as i64 * (rg.c2 - rg.c1 + 1) as i64 > 4096 {
                        continue;
                    }
                    for rr in rg.r1..=rg.r2 {
                        for cc in rg.c1..=rg.c2 {
                            readers.entry((ti, rr, cc)).or_default().push((si, r, c));
                        }
                    }
                }
            }
        }
        let mut queue: Vec<_> = doubtful.iter().copied().collect();
        while let Some(k) = queue.pop() {
            for &d in readers.get(&k).map(|v| v.as_slice()).unwrap_or(&[]) {
                if doubtful.insert(d) {
                    queue.push(d);
                }
            }
        }
    }
    for (si, sheet) in book.sheets.iter_mut().enumerate() {
        let saved = cached.sheet(&sheet.meta.name);
        for (&(r, c), cell) in sheet.cells.iter_mut() {
            if cell.formula.is_none() {
                continue;
            }
            // A formula broken in the file itself (`=Sheet!#REF!`) is a #REF! error, as in Excel.
            if cell.error && cell.formula.as_deref().is_some_and(|f| f.contains("#REF!")) {
                cell.text = "#REF!".into();
                cell.value = Value::Text("#REF!".into());
                continue;
            }
            if !doubtful.contains(&(si, r, c)) {
                continue;
            }
            match saved.and_then(|x| x.cells.get(&(r, c))).filter(|s| s.value != Value::Empty) {
                Some(s) if !(same(&s.value, &cell.value) && s.error == cell.error) => {
                    cell.text = s.text.clone();
                    cell.value = s.value.clone();
                    cell.format_color = s.format_color.clone();
                    cell.calc = Calc::Cached;
                    cell.error = s.error;
                }
                Some(_) => {}
                None if cell.error => cell.calc = Calc::Unavailable,
                None => {}
            }
        }
    }
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0),
        _ => a == b,
    }
}

static LOCALE_TAG: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"\[\$([^\]-]*)-[0-9A-Fa-f]+\]").unwrap());

/// Format a number with the cell's format. Excel locale tags such as
/// `[$-409]` or `[$€-407]` are reduced to their currency symbol, which the
/// formatter understands; a format it still cannot handle falls back to General.
fn format_value(n: f64, num_fmt: &str, locale: &ironcalc_base::locale::Locale) -> (String, Option<String>) {
    let fmt = if num_fmt.contains("[$") {
        LOCALE_TAG
            .replace_all(num_fmt, |c: &regex::Captures| if c[1].is_empty() { String::new() } else { format!("\"{}\"", &c[1]) })
            .into_owned()
    } else {
        num_fmt.to_string()
    };
    let f = format_number(n, &fmt, locale);
    if f.error.is_some() || f.text.starts_with('#') {
        return (format_number(n, "General", locale).text, None);
    }
    (f.text, f.color.and_then(format_color))
}

/// An empty cell is worth sending only if its fill or borders are visible.
fn draws_something(style: &Style) -> bool {
    style.fill.is_some() || style.top.is_some() || style.right.is_some() || style.bottom.is_some() || style.left.is_some()
}

fn format_color(index: i32) -> Option<String> {
    // Index into IronCalc's format colour list: black, white, red, green, blue, yellow, magenta.
    let hex = match index {
        0 => "#000000",
        1 => "#FFFFFF",
        2 => "#FF0000",
        3 => "#008000",
        4 => "#0000FF",
        5 => "#FFFF00",
        6 => "#FF00FF",
        _ => return None,
    };
    Some(hex.to_string())
}

fn rgb(color: &Color, theme: &Theme) -> Option<String> {
    let s = color.to_rgb(theme);
    if s.is_empty() {
        return None;
    }
    // Normalise "#AARRGGBB" / "AARRGGBB" / "RRGGBB" to "#rrggbb".
    let hex = s.trim_start_matches('#');
    let hex = if hex.len() == 8 { &hex[2..] } else { hex };
    (hex.len() == 6).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

fn edge(item: &Option<BorderItem>, theme: &Theme) -> Option<Edge> {
    let item = item.as_ref()?;
    let style = match item.style {
        BorderStyle::Thin => "thin",
        BorderStyle::Medium => "medium",
        BorderStyle::Thick => "thick",
        BorderStyle::Double => "double",
        BorderStyle::Dotted => "dotted",
        BorderStyle::SlantDashDot | BorderStyle::MediumDashDot | BorderStyle::MediumDashDotDot | BorderStyle::MediumDashed => "dashed",
    };
    Some(Edge { style: style.to_string(), color: rgb(&item.color, theme).unwrap_or_else(|| "#000000".to_string()) })
}

fn convert_style(s: &ironcalc_base::types::Style, theme: &Theme, indent: u32) -> Style {
    let (align, valign, wrap) = match &s.alignment {
        Some(a) => (
            match a.horizontal {
                HorizontalAlignment::Left => "left",
                HorizontalAlignment::Center | HorizontalAlignment::CenterContinuous => "center",
                HorizontalAlignment::Right => "right",
                _ => "general",
            },
            match a.vertical {
                VerticalAlignment::Top => "top",
                VerticalAlignment::Center => "center",
                _ => "bottom",
            },
            a.wrap_text,
        ),
        None => ("general", "bottom", false),
    };
    Style {
        bold: s.font.b,
        italic: s.font.i,
        underline: s.font.u,
        strike: s.font.strike,
        size: s.font.sz as f32,
        color: rgb(&s.font.color, theme),
        fill: rgb(&s.fill.color, theme),
        align: align.to_string(),
        valign: valign.to_string(),
        indent,
        wrap,
        top: edge(&s.border.top, theme),
        right: edge(&s.border.right, theme),
        bottom: edge(&s.border.bottom, theme),
        left: edge(&s.border.left, theme),
        percent: s.num_fmt.contains('%'),
    }
}

/// "B12" → (12, 2)
pub fn parse_ref(r: &str) -> Option<(i32, i32)> {
    let r = r.replace('$', "");
    let split = r.find(|ch: char| ch.is_ascii_digit())?;
    let (letters, digits) = r.split_at(split);
    if letters.is_empty() {
        return None;
    }
    let mut col = 0i32;
    for ch in letters.chars() {
        if !ch.is_ascii_alphabetic() {
            return None;
        }
        col = col * 26 + (ch.to_ascii_uppercase() as i32 - 'A' as i32 + 1);
    }
    Some((digits.parse().ok()?, col))
}
