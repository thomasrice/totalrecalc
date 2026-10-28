//! One open file: its versions, the watcher that produces them, and the
//! payloads the window asks for.

use crate::book::{Book, Calc, CalcSummary, Cell, SheetMeta, Style, Value};
use crate::diff::{self, Diff, SheetDiff};
use crate::load;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const KEEP_VERSIONS: usize = 30;
const SETTLE: Duration = Duration::from_millis(500);
const POLL: Duration = Duration::from_millis(1000);
const REPORT_FAILURE_AFTER: Duration = Duration::from_secs(5);

pub struct Version {
    pub id: u64,
    /// Milliseconds since the epoch when the version was read.
    pub at: u64,
    pub book: Arc<Book>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    /// `loading`, `watching`, `writing`, `error`, `calculating`
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// When the problem started (ms since epoch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

#[derive(Default)]
pub struct Session {
    pub path: PathBuf,
    pub versions: VecDeque<Version>,
    pub watch: WatchState,
    diffs: HashMap<(u64, u64), Arc<Diff>>,
    next_id: u64,
}

pub type Shared = Arc<Mutex<Session>>;

/// Something the session tells the window.
pub enum Notice {
    Version { id: u64, calculated: bool },
    Watch(WatchState),
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Session {
    pub fn new(path: PathBuf) -> Self {
        Session { path, ..Default::default() }
    }

    fn push(&mut self, book: Book) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.versions.push_back(Version { id, at: now_ms(), book: Arc::new(book) });
        while self.versions.len() > KEEP_VERSIONS {
            self.versions.pop_front();
        }
        id
    }

    fn replace(&mut self, id: u64, book: Book) {
        if let Some(v) = self.versions.iter_mut().find(|v| v.id == id) {
            v.book = Arc::new(book);
        }
        self.diffs.retain(|(a, b), _| *a != id && *b != id);
    }

    pub fn version(&self, id: u64) -> Option<&Version> {
        self.versions.iter().find(|v| v.id == id)
    }

    pub fn diff(&mut self, from: u64, to: u64) -> Option<Arc<Diff>> {
        if from == to {
            return None;
        }
        if let Some(d) = self.diffs.get(&(from, to)) {
            return Some(d.clone());
        }
        let d = Arc::new(diff::diff(&self.version(from)?.book, &self.version(to)?.book));
        self.diffs.insert((from, to), d.clone());
        Some(d)
    }
}

// ------------------------------------------------------------------ payloads

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub id: u64,
    pub at: u64,
    pub calculated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSummary {
    pub name: String,
    pub hidden: bool,
    pub edits: usize,
    pub results: usize,
    pub structure: usize,
    pub new_sheet: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookInfo {
    pub path: String,
    pub file_name: String,
    pub folder: String,
    pub version: u64,
    pub versions: Vec<VersionInfo>,
    pub sheets: Vec<SheetSummary>,
    pub styles: Vec<Style>,
    pub calc: CalcSummary,
    pub watch: WatchState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compare: Option<u64>,
    pub edits: usize,
    pub results: usize,
    pub rows_added: usize,
    pub rows_removed: usize,
    pub removed_sheets: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPayload {
    pub meta: SheetMeta,
    /// Compact cells: `[row, col, text, value, style, flags, formula, formatColor, comment]`.
    /// `flags`: bit 0 error; bits 1-2 calculation (0 ok, 1 cached, 2 unavailable).
    pub cells: Vec<WireCell>,
    pub diff: SheetDiff,
}

pub fn book_info(session: &mut Session, version: u64, compare: Option<u64>) -> Option<BookInfo> {
    let v = session.version(version)?;
    let book = v.book.clone();
    let d = compare.and_then(|c| session.diff(c, version));
    let path = session.path.clone();
    Some(BookInfo {
        file_name: path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        folder: path.parent().map(short_folder).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        version,
        versions: session
            .versions
            .iter()
            .map(|v| VersionInfo { id: v.id, at: v.at, calculated: v.book.calculated })
            .collect(),
        sheets: book
            .sheets
            .iter()
            .map(|s| {
                let sd = d.as_ref().and_then(|d| d.sheets.get(&s.meta.name));
                SheetSummary {
                    name: s.meta.name.clone(),
                    hidden: s.meta.hidden,
                    edits: sd.map(|x| x.edits).unwrap_or(0),
                    results: sd.map(|x| x.results).unwrap_or(0),
                    structure: sd.map(|x| x.added_rows.len() + x.removed_rows.len()).unwrap_or(0),
                    new_sheet: sd.is_some_and(|x| x.new_sheet),
                }
            })
            .collect(),
        styles: book.styles.clone(),
        calc: book.calc_summary(),
        watch: session.watch.clone(),
        compare: compare.filter(|c| *c != version),
        edits: d.as_ref().map(|d| d.edits).unwrap_or(0),
        results: d.as_ref().map(|d| d.results).unwrap_or(0),
        rows_added: d.as_ref().map(|d| d.rows_added).unwrap_or(0),
        rows_removed: d.as_ref().map(|d| d.rows_removed).unwrap_or(0),
        removed_sheets: d.as_ref().map(|d| d.removed_sheets.clone()).unwrap_or_default(),
    })
}

pub fn sheet_payload(session: &mut Session, version: u64, sheet: usize, compare: Option<u64>) -> Option<SheetPayload> {
    let book = session.version(version)?.book.clone();
    let s = book.sheets.get(sheet)?;
    let diff = compare
        .and_then(|c| session.diff(c, version))
        .and_then(|d| d.sheets.get(&s.meta.name).cloned())
        .unwrap_or_default();
    Some(SheetPayload {
        meta: s.meta.clone(),
        cells: s.cells.iter().map(|((r, c), cell)| wire(*r, *c, cell)).collect(),
        diff,
    })
}

pub type WireCell = (i32, i32, String, Value, u32, u8, Option<String>, Option<String>, Option<String>);

fn wire(r: i32, c: i32, cell: &Cell) -> WireCell {
    let calc = match cell.calc {
        Calc::Ok => 0,
        Calc::Cached => 1,
        Calc::Unavailable => 2,
    };
    (
        r,
        c,
        cell.text.clone(),
        cell.value.clone(),
        cell.style,
        u8::from(cell.error) | (calc << 1),
        cell.formula.clone(),
        cell.format_color.clone(),
        cell.comment.clone(),
    )
}

fn short_folder(p: &Path) -> String {
    let parts: Vec<String> = p.components().rev().take(2).map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

// ------------------------------------------------------------------- watcher

#[derive(PartialEq, Clone, Copy)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> Option<Stamp> {
    let m = std::fs::metadata(path).ok()?;
    Some(Stamp { len: m.len(), modified: m.modified().ok() })
}

fn hash(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Read, parse and record one version, then recalculate it. Returns the
/// content hash on success.
fn ingest(shared: &Shared, path: &Path, notify: &dyn Fn(Notice)) -> Result<u64, String> {
    // std opens files with read, write and delete sharing on Windows, so a
    // writer can always replace the file while we read it.
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read the file: {e}"))?;
    zip::ZipArchive::new(std::io::Cursor::new(&bytes[..])).map_err(|_| "The file is not a complete workbook yet".to_string())?;
    let mut loaded = load::parse(&bytes).map_err(|e| format!("Not a readable workbook: {e}"))?;
    let cached = load::snapshot(&loaded, None);
    let calculating = WatchState { state: "calculating".into(), ..Default::default() };
    let id = {
        let mut s = shared.lock().unwrap();
        s.watch = calculating.clone();
        s.push(cached.clone())
    };
    notify(Notice::Watch(calculating));
    notify(Notice::Version { id, calculated: false });
    loaded.model.evaluate();
    let calculated = load::snapshot(&loaded, Some(&cached));
    let watching = WatchState { state: "watching".into(), ..Default::default() };
    {
        let mut s = shared.lock().unwrap();
        s.replace(id, calculated);
        s.watch = watching.clone();
    }
    notify(Notice::Watch(watching));
    notify(Notice::Version { id, calculated: true });
    Ok(hash(&bytes))
}

/// Watch `path` until `stop` is set, recording each new version.
pub fn watch(shared: Shared, path: PathBuf, stop: Arc<AtomicBool>, notify: impl Fn(Notice) + Send + 'static) {
    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let mut watcher = notify::recommended_watcher(move |_res| {
            let _ = tx.send(());
        })
        .ok();
        if let (Some(w), Some(dir)) = (watcher.as_mut(), path.parent()) {
            use notify::Watcher;
            let _ = w.watch(if dir.as_os_str().is_empty() { Path::new(".") } else { dir }, notify::RecursiveMode::NonRecursive);
        }

        let mut last_hash = None;
        let mut last_stamp = None;
        let mut failing_since: Option<Instant> = None;
        let mut failing_wall: Option<u64> = None;
        let mut pending = true; // load once at start

        while !stop.load(Ordering::Relaxed) {
            if !pending {
                match rx.recv_timeout(POLL) {
                    Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => std::thread::sleep(POLL),
                }
                while rx.try_recv().is_ok() {}
                let st = stamp(&path);
                if st != last_stamp || failing_since.is_some() {
                    pending = true;
                }
            }
            if !pending {
                continue;
            }
            // Wait for the file to settle: same size and time across the settle window.
            let mut st = stamp(&path);
            loop {
                std::thread::sleep(SETTLE);
                let again = stamp(&path);
                if again == st {
                    break;
                }
                st = again;
                if failing_since.is_none() {
                    set_watch(&shared, &notify, "writing", None, None);
                }
            }
            last_stamp = st;
            let result = if st.is_none() {
                Err("The file is missing (it may be being replaced)".to_string())
            } else {
                std::fs::read(&path)
                    .map_err(|e| format!("Cannot read the file: {e}"))
                    .and_then(|bytes| {
                        let h = hash(&bytes);
                        if Some(h) == last_hash { Ok(None) } else { Ok(Some(h)) }
                    })
                    .and_then(|changed| match changed {
                        None => Ok(last_hash.unwrap()),
                        Some(_) => ingest(&shared, &path, &notify),
                    })
            };
            match result {
                Ok(h) => {
                    last_hash = Some(h);
                    if failing_since.take().is_some() || shared.lock().unwrap().watch.state != "watching" {
                        failing_wall = None;
                        set_watch(&shared, &notify, "watching", None, None);
                    }
                    pending = false;
                }
                Err(message) => {
                    let started = *failing_since.get_or_insert_with(Instant::now);
                    let wall = *failing_wall.get_or_insert_with(now_ms);
                    let has_version = !shared.lock().unwrap().versions.is_empty();
                    if started.elapsed() >= REPORT_FAILURE_AFTER || !has_version {
                        set_watch(&shared, &notify, "error", Some(message), Some(wall));
                    } else {
                        set_watch(&shared, &notify, "writing", None, None);
                    }
                    // Retry on the next poll.
                    pending = false;
                }
            }
        }
    });
}

fn set_watch(shared: &Shared, notify: &dyn Fn(Notice), state: &str, message: Option<String>, since: Option<u64>) {
    let w = WatchState { state: state.into(), message, since };
    {
        let mut s = shared.lock().unwrap();
        if s.watch.state == w.state && s.watch.message == w.message {
            return;
        }
        s.watch = w.clone();
    }
    notify(Notice::Watch(w));
}

/// Load a file once, synchronously, fully calculated (for `cellwake-dump`).
pub fn load_once(shared: &Shared, path: &Path) -> Result<u64, String> {
    shared.lock().unwrap().path = path.to_path_buf();
    ingest(shared, path, &|_| {})?;
    Ok(shared.lock().unwrap().versions.back().map(|v| v.id).unwrap_or(0))
}
