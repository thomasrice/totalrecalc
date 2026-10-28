//! Cell references inside formula text: found once, here, for both the diff
//! (which rewrites them through a row alignment) and the inspector (which
//! follows them).

use regex::Regex;
use std::sync::LazyLock;

/// One end of a reference. A whole-column reference has no row; a whole-row
/// reference has no column.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct End {
    pub col: Option<i32>,
    pub row: Option<i32>,
    pub col_abs: bool,
    pub row_abs: bool,
}

impl End {
    pub fn text(&self) -> String {
        let mut s = String::new();
        if let Some(c) = self.col {
            if self.col_abs {
                s.push('$');
            }
            s.push_str(&col_letters(c));
        }
        if let Some(r) = self.row {
            if self.row_abs {
                s.push('$');
            }
            s.push_str(&r.to_string());
        }
        s
    }
}

#[derive(Clone, Debug)]
pub struct Reference {
    /// Byte span of the reference in the formula, including any sheet prefix.
    pub start: usize,
    pub end: usize,
    /// The sheet named in the reference, if any (unquoted).
    pub sheet: Option<String>,
    /// The prefix exactly as written, e.g. `'Income Statement'!`.
    pub prefix: String,
    pub from: End,
    pub to: Option<End>,
}

static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?:^|[^A-Za-z0-9_.$!'])",
        r"(?P<sheet>(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?",
        r"(?:",
        r"(?P<a>\$?[A-Z]{1,3}\$?[0-9]+)(?::(?P<b>\$?[A-Z]{1,3}\$?[0-9]+))?",
        r"|(?P<ca>\$?[A-Z]{1,3}):(?P<cb>\$?[A-Z]{1,3})",
        r"|(?P<ra>\$?[0-9]+):(?P<rb>\$?[0-9]+)",
        r")",
    ))
    .unwrap()
});

fn end(s: &str) -> End {
    let b = s.as_bytes();
    let mut i = 0;
    let col_abs = b.first() == Some(&b'$');
    if col_abs {
        i += 1;
    }
    let letters_start = i;
    while i < b.len() && b[i].is_ascii_alphabetic() {
        i += 1;
    }
    let col = (i > letters_start).then(|| col_number(&s[letters_start..i]));
    let row_abs = b.get(i) == Some(&b'$');
    if row_abs {
        i += 1;
    }
    let row = s[i..].parse().ok();
    // A bare `$3` (whole-row) carries its `$` on the row.
    if col.is_none() {
        return End { col: None, row, col_abs: false, row_abs: col_abs || row_abs };
    }
    End { col, row, col_abs, row_abs }
}

/// Every cell reference in a formula, outside string literals.
pub fn references(formula: &str) -> Vec<Reference> {
    let mut out = Vec::new();
    let mut offset = 0;
    for (i, part) in formula.split('"').enumerate() {
        if i % 2 == 0 {
            for caps in REFERENCE.captures_iter(part) {
                let whole = caps.get(0).unwrap();
                let body = caps.name("a").or(caps.name("ca")).or(caps.name("ra")).unwrap();
                let start = caps.name("sheet").map(|m| m.start()).unwrap_or(body.start());
                let after = &part[whole.end()..];
                // A function name such as LOG10( is not a reference; nor is A1B.
                if after.starts_with('(') || after.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
                    continue;
                }
                let prefix = caps.name("sheet").map(|m| m.as_str().to_string()).unwrap_or_default();
                let sheet = (!prefix.is_empty()).then(|| prefix.trim_end_matches('!').trim_matches('\'').replace("''", "'"));
                let (from, to) = if let Some(a) = caps.name("a") {
                    (end(a.as_str()), caps.name("b").map(|b| end(b.as_str())))
                } else if let (Some(a), Some(b)) = (caps.name("ca"), caps.name("cb")) {
                    (end(a.as_str()), Some(end(b.as_str())))
                } else {
                    (end(&caps["ra"]), Some(end(&caps["rb"])))
                };
                out.push(Reference { start: offset + start, end: offset + whole.end(), sheet, prefix, from, to });
            }
        }
        offset += part.len() + 1;
    }
    out
}

/// Rewrite each reference with `f`, which returns replacement text (the whole
/// reference including any prefix) or `None` to keep it.
pub fn rewrite(formula: &str, mut f: impl FnMut(&Reference) -> Option<String>) -> String {
    let mut out = String::with_capacity(formula.len());
    let mut last = 0;
    for r in references(formula) {
        if let Some(text) = f(&r) {
            out.push_str(&formula[last..r.start]);
            out.push_str(&text);
            last = r.end;
        }
    }
    out.push_str(&formula[last..]);
    out
}

pub fn col_number(letters: &str) -> i32 {
    letters.chars().fold(0, |acc, ch| acc * 26 + (ch.to_ascii_uppercase() as i32 - 'A' as i32 + 1))
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
