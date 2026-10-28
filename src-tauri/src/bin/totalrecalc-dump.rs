//! Load workbooks and print what the window would receive, as JSON.
//!
//! `totalrecalc-dump model.xlsx` prints one version. `totalrecalc-dump old.xlsx new.xlsx`
//! prints the new version compared with the old one. The output is the
//! fixture format the frontend's browser mode reads.

use totalrecalc_lib::session::{self, Session, Shared};
use std::sync::{Arc, Mutex};

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() || paths.len() > 2 {
        eprintln!("usage: totalrecalc-dump <file.xlsx> [<newer.xlsx>]");
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
    let latest = *ids.last().unwrap();
    let compare = (ids.len() == 2).then(|| ids[0]);
    let info = session::book_info(&shared, latest, compare).unwrap();
    let sheets: Vec<_> = (0..info.sheets.len()).filter_map(|i| session::sheet_payload(&shared, latest, i, compare)).collect();
    println!("{}", serde_json::json!({ "info": info, "sheets": sheets }));
}
