//! Load workbooks and print what the window would receive, as JSON.
//!
//! `totalrecalc-dump v1.xlsx [v2.xlsx …]` treats each file as the next
//! version of one workbook and prints every version's sheets, plus the
//! comparisons the window asks for: each version against the first and
//! against the one before it. This is the fixture format the frontend's
//! browser mode reads (see fixtures/README.md).

use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use totalrecalc_lib::session::{self, Session, Shared};

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: totalrecalc-dump <file.xlsx> [<newer.xlsx> …]");
        std::process::exit(2);
    }
    let shared: Shared = Arc::new(Mutex::new(Session::default()));
    let mut ids = Vec::new();
    for p in &paths {
        let started = std::time::Instant::now();
        match session::load_once(&shared, std::path::Path::new(p)) {
            Ok(id) => ids.push(id),
            Err(e) => {
                eprintln!("{p}: {e}");
                std::process::exit(1);
            }
        }
        eprintln!("{p}: loaded and calculated in {:?}", started.elapsed());
    }

    let versions: Vec<Value> = ids
        .iter()
        .map(|&id| {
            let info = session::book_info(&shared, id, None).expect("version just loaded");
            let sheets: Vec<Value> = (0..info.sheets.len())
                .filter_map(|i| session::sheet_payload(&shared, id, i, None))
                .map(|p| json!({ "meta": p.meta, "cells": p.cells }))
                .collect();
            json!({ "id": id, "info": info, "sheets": sheets })
        })
        .collect();

    let mut comparisons = serde_json::Map::new();
    for (n, &id) in ids.iter().enumerate().skip(1) {
        let mut against = vec![ids[0], ids[n - 1]];
        against.dedup();
        for from in against {
            let info = session::book_info(&shared, id, Some(from)).expect("both versions held");
            let diffs: Vec<Value> = (0..info.sheets.len())
                .map(|i| session::sheet_changes(&shared, id, i, from).map(|d| json!(d)).unwrap_or(Value::Null))
                .collect();
            comparisons.insert(format!("{id}:{from}"), json!({ "info": info, "diffs": diffs }));
        }
    }
    println!("{}", json!({ "versions": versions, "comparisons": comparisons }));
}
