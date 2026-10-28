//! Details read straight from the .xlsx package that the calculation engine
//! does not keep: cell indentation, and cells written without a value.

use anyhow::Result;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};

#[derive(Default, Debug, Clone)]
pub struct SheetExtras {
    /// Cells written as `<c t="n"></c>`: no value and no formula. Excel shows
    /// them blank; IronCalc reads them as 0.
    pub valueless: HashSet<(i32, i32)>,
}

#[derive(Default, Debug, Clone)]
pub struct Extras {
    /// Per-sheet details, by sheet name.
    pub sheets: HashMap<String, SheetExtras>,
    /// Indent level for each `cellXfs` entry, in file order.
    pub indents: Vec<u32>,
}

type Archive<'a> = zip::ZipArchive<Cursor<&'a [u8]>>;

fn read_part(archive: &mut Archive, name: &str) -> Option<Vec<u8>> {
    let mut f = archive.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn attr(e: &BytesStart, key: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key || a.key.local_name().as_ref() == key)
        .and_then(|a| a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok().map(|v| v.into_owned()))
}

pub fn read_extras(bytes: &[u8]) -> Result<Extras> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut extras = Extras::default();
    if let Some(styles) = read_part(&mut archive, "xl/styles.xml") {
        extras.indents = read_indents(&styles);
    }
    let (Some(workbook), Some(rels)) = (read_part(&mut archive, "xl/workbook.xml"), read_part(&mut archive, "xl/_rels/workbook.xml.rels"))
    else {
        return Ok(extras);
    };
    let targets = read_rels(&rels);
    for (name, rid) in read_sheets(&workbook) {
        let Some(target) = targets.get(&rid) else { continue };
        let path = if let Some(abs) = target.strip_prefix('/') { abs.to_string() } else { format!("xl/{target}") };
        if let Some(xml) = read_part(&mut archive, &path) {
            extras.sheets.insert(name, read_sheet(&xml));
        }
    }
    Ok(extras)
}

fn read_indents(xml: &[u8]) -> Vec<u32> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut in_cell_xfs = false;
    let mut indents = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.local_name().as_ref() == "cellXfs" => in_cell_xfs = true,
            Ok(Event::End(e)) if e.local_name().as_ref() == "cellXfs" => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if in_cell_xfs => match e.local_name().as_ref() {
                "xf" => indents.push(0),
                "alignment" => {
                    if let (Some(last), Some(i)) = (indents.last_mut(), attr(&e, "indent")) {
                        *last = i.parse().unwrap_or(0);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    indents
}

fn read_rels(xml: &[u8]) -> HashMap<String, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out = HashMap::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == "Relationship" => {
                if let (Some(id), Some(t)) = (attr(&e, "Id"), attr(&e, "Target")) {
                    out.insert(id, t);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn read_sheets(xml: &[u8]) -> Vec<(String, String)> {
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == "sheet" => {
                if let (Some(name), Some(id)) = (attr(&e, "name"), attr(&e, "id")) {
                    out.push((name, id));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn read_sheet(xml: &[u8]) -> SheetExtras {
    // Malformed XML ends the scan early; the engine reports real damage.
    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut out = SheetExtras::default();
    // The open `<c>` element and whether it has had a value child yet.
    let mut open_cell: Option<((i32, i32), bool)> = None;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "c" => open_cell = attr(&e, "r").and_then(|r| crate::load::parse_ref(&r)).map(|rc| (rc, false)),
                "v" | "f" | "is" => {
                    if let Some((_, has)) = open_cell.as_mut() {
                        *has = true;
                    }
                }
                _ => {}
            },
            // A self-closing <f/> (shared formula) also means the cell has content.
            Ok(Event::Empty(e)) if e.local_name().as_ref() == "f" => {
                if let Some((_, has)) = open_cell.as_mut() {
                    *has = true;
                }
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == "c" => {
                if let Some((rc, false)) = open_cell.take() {
                    out.valueless.insert(rc);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}
