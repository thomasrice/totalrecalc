mod book;
mod diff;
mod load;
mod package;
mod periods;
mod refs;
pub mod session;

use session::{BookInfo, Notice, Session, Shared, SheetPayload};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

/// The file open in the window, and the flag that stops its watcher.
#[derive(Default)]
struct Open {
    session: Option<Shared>,
    stop: Option<Arc<AtomicBool>>,
}

type AppState = Mutex<Open>;

fn current(state: &State<AppState>) -> Result<Shared, String> {
    state.lock().unwrap().session.clone().ok_or_else(|| "No file is open".to_string())
}

#[tauri::command]
fn open_file(path: String, app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let path = PathBuf::from(path);
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let shared: Shared = Arc::new(Mutex::new(Session::new(path.clone())));
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut open = state.lock().unwrap();
        if let Some(old) = open.stop.take() {
            old.store(true, Ordering::Relaxed);
        }
        open.session = Some(shared.clone());
        open.stop = Some(stop.clone());
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&format!("{name} — Cellwake"));
    }
    let handle = app.clone();
    session::watch(shared, path, stop, move |notice| match notice {
        Notice::Version { id, calculated } => {
            let _ = handle.emit("version", serde_json::json!({ "id": id, "calculated": calculated }));
        }
        Notice::Watch(w) => {
            let _ = handle.emit("watch", w);
        }
    });
    Ok(())
}

#[tauri::command]
fn book_info(version: u64, compare: Option<u64>, state: State<AppState>) -> Result<BookInfo, String> {
    let shared = current(&state)?;
    let mut s = shared.lock().unwrap();
    session::book_info(&mut s, version, compare).ok_or_else(|| "That version is no longer available".to_string())
}

#[tauri::command]
fn sheet(version: u64, index: usize, compare: Option<u64>, state: State<AppState>) -> Result<SheetPayload, String> {
    let shared = current(&state)?;
    let mut s = shared.lock().unwrap();
    session::sheet_payload(&mut s, version, index, compare).ok_or_else(|| "That sheet is no longer available".to_string())
}

#[tauri::command]
fn inspect(version: u64, index: usize, r: i32, c: i32, state: State<AppState>) -> Result<refs::Inspection, String> {
    let shared = current(&state)?;
    let book = shared.lock().unwrap().version(version).map(|v| v.book.clone()).ok_or("That version is no longer available")?;
    Ok(refs::inspect(&book, index, r, c))
}

#[tauri::command]
fn latest_version(state: State<AppState>) -> Option<u64> {
    let shared = state.lock().unwrap().session.clone()?;
    let s = shared.lock().unwrap();
    s.versions.back().map(|v| v.id)
}

/// The path given on the command line, if any.
#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-'))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![open_file, book_info, sheet, inspect, latest_version, initial_path])
        .run(tauri::generate_context!())
        .expect("error while running Cellwake");
}
