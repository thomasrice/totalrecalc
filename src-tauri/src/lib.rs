mod book;
mod diff;
mod formula;
mod load;
mod package;
mod periods;
mod refs;
pub mod session;

use session::{BookInfo, Notice, Session, Shared, SheetPayload};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

/// The file open in the window, and the flag that stops its watcher.
#[derive(Default)]
struct Open {
    session: Option<Shared>,
    stop: Option<Arc<AtomicBool>>,
}

type AppState = Mutex<Open>;

/// Every opened file gets a session number; events carry it so the window can
/// ignore anything still arriving from a file it has closed.
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

fn current(state: &State<AppState>) -> Result<Shared, String> {
    state.lock().unwrap().session.clone().ok_or_else(|| "No file is open".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    session: u64,
    /// The canonical path, the stable key for remembered per-file state.
    path: String,
}

#[tauri::command]
fn open_file(path: String, app: tauri::AppHandle, state: State<AppState>) -> Result<Opened, String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(format!("{} does not exist", path.display()));
    }
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let shared: Shared = Arc::new(Mutex::new(Session::new(path.clone())));
    let stop = Arc::new(AtomicBool::new(false));
    let session = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
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
    session::watch(shared, path.clone(), stop, move |notice| match notice {
        Notice::Version { id, calculated } => {
            let _ = handle.emit("version", serde_json::json!({ "session": session, "id": id, "calculated": calculated }));
        }
        Notice::Watch(w) => {
            let _ = handle.emit("watch", serde_json::json!({ "session": session, "watch": w }));
        }
    });
    Ok(Opened { session, path: path.to_string_lossy().into_owned() })
}

#[tauri::command]
async fn book_info(version: u64, compare: Option<u64>, state: State<'_, AppState>) -> Result<BookInfo, String> {
    let shared = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || session::book_info(&shared, version, compare))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That version is no longer available".to_string())
}

#[tauri::command]
async fn sheet(version: u64, index: usize, compare: Option<u64>, state: State<'_, AppState>) -> Result<SheetPayload, String> {
    let shared = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || session::sheet_payload(&shared, version, index, compare))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That sheet is no longer available".to_string())
}

#[tauri::command]
async fn sheet_changes(version: u64, index: usize, compare: u64, state: State<'_, AppState>) -> Result<Option<diff::SheetDiff>, String> {
    let shared = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || session::sheet_changes(&shared, version, index, compare))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn inspect(version: u64, index: usize, r: i32, c: i32, state: State<'_, AppState>) -> Result<refs::Inspection, String> {
    let shared = current(&state)?;
    let book = shared.lock().unwrap().version(version).map(|v| v.book.clone()).ok_or("That version is no longer available")?;
    tauri::async_runtime::spawn_blocking(move || refs::inspect(&book, index, r, c)).await.map_err(|e| e.to_string())
}

/// Versions the window still needs (shown, baseline, undo) are kept however
/// many newer versions arrive.
#[tauri::command]
fn pin_versions(ids: Vec<u64>, state: State<AppState>) -> Result<(), String> {
    current(&state)?.lock().unwrap().set_pins(&ids);
    Ok(())
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
        .invoke_handler(tauri::generate_handler![open_file, book_info, sheet, sheet_changes, inspect, pin_versions, initial_path])
        .run(tauri::generate_context!())
        .expect("error while running Cellwake");
}
